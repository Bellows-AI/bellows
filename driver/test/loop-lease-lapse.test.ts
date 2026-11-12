import { describe, expect, it } from 'vitest';
import type { HeartbeatVerdict } from '../src/board/board.js';
import type { RunOutcome } from '../src/runner.js';
import { createLoop } from '../src/loop/loop.js';
import { whileReclaimRenewed } from '../src/loop/loop-reclaim.js';
import { type BoardStub, config, job, ok, sleep, stubBoard, stubRunner } from './fixtures/loop-stubs.js';

/**
 * BEL-317: the driver's own lease clock. A board the driver cannot reach expires its lease, so the driver
 * stops acting at that moment — departing and leaving the runner for the next claim — whether the beat
 * fails, never returns, or the lapse lands while the verdict is being concluded. The lease is compressed
 * to a second; the real loop runs against a stub board and runner.
 */
const LEASE_SECONDS = 1;
const LEASE_MS = LEASE_SECONDS * 1_000;
const HELD: HeartbeatVerdict = { result: 'held', cancelRequested: false };
const never = <T>() => new Promise<T>(() => {});
const settleFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Beat = (n: number) => Promise<HeartbeatVerdict>;

/** One claimed job under a one-second lease; `beat(n)` answers the nth heartbeat (1-based). */
async function run(
    beat: Beat,
    outcome: () => Promise<RunOutcome>,
    tweak: (board: BoardStub, runner: ReturnType<typeof stubRunner>) => void = () => {}
) {
    const { board, attach } = stubBoard([job(1)]);
    let n = 0;
    board.heartbeat = async () => {
        n += 1;
        return beat(n);
    };
    const runner = stubRunner(outcome);
    tweak(board, runner);
    const logs: string[] = [];
    const loop = createLoop({
        board,
        runner,
        config: { ...config(), leaseSeconds: LEASE_SECONDS },
        sleep,
        log: (line) => logs.push(line),
    });
    attach(loop);
    const startedAt = Date.now();
    await loop.start();
    return { board, runner, logs, elapsedMs: Date.now() - startedAt, beats: () => n };
}

const lapsed = (logs: string[]) => logs.filter((line) => line.includes('lease lapsed, board unreachable'));

describe('a lease that lapses while the board is unreachable', () => {
    it.each([
        [
            'a heartbeat that never returns',
            (n: number) => (n === 1 ? Promise.resolve(HELD) : never<HeartbeatVerdict>()),
        ],
        [
            'a heartbeat that fails',
            (n: number) => (n === 1 ? Promise.resolve(HELD) : Promise.reject(new Error('board unreachable'))),
        ],
    ])('(a, b) %s departs at the lapse and leaves the runner to the next claim', async (_label, beat) => {
        const { board, runner, logs, elapsedMs } = await run(beat, () => never<RunOutcome>());

        expect(lapsed(logs)).toHaveLength(1);
        expect(elapsedMs).toBeGreaterThanOrEqual(LEASE_MS - 50);
        expect(elapsedMs).toBeLessThan(LEASE_MS * 3);
        // The runner is the next claim's to adopt: neither killed nor finished, and no verdict of any kind.
        expect(runner.killed).toEqual([]);
        expect(runner.finished).toEqual([]);
        expect(board.completed).toEqual([]);
        expect(board.staged).toEqual([]);
        expect(logs.filter((line) => line.includes('"from":"launched","to":"launched","ending":"lost"'))).toHaveLength(
            1
        );
    });

    it('(c) before the launch it stands the setup down and finishes the group, killing nothing', async () => {
        const { runner, logs, board } = await run(
            (n) => (n === 1 ? Promise.resolve(HELD) : never<HeartbeatVerdict>()),
            () => never<RunOutcome>(),
            (_board, r) => {
                r.syncCheckout = (() => never()) as typeof r.syncCheckout;
            }
        );

        expect(lapsed(logs)).toHaveLength(1);
        expect(runner.killed).toEqual([]);
        expect(runner.finished).toEqual([job(1).id]);
        expect(board.completed).toEqual([]);
    });

    it.each([
        ['staging', 'stage'],
        ['reporting', 'complete'],
    ] as const)(
        '(d) %s: the board call in flight at the lapse is abandoned and nothing is sent after it',
        async (_label, hangs) => {
            const calls: string[] = [];
            const { board, runner, logs } = await run(
                (n) => (n === 1 ? Promise.resolve(HELD) : never<HeartbeatVerdict>()),
                async () => ok(),
                (b) => {
                    const stage = b.stageConclusion.bind(b);
                    b.stageConclusion = async (...args) => {
                        calls.push('stage');
                        return hangs === 'stage' ? never() : stage(...args);
                    };
                    b.complete = async () => {
                        calls.push('complete');
                        return never();
                    };
                }
            );
            await settleFor(LEASE_MS);

            // The call in flight is abandoned at the lapse; the retry is never sent again, and the group stands.
            expect(calls).toEqual(hangs === 'stage' ? ['stage'] : ['stage', 'complete']);
            expect(lapsed(logs)).toHaveLength(1);
            expect(runner.finished).toEqual([]);
            expect(board.completed).toEqual([]);
        }
    );

    it('(e) a board that answers again before the lapse resets the clock', async () => {
        let finish: (o: RunOutcome) => void = () => {};
        const running = new Promise<RunOutcome>((resolve) => {
            finish = resolve;
        });
        // Beats 1..6 are held, spaced across more than one lease in total; every gap stays under it.
        const { board, logs } = await run(
            (n) => (n <= 6 ? Promise.resolve(HELD) : never<HeartbeatVerdict>()),
            () => running,
            (b) => {
                const original = b.heartbeat.bind(b);
                b.heartbeat = async (...args) => {
                    await settleFor(LEASE_MS / 3);
                    return original(...args);
                };
                setTimeout(() => finish(ok()), LEASE_MS * 1.6);
            }
        );

        expect(lapsed(logs)).toEqual([]);
        expect(board.completed).toHaveLength(1);
    });
});

describe('a heartbeat that hangs while the run finishes', () => {
    it('is released by the quiesce, so the verdict lands and the teardown completes inside the lease', async () => {
        const { board, runner, logs, elapsedMs } = await run(
            (n) => (n === 1 ? Promise.resolve(HELD) : never<HeartbeatVerdict>()),
            async () => {
                await settleFor(100);
                return ok();
            }
        );

        expect(board.completed).toHaveLength(1);
        expect(runner.finished).toHaveLength(1);
        expect(lapsed(logs)).toEqual([]);
        expect(elapsedMs).toBeLessThan(LEASE_MS);
    });
});

describe('a reclaim renewal whose board stays unreachable', () => {
    it('never starts the removal when the first renewal hangs past the lapse', async () => {
        let started = false;
        const ctx = {
            board: { renewReclaim: () => never<'held'>() },
            config: { leaseSeconds: LEASE_SECONDS },
            log: () => {},
            sleep: () => settleFor(10),
        };

        const result = await whileReclaimRenewed(ctx, { id: 'reclaim-1', token: 'token' }, async () => {
            started = true;
            return 1;
        });

        expect(result).toEqual({ held: false });
        expect(started).toBe(false);
    });

    it('abandons the removal in flight at the lapse, so it is never acked', async () => {
        let renewals = 0;
        const logs: string[] = [];
        const ctx = {
            board: {
                renewReclaim: () => {
                    renewals += 1;
                    return renewals === 1 ? Promise.resolve('held' as const) : never<'held'>();
                },
            },
            config: { leaseSeconds: LEASE_SECONDS },
            log: (line: string) => logs.push(line),
            sleep: () => settleFor(10),
        };

        const startedAt = Date.now();
        const result = await whileReclaimRenewed(ctx, { id: 'reclaim-1', token: 'token' }, () => never<number>());

        expect(result).toEqual({ held: false });
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(LEASE_MS - 50);
        expect(logs.some((line) => line.includes('lease lapsed, board unreachable'))).toBe(true);
    });
});
