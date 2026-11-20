import { describe, expect, it } from 'vitest';
import { createDriverMetrics } from '../src/driver-metrics.js';
import { metricsHarness } from './helpers-metrics.js';

/**
 * The attribute names each driver instrument may carry. A new instrument, or a new attribute on one, is added here on
 * purpose: none may name an org, repo, job, user or pod.
 */
const ALLOWED: Record<string, string[]> = {
    'bellows.driver.board.request.duration': ['endpoint', 'status_class'],
    'bellows.driver.k8s.request.duration': ['client', 'verb', 'resource', 'status_class'],
    'bellows.driver.docker.commands': ['client', 'command', 'outcome'],
    'bellows.driver.step.duration': ['kind', 'outcome'],
    'bellows.driver.reaper.sweep.duration': ['outcome'],
    'bellows.driver.reaper.scanned': ['what'],
    'bellows.driver.claims.malformed': ['field'],
    'bellows.driver.claim.polls': ['outcome'],
    'bellows.driver.reaper.volume_export': ['result'],
};
const FORBIDDEN_NAME = /(^|[._])(org|repo|job|lease|user|pod|session|token)([._]|$)/;

describe('driver metric attributes', () => {
    it('limits every instrument to its allowlist, and none to an id', async () => {
        const harness = metricsHarness();
        const board = 'http://board:8080';
        const metrics = createDriverMetrics({
            boardUrl: board,
            fetch: async () => new Response('', { status: 200 }),
            meter: harness.meter,
        });
        await metrics.fetch(`${board}/api/jobs/claim`);
        await metrics.k8s(async () => ({ status: 200, body: '' }), 'runner')('GET', '/api/v1/namespaces/ns/pods');
        await metrics.docker(async () => ({ stdout: '' }), 'reaper')(['ps']);
        metrics.step('sync', 'ok', 1);
        metrics.reaper.sweep('ok', 1);
        metrics.reaper.scanned('groups', 1);
        metrics.malformedClaim(['env']);
        metrics.claimPoll('idle');
        metrics.reaper.volumeExport?.('drained');

        const collected = await harness.collect();
        expect(collected.map((m) => m.descriptor.name).sort()).toEqual(Object.keys(ALLOWED).sort());
        for (const metric of collected) {
            const allowed = ALLOWED[metric.descriptor.name]!;
            for (const point of metric.dataPoints) {
                expect(
                    Object.keys(point.attributes).filter((n) => !allowed.includes(n)),
                    metric.descriptor.name
                ).toEqual([]);
            }
            for (const name of allowed) expect(name).not.toMatch(FORBIDDEN_NAME);
        }
    });
});
