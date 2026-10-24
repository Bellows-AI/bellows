/**
 * Gremlins against the takeover simulation (#829, #922): seeded random faults at random points of a run,
 * and the invariants every run owes (`fixtures/gremlin.ts`). A failure prints its seed and event trace;
 * `GREMLIN_SEED=<n>` replays that one run, `GREMLIN_RUNS=<n>` raises the count for a local soak.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { planOf, runGremlin, stallExplains, type Fault, type Verdict } from './fixtures/gremlin.js';
import { liveSupervisors } from './fixtures/supervisor-tracker.js';
import { lane15 } from './fixtures/takeover-sim.js';

afterAll(() => expect(liveSupervisors()).toBe(0));

const RUNS = Number(process.env.GREMLIN_RUNS ?? 200);
const ONE = process.env.GREMLIN_SEED === undefined ? null : Number(process.env.GREMLIN_SEED);
const WIDTH = 40;
const LANE_RUNS = Number(process.env.GREMLIN_LANE_RUNS ?? 12);

const report = (v: Verdict) =>
    `seed ${v.seed} (replay: GREMLIN_SEED=${v.seed})\n${v.violations.join('\n')}\n--- plan\n${JSON.stringify(v.plan)}\n--- trace\n${v.trace.join('\n')}`;

/** Nothing happens in this plan but the run: the faults only keep it going past the stalls. */
const hold: Fault = { at: 6_000, kind: 'glitch', ops: ['none'], mode: 'throw', forMs: 10 };

/** Excusing is for a stalled host: a run set that is mostly excused says the check hides what it should find. */
const MAX_EXCUSED = 0.5;
function expectFewExcused(verdicts: Verdict[]) {
    const excused = verdicts.filter((v) => v.excused.length > 0);
    if (excused.length > 0)
        console.log(
            `${excused.length}/${verdicts.length} runs excused as host-stalled (seeds ${excused.map((v) => v.seed).join(',')})`
        );
    expect(excused.length, 'too many runs excused as host-stalled').toBeLessThanOrEqual(
        Math.max(1, Math.floor(verdicts.length * MAX_EXCUSED))
    );
}

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
            const verdicts = await play(seeds);
            const failed = verdicts.filter((v) => v.violations.length > 0).sort((a, b) => a.seed - b.seed);
            if (failed.length > 3)
                console.log(failed.map((v) => `seed ${v.seed}: ${v.violations.join(' | ')}`).join('\n'));
            expect(failed.map(report).slice(0, 3).join('\n\n=====\n\n')).toBe('');
            expectFewExcused(verdicts);
        },
        Math.max(120_000, RUNS * 1_000)
    );

    // A host too loaded to play the faults on time runs a drain's handover and a kill of the same driver
    // together (#932): the kill leaves the handover nothing to settle on, and the run must still end.
    it('a driver killed while it hands over does not hold the run', async () => {
        const overlap = [
            { at: 50, kind: 'handover' as const, restartMs: 186 },
            { at: 50, kind: 'killDriver' as const, restartMs: 403 },
        ];
        const timeBox = new Promise<null>((resolve) => setTimeout(() => resolve(null), 40_000));
        const verdict = await Promise.race([runGremlin(118, { faults: overlap }), timeBox]);
        expect(verdict, 'the run did not end within its bound').not.toBeNull();
        expect(verdict?.violations).toEqual([]);
    }, 60_000);

    // A heartbeat that hangs for the glitch can by itself delay the next beat past the
    // lease, load or not: such a loss is the board's right, not an interruption nobody injected (#932).
    it('a lease a hung heartbeat outlasts is not blamed on the product', async () => {
        const glitch = { at: 1_300, kind: 'glitch' as const, ops: ['heartbeat'], mode: 'timeout' as const, forMs: 800 };
        // Nothing else happens: this one only keeps the run going past the glitch.
        const hold = { at: 6_000, kind: 'glitch' as const, ops: ['none'], mode: 'throw' as const, forMs: 10 };
        const base = planOf(64, {});
        const verdict = await runGremlin(64, {
            faults: [glitch, hold],
            timing: { ...base.timing, refreshMs: 400 },
            publishAtMs: 3_000,
            agentMs: 100,
        });
        expect(verdict.violations).toEqual([]);
    }, 60_000);

    // #946: a loaded host stalls the loop for longer than a lease lasts: the heartbeat finds no turn, the board
    // rightly reclaims, and no fault was injected. The host did it, and the verdict says so rather than staying silent.
    it('a lease lost to an event-loop stall is excused as the host and recorded, not blamed on the product', async () => {
        const verdict = await runGremlin(5, {
            faults: [hold],
            hostStall: { claimSeq: 1, afterMs: 300, ms: 3_500 },
            publishAtMs: 3_000,
            agentMs: 100,
        });
        expect(verdict.violations).toEqual([]);
        expect(verdict.excused.join('\n'), 'the loss was not matched to the stall').toMatch(
            /interruption of claim 1 .*stalled \d+ms/
        );
    }, 60_000);

    // A stall excuses the lease it cost and nothing after it: a later lapse with the loop turning is a product bug
    // and is still reported (the run-wide excuse of before hid it).
    it('a lease that lapses with no stall in its silence is still a violation in a run that had a stall', async () => {
        const verdict = await runGremlin(5, {
            faults: [{ ...hold, at: 12_000 }],
            hostStall: { claimSeq: 1, afterMs: 300, ms: 3_500 },
            leaseLapse: { claimSeq: 2, afterMs: 1_500 },
            publishAtMs: 11_000,
            agentMs: 100,
        });
        expect(verdict.excused.join('\n')).toMatch(/interruption of claim 1 /);
        // A real stall of the loaded host landing in the lapse's short silence is a genuine excuse, not a miss.
        if (!verdict.excused.some((m) => m.includes('claim 2 ')))
            expect(verdict.violations.join('\n')).toMatch(/interruption of claim 2 that no injected fault hit/);
        expect(verdict.violations.join('\n')).not.toMatch(/claim 1 that no injected/);
    }, 60_000);

    // The rule itself, with no timing in it: a stall explains an interruption only inside that interruption's silence.
    it("a stall outside an interruption's silence does not explain it", () => {
        const stall = { at: 4_000, ms: 3_500 }; // [500, 4000]
        expect(stallExplains([stall], { since: 1_000, at: 3_800 }, 800).explained).toBe(true);
        expect(stallExplains([stall], { since: 4_100, at: 5_600 }, 800).explained).toBe(false);
        // Scheduling noise adds up to the margin but is no stall.
        const noise = Array.from({ length: 40 }, (_, k) => ({ at: 1_000 + k * 50, ms: 30 }));
        expect(stallExplains(noise, { since: 900, at: 3_000 }, 800).explained).toBe(false);
    });

    // #950: the kind lane's 15 s lease in real time. The faults still land in the first seconds of a run and the
    // takeover waits out the lease, so a seed plays for a minute; a few seeds at the lane's timing, not the soak.
    it("seeded runs at the lane's 15 s lease hold every invariant", async () => {
        const seeds = ONE === null ? Array.from({ length: LANE_RUNS }, (_, i) => i + 1) : [ONE];
        const verdicts = await Promise.all(seeds.map((seed) => runGremlin(seed, { timing: lane15() })));
        const failed = verdicts.filter((v) => v.violations.length > 0).sort((a, b) => a.seed - b.seed);
        expect(failed.map(report).slice(0, 3).join('\n\n=====\n\n')).toBe('');
        expectFewExcused(verdicts);
    }, 240_000);
});
