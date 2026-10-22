/**
 * Gremlins against the takeover simulation (#829, #922): seeded random faults at random points of a run,
 * and the invariants every run owes (`fixtures/gremlin.ts`). A failure prints its seed and event trace;
 * `GREMLIN_SEED=<n>` replays that one run, `GREMLIN_RUNS=<n>` raises the count for a local soak.
 */
import { describe, expect, it } from 'vitest';
import { runGremlin, type Verdict } from './fixtures/gremlin.js';

const RUNS = Number(process.env.GREMLIN_RUNS ?? 200);
const ONE = process.env.GREMLIN_SEED === undefined ? null : Number(process.env.GREMLIN_SEED);
const WIDTH = 40;

const report = (v: Verdict) =>
    `seed ${v.seed} (replay: GREMLIN_SEED=${v.seed})\n${v.violations.join('\n')}\n--- plan\n${JSON.stringify(v.plan)}\n--- trace\n${v.trace.join('\n')}`;

async function play(seeds: number[]): Promise<Verdict[]> {
    const out: Verdict[] = [];
    let next = 0;
    await Promise.all(
        Array.from({ length: WIDTH }, async () => {
            for (let i = next++; i < seeds.length; i = next++) out.push(await runGremlin(seeds[i]!));
        })
    );
    return out;
}

describe('takeover gremlins', () => {
    it(
        ONE === null ? `${RUNS} seeded runs hold every invariant` : `seed ${ONE} holds every invariant`,
        async () => {
            const seeds = ONE === null ? Array.from({ length: RUNS }, (_, i) => i + 1) : [ONE];
            const failed = (await play(seeds)).filter((v) => v.violations.length > 0).sort((a, b) => a.seed - b.seed);
            if (failed.length > 3)
                console.log(failed.map((v) => `seed ${v.seed}: ${v.violations.join(' | ')}`).join('\n'));
            expect(failed.map(report).slice(0, 3).join('\n\n=====\n\n')).toBe('');
        },
        Math.max(120_000, RUNS * 1_000)
    );
});
