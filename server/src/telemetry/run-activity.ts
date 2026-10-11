/**
 * The per-run activity reduction (issue #339): the `metric_point` rows of ONE session, bucketed
 * over the run's wall clock into token and edit figures a small chart can draw. A flat line means
 * stuck; a steady bar means working — the "was the run making progress" answer, read off data the
 * ingest already holds.
 *
 * The reduction lives here rather than in SQL for the same reason the week bucketing lives in
 * core (docs/metrics.md): the temporality-aware rule is the one correctness hazard in the feature,
 * and it is unit-testable only as plain code. A delta counter SUMS into its bucket; a cumulative
 * counter must be differenced per series — `sum(value)` over a cumulative series produces a
 * plausible, wildly wrong number (002_views.repeatable.sql's header, and test-db covers both
 * shapes).
 */

/** One raw `metric_point_used` row, as the SQL read lifts it. */
export interface ActivityPoint {
    field: string;
    temporality: string;
    /** The cumulative counter's series start; null on a delta point. */
    startTime: string | null;
    attrs: Record<string, string>;
    metric: string;
    agent: string;
    value: number;
    time: string;
}

/** The four token types the executors report, kept apart — one total would hide the cache split. */
export interface TokenTypes {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
}

/** One bucket of the run's wall clock: tokens processed by type, and edit decisions made inside it. */
export interface ActivityBucket {
    start: string;
    tokens: TokenTypes;
    edits: number;
}

/** What one charted field adds to: a token type, or the edit count. */
type Slot = keyof TokenTypes | 'edits';

/** The bucket-width ladder, narrow to wide. */
const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 300_000;
const FIFTEEN_MINUTES_MS = 900_000;
const THIRTY_MINUTES_MS = 1_800_000;
const HOUR_MS = 3_600_000;
const LADDER_MS = [MINUTE_MS, FIVE_MINUTES_MS, FIFTEEN_MINUTES_MS, THIRTY_MINUTES_MS, HOUR_MS] as const;
/** The chart's bar budget: beyond ~16 bars a run-activity chart renders hairlines, not shapes. */
const MAX_BUCKETS = 16;

/** Smallest ladder width giving at most `MAX_BUCKETS` bars over the run; the hour beyond it. */
export function pickBucketMs(runMs: number): number {
    for (const width of LADDER_MS) {
        if (Math.ceil(runMs / width) <= MAX_BUCKETS) return width;
    }
    return LADDER_MS[LADDER_MS.length - 1]!;
}

/** The fields this reduction charts, and the bucket slot each one adds to. */
const SLOT_OF_FIELD: Readonly<Record<string, Slot>> = {
    tokens_input: 'input',
    tokens_output: 'output',
    tokens_cacheRead: 'cacheRead',
    tokens_cacheCreation: 'cacheCreation',
    edits_accept: 'edits',
    edits_reject: 'edits',
};

/** A cumulative series is keyed by everything that distinguishes one counter from another. */
const seriesKeyOf = (point: ActivityPoint): string =>
    [point.agent, point.metric, point.field, point.startTime ?? '', JSON.stringify(point.attrs)].join('|');

const emptyTokens = (): TokenTypes => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });

function addTo(bucket: ActivityBucket, slot: Slot, value: number): void {
    if (slot === 'edits') bucket.edits += value;
    else bucket.tokens[slot] += value;
}

/** One cumulative series parked for pass two: its bucket maxes, and the total it had reached at `from`. */
interface Series {
    slot: Slot;
    maxes: (number | null)[];
    baseline: number;
}

/**
 * Folds one parked cumulative series into the buckets as consecutive differences — the running
 * total's increment within each bucket, from the total the series had already reached when the
 * window opened (a follow-up run shares its session's counters, so its first reading is not its
 * own). A counter reset inside one series would difference negative; clamped to 0, which
 * undercounts rather than inverts a bar.
 */
function foldCumulative(series: Series, buckets: ActivityBucket[], count: number): void {
    let previous = series.baseline;
    for (let i = 0; i < count; i += 1) {
        const value = series.maxes[i] ?? null;
        if (value === null) continue;
        addTo(buckets[i]!, series.slot, Math.max(0, value - previous));
        previous = value;
    }
}

/** One cumulative point's parking slot: which series map, and which bucket slot it feeds. */
interface ParkTarget {
    cumulative: Map<string, Series>;
    point: ActivityPoint;
    slot: Slot;
    /** The point's bucket; null when it predates the window and only sets the baseline. */
    index: number | null;
    count: number;
}

/**
 * Parks one cumulative point's value as its series' bucket max — the series keyed by everything
 * that distinguishes one counter from another — for pass two's differencing. A point before the
 * window raises the series' baseline instead.
 */
function parkCumulative(target: ParkTarget): void {
    const key = seriesKeyOf(target.point);
    const series = target.cumulative.get(key) ?? {
        slot: target.slot,
        maxes: Array.from({ length: target.count }, () => null),
        baseline: 0,
    };
    if (target.index === null) {
        series.baseline = Math.max(series.baseline, target.point.value);
    } else {
        const current = series.maxes[target.index] ?? null;
        series.maxes[target.index] = current === null ? target.point.value : Math.max(current, target.point.value);
    }
    target.cumulative.set(key, series);
}

/**
 * Pass one over the points: deltas sum straight into their bucket; cumulatives park their max
 * per bucket, per series, for pass two's differencing. Out-of-window delta points and
 * unchartable fields fall out here; a cumulative point before the window sets its baseline.
 */
function parkPoints(
    points: readonly ActivityPoint[],
    buckets: ActivityBucket[],
    window: { fromMs: number; toMs: number; count: number; bucketMs: number }
): Map<string, Series> {
    const cumulative = new Map<string, Series>();
    for (const point of points) {
        const timeMs = Date.parse(point.time);
        const slot = SLOT_OF_FIELD[point.field];
        if (!Number.isFinite(timeMs) || timeMs > window.toMs || slot === undefined) continue;
        const before = timeMs < window.fromMs;
        if (point.temporality === 'cumulative') {
            const index = before ? null : bucketIndexOf(timeMs, window.fromMs, window.bucketMs, window.count);
            parkCumulative({ cumulative, point, slot, index, count: window.count });
        } else if (!before) {
            addTo(buckets[bucketIndexOf(timeMs, window.fromMs, window.bucketMs, window.count)]!, slot, point.value);
        }
    }
    return cumulative;
}

/** The bucket a timestamp lands in, clamped into the seeded range. */
function bucketIndexOf(timeMs: number, fromMs: number, bucketMs: number, count: number): number {
    const index = Math.floor((timeMs - fromMs) / bucketMs);
    return Math.min(Math.max(index, 0), count - 1);
}

/**
 * Buckets the points over `[from, to]` at `bucketMs`, seeding every bucket in the window — a
 * quiet stretch renders as a quiet stretch, never a gap. Delta points sum into the bucket that
 * contains them; cumulative points are reduced per series (max per bucket, then consecutive
 * differences against the total the series had reached before `from`, 0 for a fresh series), with
 * a negative difference clamped to 0 rather than allowed to invert a bar. Delta points outside
 * the window, and fields this reduction does not chart, fall out.
 */
export function bucketizeActivity(
    points: readonly ActivityPoint[],
    opts: { from: string; to: string; bucketMs: number }
): ActivityBucket[] {
    const fromMs = Date.parse(opts.from);
    const toMs = Date.parse(opts.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || opts.bucketMs <= 0) return [];
    const count = Math.max(1, Math.ceil((toMs - fromMs) / opts.bucketMs));
    const buckets: ActivityBucket[] = Array.from({ length: count }, (_, i) => ({
        start: new Date(fromMs + i * opts.bucketMs).toISOString(),
        tokens: emptyTokens(),
        edits: 0,
    }));
    const cumulative = parkPoints(points, buckets, { fromMs, toMs, count, bucketMs: opts.bucketMs });
    // Pass two: difference each cumulative series down the buckets and fold that in like a delta.
    for (const series of cumulative.values()) foldCumulative(series, buckets, count);
    return buckets;
}

/** The run's token totals by type, summed over its buckets. */
export function totalTokens(buckets: readonly ActivityBucket[]): TokenTypes {
    const total = emptyTokens();
    for (const bucket of buckets) {
        total.input += bucket.tokens.input;
        total.output += bucket.tokens.output;
        total.cacheRead += bucket.tokens.cacheRead;
        total.cacheCreation += bucket.tokens.cacheCreation;
    }
    return total;
}
