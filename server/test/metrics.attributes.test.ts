import { describe, expect, it } from 'vitest';
import { createServerMetrics } from '../src/metrics.js';
import { metricsHarness } from './helpers-metrics.js';

/**
 * The attribute names each board instrument may carry. A new instrument, or a new attribute on one, is added here on
 * purpose: none may name an org, repo, job, user or pod.
 */
const ALLOWED: Record<string, string[]> = {
    'http.server.request.duration': ['http.request.method', 'http.route', 'http.response.status_code'],
    'bellows.claim.polls': ['outcome'],
    'bellows.claim.refusals': ['scope'],
    'bellows.claim.wait': ['kind'],
    'bellows.claim.lock_wait': [],
    'bellows.claim.acquire': [],
    'bellows.claim.sweep': [],
    'bellows.background.pass.duration': ['loop', 'outcome'],
    'bellows.mcp.tool.duration': ['tool', 'outcome'],
    'bellows.metrics.read.failures': ['source'],
    'bellows.admission.limit': ['scope'],
    'bellows.admission.running': ['scope'],
    'bellows.admission.running.max': ['scope'],
};
const FORBIDDEN_NAME = /(^|[._])(org|repo|job|lease|user|pod|session|token)([._]|$)/;

describe('board metric attributes', () => {
    it('limits every instrument to its allowlist, and none to an id', async () => {
        const harness = metricsHarness();
        const metrics = createServerMetrics({
            admission: { global: 1, org: 1, repo: 1 },
            occupancy: async () => ({ global: 1, orgMax: 1, repoMax: 1 }),
            meter: harness.meter,
        });
        metrics.request('GET', '/api/jobs/:id', 200, 0.1);
        metrics.claimPoll('claimed');
        metrics.mcpTool('whoami', 'ok', 0.1);
        metrics.claim.refusal('org');
        metrics.claim.wait('new', 1);
        metrics.claim.lockWait(0.1);
        metrics.claim.acquire(0.1);
        metrics.claim.sweep(0.1);
        await metrics.timedPass('sweep', async () => undefined);
        const failing = createServerMetrics({
            admission: {},
            occupancy: async () => {
                throw new Error('down');
            },
            meter: harness.meter,
        });
        expect(failing).toBeDefined();

        const collected = await harness.collect();
        const seen = collected.map((m) => m.descriptor.name);
        expect(seen.sort()).toEqual(Object.keys(ALLOWED).sort());
        for (const metric of collected) {
            const allowed = ALLOWED[metric.descriptor.name]!;
            for (const point of metric.dataPoints) {
                const names = Object.keys(point.attributes);
                expect(
                    names.filter((n) => !allowed.includes(n)),
                    metric.descriptor.name
                ).toEqual([]);
            }
            for (const name of allowed) expect(name).not.toMatch(FORBIDDEN_NAME);
        }
    });
});
