/**
 * Reads the metric names behind a dashboard or an alert rule and translates a declared instrument to its Prometheus
 * name. Byte-identical to its twin in the other package (`server/test/helpers-promql.ts` and
 * `driver/test/helpers-promql.ts`): the driver imports nothing from another package, so the file is copied, never shared.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataPointType, type MetricData } from '@opentelemetry/sdk-metrics';
import { parse } from 'yaml';

const OBSERVABILITY = fileURLToPath(new URL('../../observability', import.meta.url));

/** The Prometheus series an instrument exports: `.` to `_`, the unit suffix, then the kind's own suffix. */
export function prometheusNames(metric: MetricData): string[] {
    const { name, unit } = metric.descriptor;
    if (unit !== '' && unit !== 's') throw new Error(`${name}: unit "${unit}" has no known Prometheus translation`);
    const base = name.replaceAll('.', '_') + (unit === 's' ? '_seconds' : '');
    switch (metric.dataPointType) {
        case DataPointType.HISTOGRAM:
            return [`${base}_bucket`, `${base}_sum`, `${base}_count`];
        case DataPointType.SUM:
            return [metric.isMonotonic ? `${base}_total` : base];
        case DataPointType.GAUGE:
            return [base];
        default:
            throw new Error(`${name}: exponential histograms have no classic Prometheus translation`);
    }
}

const KEYWORDS = new Set([
    'by',
    'without',
    'on',
    'ignoring',
    'group_left',
    'group_right',
    'bool',
    'offset',
    'and',
    'or',
    'unless',
    'inf',
    'nan',
]);

/** The metric names a PromQL expression selects, in order of appearance, without functions, labels or keywords. */
export function metricNamesIn(expr: string): string[] {
    const bare = expr
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/\$\{\w+\}|\$+\w+/g, '')
        .replace(/\{[^}]*\}/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, '');
    const names: string[] = [];
    for (const match of bare.matchAll(/[A-Za-z_:][\w:]*/g)) {
        const rest = bare.slice(match.index + match[0].length);
        if (/^\s*\(/.test(rest) || KEYWORDS.has(match[0])) continue;
        names.push(match[0]);
    }
    return names;
}

const LABEL_VALUES = /^label_values\((.*),\s*\w+\)$/s;

function* exprsOf(node: unknown): Generator<string> {
    if (Array.isArray(node)) for (const item of node) yield* exprsOf(item);
    else if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            if (key === 'expr' && typeof value === 'string') yield value;
            else yield* exprsOf(value);
        }
    }
}

function templatingQuery(query: unknown): string {
    const text = typeof query === 'string' ? query : (query as { query?: unknown } | null)?.query;
    const selector = typeof text === 'string' ? LABEL_VALUES.exec(text.trim())?.[1] : undefined;
    if (selector === undefined) throw new Error(`templating query is not label_values(<selector>, <label>): ${text}`);
    return selector;
}

const filesIn = (dir: string, accept: (name: string) => boolean): string[] =>
    readdirSync(join(OBSERVABILITY, dir))
        .filter(accept)
        .sort()
        .map((name) => join(dir, name));

/** Every query of every dashboard and alert rule, with the file it came from (relative to `observability/`). */
export function queriesIn(root: string = OBSERVABILITY): { file: string; expr: string }[] {
    const out: { file: string; expr: string }[] = [];
    for (const file of filesIn('dashboards', (n) => n.endsWith('.json'))) {
        const dashboard = JSON.parse(readFileSync(join(root, file), 'utf8')) as {
            templating?: { list?: { query?: unknown }[] };
        };
        for (const expr of exprsOf(dashboard)) out.push({ file, expr });
        for (const variable of dashboard.templating?.list ?? []) {
            out.push({ file, expr: templatingQuery(variable.query) });
        }
    }
    for (const file of filesIn('alerts', (n) => n.endsWith('.yaml') && !n.endsWith('.test.yaml'))) {
        const doc = parse(readFileSync(join(root, file), 'utf8')) as {
            groups?: { rules?: { expr?: string }[] }[];
        };
        for (const group of doc.groups ?? []) {
            for (const rule of group.rules ?? []) if (rule.expr !== undefined) out.push({ file, expr: rule.expr });
        }
    }
    return out;
}

/** The metric name of every input series in the promtool rule tests. */
export function seriesNamesIn(root: string = OBSERVABILITY): string[] {
    const names: string[] = [];
    for (const file of filesIn('alerts', (n) => n.endsWith('.test.yaml'))) {
        const doc = parse(readFileSync(join(root, file), 'utf8')) as {
            tests?: { input_series?: { series: string }[] }[];
        };
        for (const test of doc.tests ?? []) {
            for (const input of test.input_series ?? []) names.push(input.series.split('{')[0]!.trim());
        }
    }
    return names;
}
