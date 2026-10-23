/**
 * Prometheus text exposition (format 0.0.4), hand-rolled so the board and the driver ship no metrics
 * dependency. `driver/src/prometheus.ts` is a byte-for-byte copy (the driver imports nothing from the
 * server; `server/test/prometheus.test.ts` pins the two together). Label values are the caller's
 * bounded vocabulary — never an org, repo, job, lease, pod or user id (docs/telemetry.md).
 */

const MS_PER_SECOND = 1000;

export const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export type Labels = Readonly<Record<string, string>>;
export type Outcome = 'ok' | 'error';

export interface Counter {
    inc(labels?: Labels, by?: number): void;
}

export interface Histogram {
    observe(seconds: number, labels?: Labels): void;
}

/** One gauge family read at scrape time. */
export interface GaugeFamily {
    readonly name: string;
    readonly help: string;
    readonly samples: readonly { readonly labels: Labels; readonly value: number }[];
}

export interface Registry {
    counter(name: string, help: string, labelNames?: readonly string[]): Counter;
    histogram(name: string, help: string, labelNames: readonly string[], buckets: readonly number[]): Histogram;
    /**
     * Gauges read per scrape. A read that throws, or outlives the registry's deadline (its `signal`
     * aborts then), omits its samples — never a zero — and counts a failure under `source`.
     */
    collect(source: string, read: (signal: AbortSignal) => Promise<readonly GaugeFamily[]>): void;
    render(): Promise<string>;
}

interface Family {
    render(): string[];
}

const escapeHelp = (text: string): string => text.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
const escapeValue = (text: string): string => escapeHelp(text).replaceAll('"', '\\"');

function format(name: string, labels: Labels, value: number): string {
    const pairs = Object.entries(labels).map(([key, v]) => `${key}="${escapeValue(v)}"`);
    return `${name}${pairs.length > 0 ? `{${pairs.join(',')}}` : ''} ${value}`;
}

const header = (name: string, help: string, type: string): string[] => [
    `# HELP ${name} ${escapeHelp(help)}`,
    `# TYPE ${name} ${type}`,
];

/** A series keyed by its label values in declaration order; throws on a label set that does not match. */
function seriesKey(names: readonly string[], labels: Labels = {}): string {
    const given = Object.keys(labels);
    if (given.length !== names.length || names.some((n) => !(n in labels))) {
        throw new Error(`labels {${given.join(',')}} do not match declared {${names.join(',')}}`);
    }
    return JSON.stringify(names.map((n) => labels[n]));
}

const labelsOf = (names: readonly string[], key: string): Labels =>
    Object.fromEntries((JSON.parse(key) as string[]).map((v, i) => [names[i]!, v]));

function counterFamily(name: string, help: string, names: readonly string[]): Family & Counter {
    const series = new Map<string, number>();
    return {
        inc(labels, by = 1) {
            const key = seriesKey(names, labels);
            series.set(key, (series.get(key) ?? 0) + by);
        },
        render: () => [
            ...header(name, help, 'counter'),
            ...[...series.entries()].sort().map(([key, value]) => format(name, labelsOf(names, key), value)),
        ],
    };
}

interface Bins {
    counts: number[];
    sum: number;
    count: number;
}

function histogramLines(name: string, labels: Labels, buckets: readonly number[], bins: Bins): string[] {
    let cumulative = 0;
    const lines = buckets.map((le, i) => {
        cumulative += bins.counts[i]!;
        return format(`${name}_bucket`, { ...labels, le: String(le) }, cumulative);
    });
    return [
        ...lines,
        format(`${name}_bucket`, { ...labels, le: '+Inf' }, bins.count),
        format(`${name}_sum`, labels, bins.sum),
        format(`${name}_count`, labels, bins.count),
    ];
}

function histogramFamily(
    name: string,
    help: string,
    names: readonly string[],
    buckets: readonly number[]
): Family & Histogram {
    const series = new Map<string, Bins>();
    return {
        observe(seconds, labels) {
            const key = seriesKey(names, labels);
            const bins = series.get(key) ?? { counts: buckets.map(() => 0), sum: 0, count: 0 };
            const slot = buckets.findIndex((le) => seconds <= le);
            if (slot >= 0) bins.counts[slot]!++;
            bins.sum += seconds;
            bins.count++;
            series.set(key, bins);
        },
        render: () => [
            ...header(name, help, 'histogram'),
            ...[...series.entries()]
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .flatMap(([key, bins]) => histogramLines(name, labelsOf(names, key), buckets, bins)),
        ],
    };
}

function gaugeLines(family: GaugeFamily): string[] {
    const samples = family.samples.map((s) => format(family.name, s.labels, s.value)).sort();
    return [...header(family.name, family.help, 'gauge'), ...samples];
}

const DEFAULT_READ_DEADLINE_MS = 2000;

/** `read` raced against a deadline that also aborts its signal, so a read stuck on a connection is let go. */
async function readWithin<T>(read: (signal: AbortSignal) => Promise<T>, deadlineMs: number): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`the read outlived its ${deadlineMs} ms deadline`));
        }, deadlineMs);
    });
    try {
        return await Promise.race([read(controller.signal), expired]);
    } finally {
        clearTimeout(timer);
    }
}

export function createRegistry(options: { failures?: string; readDeadlineMs?: number } = {}): Registry {
    const families: Family[] = [];
    const sources: { source: string; read: (signal: AbortSignal) => Promise<readonly GaugeFamily[]> }[] = [];
    const failures = counterFamily(
        options.failures ?? 'metrics_read_failures_total',
        'Scrape-time reads that failed; their samples are omitted, never reported as zero.',
        ['source']
    );
    const add = <T extends Family>(family: T): T => {
        families.push(family);
        return family;
    };
    return {
        counter: (name, help, labelNames = []) => add(counterFamily(name, help, labelNames)),
        histogram: (name, help, labelNames, buckets) => add(histogramFamily(name, help, labelNames, buckets)),
        collect(source, read) {
            // The failure counter exists only once something can fail.
            if (sources.length === 0) families.push(failures);
            sources.push({ source, read });
        },
        async render() {
            const gauges: string[] = [];
            for (const { source, read } of sources) {
                try {
                    for (const family of await readWithin(read, options.readDeadlineMs ?? DEFAULT_READ_DEADLINE_MS))
                        gauges.push(...gaugeLines(family));
                } catch {
                    failures.inc({ source });
                }
            }
            const lines = [...families.flatMap((f) => f.render()), ...gauges];
            return `${lines.join('\n')}\n`;
        },
    };
}

/**
 * Runs `fn` and observes its duration exactly once, in `finally`, then returns or rethrows. `labels`
 * is a fixed set, or a function of the outcome for a histogram that carries an `outcome` label.
 */
export async function timed<T>(
    histogram: Histogram,
    labels: Labels | ((outcome: Outcome) => Labels),
    fn: () => Promise<T>
): Promise<T> {
    const start = performance.now();
    let outcome: Outcome = 'error';
    try {
        const value = await fn();
        outcome = 'ok';
        return value;
    } finally {
        const seconds = (performance.now() - start) / MS_PER_SECOND;
        histogram.observe(seconds, typeof labels === 'function' ? labels(outcome) : labels);
    }
}

/** Seconds elapsed since `start` (a `performance.now()` reading). */
export const secondsSince = (start: number): number => (performance.now() - start) / MS_PER_SECOND;

/** Histogram bounds written as one readable string: `buckets('0.1 0.5 1')`. */
export const buckets = (spec: string): number[] => spec.split(' ').map(Number);
