import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { metricsHarness, recordEveryDriverInstrument } from './helpers-metrics.js';
import { metricNamesIn, prometheusNames, queriesIn, seriesNamesIn } from './helpers-promql.js';

const ALERTS = fileURLToPath(new URL('../../observability/alerts', import.meta.url));
const DRIVER_PREFIX = 'bellows_driver_';

async function declaredDriverNames(): Promise<Set<string>> {
    const harness = metricsHarness();
    await recordEveryDriverInstrument(harness.meter);
    return new Set((await harness.collect()).flatMap(prometheusNames));
}

const undeclared = (queries: { file: string; expr: string }[], declared: Set<string>): string[] =>
    queries.flatMap(({ file, expr }) =>
        metricNamesIn(expr)
            .filter((name) => name.startsWith(DRIVER_PREFIX) && !declared.has(name))
            .map((name) => `${file}: ${name}`)
    );

interface Rule {
    alert: string;
    expr: string;
}
const driverRules = (): Rule[] =>
    (parse(readFileSync(`${ALERTS}/driver.yaml`, 'utf8')) as { groups: { rules: Rule[] }[] }).groups.flatMap(
        (g) => g.rules
    );
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('the driver instruments under the Prometheus translation', () => {
    it('translates every driver instrument', async () => {
        const declared = await declaredDriverNames();
        for (const name of [
            'bellows_driver_claim_polls_total',
            'bellows_driver_reaper_sweep_duration_seconds_count',
            'bellows_driver_docker_command_duration_seconds_bucket',
            'bellows_driver_slots',
            'bellows_driver_k8s_request_duration_seconds_bucket',
        ]) {
            expect(declared, name).toContain(name);
        }
    });

    it('queries only declared driver metrics', async () => {
        const declared = await declaredDriverNames();
        const queries = queriesIn();
        expect(undeclared(queries, declared)).toEqual([]);
        expect(seriesNamesIn().filter((n) => n.startsWith(DRIVER_PREFIX) && !declared.has(n))).toEqual([]);
        const names = new Set(queries.flatMap((q) => metricNamesIn(q.expr)).filter((n) => n.startsWith(DRIVER_PREFIX)));
        expect(names.size).toBeGreaterThanOrEqual(8);
    });

    it('names a renamed instrument', async () => {
        const found = undeclared(
            [{ file: 'inline', expr: 'increase(bellows_driver_claim_poll_total[5m])' }],
            await declaredDriverNames()
        );
        expect(found).toEqual(['inline: bellows_driver_claim_poll_total']);
    });
});

describe('the no-successful-poll alert', () => {
    // The repo has no PromQL evaluator. This proves the rule keeps the shape whose behaviour `driver.test.yaml`
    // specifies (`promtool test rules`, run at project end); it does NOT prove that behaviour.
    it('the no-successful-poll rule keeps its anchor, its job-claim scope and its busy exemption', () => {
        const rule = driverRules().find((r) => r.alert === 'BellowsDriverNoSuccessfulPoll')!;
        const expr = squash(rule.expr);
        expect(expr).toContain(
            'sum by (instance) (increase(bellows_driver_claim_polls_total{outcome!="error"}[15m])) or on (instance) 0 * sum by (instance) (increase(bellows_driver_claim_polls_total[15m]))'
        );
        expect(expr).toMatch(/unless on \(instance\).*bellows_driver_slots\{state="open"\}/);
        expect(expr).toContain('timestamp(bellows_driver_slots)');
        expect(new Set(metricNamesIn(rule.expr))).toEqual(
            new Set(['bellows_driver_claim_polls_total', 'bellows_driver_slots'])
        );
    });

    it('the rule tests cover the cases the alert is for', () => {
        const doc = parse(readFileSync(`${ALERTS}/driver.test.yaml`, 'utf8')) as {
            rule_files: string[];
            tests: { name: string; alert_rule_test: { alertname: string; exp_alerts: unknown[] }[] }[];
        };
        expect(doc.rule_files).toEqual(['driver.yaml']);
        expect(doc.tests.map((t) => t.name)).toEqual([
            'only error samples fire',
            'failed job claims fire beside successful reclaim polls',
            'a driver with every slot busy is exempt',
            'a polling driver is quiet',
            'a departed driver is quiet',
        ]);
        for (const test of doc.tests.slice(0, 2)) {
            const [check] = test.alert_rule_test;
            expect(check!.alertname).toBe('BellowsDriverNoSuccessfulPoll');
            expect(check!.exp_alerts).toHaveLength(1);
        }
        for (const test of doc.tests.slice(2)) {
            expect(test.alert_rule_test[0]!.exp_alerts).toEqual([]);
        }
    });
});
