import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { metricsHarness, recordEveryBoardInstrument } from './helpers-metrics.js';
import { metricNamesIn, prometheusNames, queriesIn } from './helpers-promql.js';

const ROOT = fileURLToPath(new URL('../../observability', import.meta.url));
const DRIVER_PREFIX = 'bellows_driver_';
/** Series another component exports: the ops collector's self-metrics and the resource-attributes info series. */
const EXTERNAL = /^otelcol_|^target_info$/;

async function declaredBoardNames(): Promise<Set<string>> {
    const harness = metricsHarness();
    await recordEveryBoardInstrument(harness.meter, { db: true });
    return new Set((await harness.collect()).flatMap(prometheusNames));
}

const undeclared = (queries: { file: string; expr: string }[], declared: Set<string>): string[] =>
    queries.flatMap(({ file, expr }) =>
        metricNamesIn(expr)
            .filter((name) => !name.startsWith(DRIVER_PREFIX) && !EXTERNAL.test(name) && !declared.has(name))
            .map((name) => `${file}: ${name}`)
    );

const DASHBOARDS = ['board-red', 'claims-admission', 'db', 'driver', 'tasks'].map((s) => `${s}.json`);
const RULES = ['board.yaml', 'collector.yaml', 'driver.yaml'];

describe('the board instruments under the Prometheus translation', () => {
    it('translates every board instrument', async () => {
        const declared = await declaredBoardNames();
        for (const name of [
            'http_server_request_duration_seconds_bucket',
            'bellows_claim_lock_wait_seconds_count',
            'bellows_job_interruptions_total',
            'bellows_admission_running_max',
            'db_client_operation_duration_seconds_bucket',
        ]) {
            expect(declared, name).toContain(name);
        }
    });

    it('names a renamed instrument', async () => {
        const found = undeclared(
            [{ file: 'inline', expr: 'rate(bellows_claim_lockwait_seconds_bucket[5m])' }],
            await declaredBoardNames()
        );
        expect(found).toEqual(['inline: bellows_claim_lockwait_seconds_bucket']);
    });
});

describe('the dashboards and alert rules', () => {
    it('reads every dashboard and rule', () => {
        const queries = queriesIn();
        expect(readdirSync(`${ROOT}/dashboards`).sort()).toEqual(DASHBOARDS);
        expect(readdirSync(`${ROOT}/alerts`).sort()).toEqual([...RULES, 'driver.test.yaml'].sort());
        for (const file of [...DASHBOARDS.map((f) => `dashboards/${f}`), ...RULES.map((f) => `alerts/${f}`)]) {
            expect(
                queries.filter((q) => q.file === file),
                file
            ).not.toHaveLength(0);
        }
        const names = new Set(
            queries.flatMap((q) => metricNamesIn(q.expr)).filter((n) => !n.startsWith(DRIVER_PREFIX))
        );
        expect(names.size).toBeGreaterThanOrEqual(20);
    });

    it('queries only declared board metrics', async () => {
        expect(undeclared(queriesIn(), await declaredBoardNames())).toEqual([]);
    });

    const ADMISSION = /bellows_admission_(limit|running|running_max)\b/;
    const reads = (expr: string) => ADMISSION.test(expr);
    const readsWithMax = (expr: string) =>
        /\bmax\s*(by\s*\([^)]*\)\s*)?\(/.test(expr) && !/\b(sum|avg|count|min)\b/.test(expr);

    it('reads DB-derived replica gauges with max, never sum', () => {
        const gauges = queriesIn().filter((q) => reads(q.expr));
        expect(gauges.length).toBeGreaterThanOrEqual(3);
        expect(gauges.filter((q) => !readsWithMax(q.expr))).toEqual([]);
        expect(readsWithMax('sum(bellows_admission_running)')).toBe(false);
    });

    it('never turns a missing sample into zero', () => {
        expect(queriesIn().filter((q) => q.expr.includes('vector('))).toEqual([]);
    });

    it('alert rules are Prometheus rule groups covering the issue', () => {
        const rules = RULES.flatMap((file) => {
            const doc = parse(readFileSync(`${ROOT}/alerts/${file}`, 'utf8')) as {
                groups: { name: string; rules: Record<string, any>[] }[];
            };
            return doc.groups.flatMap((g) => g.rules);
        });
        expect(rules.map((r) => r.alert).sort()).toEqual(
            [
                'BellowsBoard5xxRatio',
                'BellowsBoardLatencyP95',
                'BellowsClaimLockWaitP95',
                'BellowsCollectorExportFailures',
                'BellowsDriverNoPolls',
                'BellowsDriverNoSuccessfulPoll',
                'BellowsMetricReadFailures',
                'BellowsReaperSweepFailures',
            ].sort()
        );
        for (const rule of rules) {
            expect(typeof rule.expr, rule.alert).toBe('string');
            expect(rule.for, rule.alert).toMatch(/^\d+[smh]$/);
            expect(rule.labels?.severity, rule.alert).toBeTruthy();
            expect(rule.annotations?.summary, rule.alert).toBeTruthy();
            expect(rule.annotations?.description, rule.alert).toBeTruthy();
        }
    });
});

describe('importing into a stock Grafana', () => {
    const DATASOURCE = { type: 'prometheus', uid: '${DS_PROMETHEUS}' };

    function* walk(node: unknown, key = ''): Generator<[string, unknown]> {
        yield [key, node];
        if (Array.isArray(node)) for (const item of node) yield* walk(item, key);
        else if (node !== null && typeof node === 'object') {
            for (const [k, v] of Object.entries(node)) yield* walk(v, k);
        }
    }

    it('imports into a stock Grafana', () => {
        const dashboards = DASHBOARDS.map((file) => ({
            file,
            json: JSON.parse(readFileSync(`${ROOT}/dashboards/${file}`, 'utf8')) as Record<string, any>,
        }));
        const titles = dashboards.map((d) => d.json.title);
        expect(new Set(titles).size).toBe(titles.length);
        for (const { file, json } of dashboards) {
            expect(json.id, file).toBeNull();
            expect(json.uid, file).toMatch(/^bellows-[a-z-]+$/);
            expect(
                json.__inputs.map((i: { name: string }) => i.name),
                file
            ).toEqual(['DS_PROMETHEUS']);
            const ids: unknown[] = [];
            for (const [key, value] of walk(json)) {
                if (key === 'datasource') expect(value, file).toEqual(DATASOURCE);
                // A uid is the dashboard's own or the datasource variable: nothing names a real stack.
                if (key === 'uid') expect([json.uid, DATASOURCE.uid], file).toContain(value);
                if (key === 'panels' && Array.isArray(value)) ids.push(...value.map((p: { id: unknown }) => p.id));
            }
            expect(new Set(ids).size, file).toBe(ids.length);
        }
    });
});

describe('metricNamesIn', () => {
    it.each([
        ['histogram_quantile(0.95, sum by (le) (rate(a_bucket{x="b c"}[5m])))', ['a_bucket']],
        ['a / on (instance) group_left b', ['a', 'b']],
        ['rate(a[$__rate_interval])', ['a']],
        ['absent_over_time(a[15m])', ['a']],
        ['time() - 180', []],
        ['a or on (instance) 0 * b unless on (instance) c', ['a', 'b', 'c']],
    ])('reads %s', (expr, names) => {
        expect(metricNamesIn(expr)).toEqual(names);
    });
});
