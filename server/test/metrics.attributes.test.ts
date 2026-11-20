import { describe, expect, it } from 'vitest';
import { metricsHarness, recordEveryBoardInstrument } from './helpers-metrics.js';

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
    'bellows.job.interruptions': ['cause', 'refunded'],
    'bellows.job.settled': ['outcome', 'cause'],
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
        await recordEveryBoardInstrument(harness.meter, { db: false });

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
