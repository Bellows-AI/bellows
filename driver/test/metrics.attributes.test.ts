import { describe, expect, it } from 'vitest';
import { metricsHarness, recordEveryDriverInstrument } from './helpers-metrics.js';

/**
 * The attribute names each driver instrument may carry. A new instrument, or a new attribute on one, is added here on
 * purpose: none may name an org, repo, job, user or pod.
 */
const ALLOWED: Record<string, string[]> = {
    'bellows.driver.board.request.duration': ['endpoint', 'status_class'],
    'bellows.driver.k8s.request.duration': ['client', 'verb', 'resource', 'status_class'],
    'bellows.driver.docker.commands': ['client', 'command', 'outcome'],
    'bellows.driver.docker.command.duration': ['client', 'command', 'outcome'],
    'bellows.driver.slots': ['state'],
    'bellows.driver.step.duration': ['kind', 'outcome'],
    'bellows.driver.gate.duration': ['gate', 'outcome'],
    'bellows.driver.gate.cpu.share': ['gate', 'mode'],
    'bellows.driver.gate.throttled.duration': ['gate'],
    'bellows.driver.gate.load.max': ['gate'],
    'bellows.driver.gate.memory.available.min': ['gate'],
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
        await recordEveryDriverInstrument(harness.meter);

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
