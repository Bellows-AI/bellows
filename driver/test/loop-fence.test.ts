import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { driverSources } from './fixtures/driver-sources.js';
import type { BoardJob, LeaseState } from '../src/board/board.js';
import { BOARD_CALL_ATTEMPTS, BoardHttpError } from '../src/board/board-retry.js';
import { newJobState, raceStep } from '../src/loop/loop-attempt.js';
import { end, endIfDown } from '../src/loop/loop-conclusion.js';
import { recordEnding } from '../src/loop/loop-phase.js';
import { handBackFence, setupDecision, standDown, syncThrewHalt, thrownRunDecision } from '../src/loop/loop-fence.js';
import { LeftoverTerminating } from '../src/runner.js';
import type { AttemptCtx, SetupHalt } from '../src/loop/loop-types.js';

const JOB = { id: 'job-1' } as BoardJob;

const FAULT: SetupHalt = {
    halt: 'fault',
    log: 'checkout sync failed: the remote said no',
    verdict: { status: 'failed', exitCode: null, output: 'nope', failureKind: 'runner_error' },
};
const LEAVE: SetupHalt = { halt: 'leave', log: 'checkout sync threw, leaving it to the lease' };
const CONCLUDED: SetupHalt = {
    halt: 'concluded',
    log: 'pre-run helper "lint" concluded the job without launching the agent',
    verdict: { status: 'succeeded', exitCode: 0, output: '{"decided":"up-to-date"}' },
};

/**
 * One attempt's fence, stubbed down to the calls it owns: the checkout-claim release, the group's
 * end, the suspend and the completion. Everything below is the promise issue #472 makes about a
 * conclusion and a stand-down — a new setup refusal cannot forget the release, because it never
 * gets to act.
 */
function fencedAttempt(fenced = true): { ctx: AttemptCtx; calls: string[]; lines: string[] } {
    const calls: string[] = [];
    const lines: string[] = [];
    const job = JOB;
    const ctx = {
        rt: {
            runner: {
                finish: async () => {
                    calls.push('finish');
                },
                releaseServices: async () => {
                    calls.push('services');
                },
                releaseFence: async (released: BoardJob) => {
                    calls.push(`release:${released.id}`);
                },
            },
            board: {
                suspend: async () => {
                    calls.push('suspend');
                    return 'ok' as LeaseState;
                },
                interrupt: async (interrupted: BoardJob) => {
                    calls.push(`interrupt:${interrupted.id}`);
                    return 'held' as LeaseState;
                },
                stageConclusion: async (staged: BoardJob) => {
                    calls.push(`stage:${staged.id}`);
                    return 'held' as LeaseState;
                },
            },
            config: { leaseSeconds: 300 },
            report: async (reported: BoardJob) => {
                calls.push(`complete:${reported.id}`);
                return 'ok' as LeaseState;
            },
            log: (line: string) => {
                calls.push('log');
                lines.push(line);
            },
        },
        job,
        state: newJobState(),
        quiesce: async () => {
            calls.push('quiesce');
        },
        fenced,
        treeBefore: null,
    } as unknown as AttemptCtx;
    return { ctx, calls, lines };
}

/**
 * Every ending runs the same way (issue #828): the durable board call first, then the heartbeat is
 * quiesced, the group ends, and the checkout claim goes back last (issue #469) — so the board is told
 * before anything is destroyed. A stand-down parks a stopped turn and then says what the board said;
 * a conclusion says why it ended and reports it.
 */
const TEARDOWN = ['quiesce', 'finish', 'release:job-1'];

/**
 * The rest is structural: "one owner" is a promise about the source, not about any path a test can
 * reach today — the refusals that would break it are exactly the ones not written yet. Pinned the
 * same way `scripts-*.test.ts` pins the bytes the images ship.
 */
const loopSources = (): readonly (readonly [string, string])[] => {
    return driverSources().filter(([file]) => /^loop-.*\.ts$/.test(file));
};

describe('the attempt fences have exactly one owner (issue #472)', () => {
    it('releases the checkout claim once, however often the fence runs', async () => {
        const { ctx, calls } = fencedAttempt();

        await handBackFence(ctx);
        await handBackFence(ctx);

        expect(calls).toEqual(['release:job-1']);
    });

    it('releases nothing for an attempt that never took the claim', async () => {
        const { ctx, calls } = fencedAttempt(false);
        recordEnding(ctx.state, 'stop');

        await handBackFence(ctx);
        expect(await endIfDown(ctx, 'setup')).toBe(true);

        expect(calls).toEqual(['suspend', 'log', 'quiesce', 'finish']);
    });

    it('stands a stopped attempt down as one sequence — park, settle, release', async () => {
        const { ctx, calls, lines } = fencedAttempt();
        recordEnding(ctx.state, 'stop');

        expect(await endIfDown(ctx, 'setup')).toBe(true);

        expect(calls).toEqual(['suspend', 'log', ...TEARDOWN]);
        expect(lines.join('\n')).toContain('stopped during setup');
    });

    it('leaves the attempt to its holder when the lease was lost, without parking it', async () => {
        const { ctx, calls, lines } = fencedAttempt();
        recordEnding(ctx.state, 'lost');

        expect(await endIfDown(ctx, 'setup')).toBe(true);

        expect(calls).toEqual(['log', ...TEARDOWN]);
        expect(lines.join('\n')).toContain('lease was lost during setup');
    });

    it('runs the pre-park hook for a stopped attempt, before the park and the settle', async () => {
        const { ctx, calls } = fencedAttempt();
        recordEnding(ctx.state, 'stop');

        expect(await endIfDown(ctx, 'its run', async () => void calls.push('hook'))).toBe(true);

        expect(calls).toEqual(['hook', 'suspend', 'log', ...TEARDOWN]);
    });

    it.each(['lost', 'removed'] as const)('skips the pre-park hook when the lease is %s', async (verdict) => {
        const { ctx, calls, lines } = fencedAttempt();
        recordEnding(ctx.state, verdict);

        expect(await endIfDown(ctx, 'its run', async () => void calls.push('hook'))).toBe(true);

        expect(calls).toEqual(['log', ...TEARDOWN]);
        expect(lines.join('\n')).toContain('during its run');
    });

    it('answers an attempt that is not down with nothing done', async () => {
        const { ctx, calls } = fencedAttempt();

        expect(standDown(ctx, 'setup')).toBeNull();
        expect(await endIfDown(ctx, 'setup')).toBe(false);

        expect(calls).toEqual([]);
    });

    // Issue #820: runJob's catch asks again after a stand-down that threw; the second ask is a no-op.
    it('stands an attempt down once, however often it is asked', async () => {
        const { ctx, calls } = fencedAttempt();
        recordEnding(ctx.state, 'stop');

        expect(await endIfDown(ctx, 'setup')).toBe(true);
        expect(await endIfDown(ctx, 'its run')).toBe(true);

        expect(calls).toEqual(['suspend', 'log', ...TEARDOWN]);
    });

    it('retries a park the board does not take, then leaves the stop to the lease without throwing', async () => {
        const { ctx, calls, lines } = fencedAttempt();
        recordEnding(ctx.state, 'stop');
        Object.assign(ctx.rt, { sleep: async () => {} });
        ctx.rt.board.suspend = async () => {
            calls.push('suspend');
            throw new BoardHttpError(503, '/api/jobs/job-1/suspend answered 503: down');
        };

        expect(await endIfDown(ctx, 'setup')).toBe(true);

        expect(calls.filter((c) => c === 'suspend')).toHaveLength(BOARD_CALL_ATTEMPTS);
        expect(lines.at(-1)).toContain('the board did not take the stop, left to the lease');
    });

    it('still parks when the pre-park hook throws', async () => {
        const { ctx, calls, lines } = fencedAttempt();
        recordEnding(ctx.state, 'stop');

        const hook = async () => {
            throw new Error('artifact upload refused');
        };
        expect(await endIfDown(ctx, 'its run', hook)).toBe(true);

        expect(calls).toEqual(['log', 'suspend', 'log', ...TEARDOWN]);
        expect(lines[0]).toContain('parking anyway: artifact upload refused');
    });

    it('concludes a leave with the board told nothing before the claim goes back', async () => {
        const { ctx, calls, lines } = fencedAttempt();

        await end(ctx, setupDecision(LEAVE));

        // A `leave` reports nothing at all: the lease decides.
        expect(calls).toEqual(['log', ...TEARDOWN]);
        expect(lines.join('\n')).toContain(LEAVE.log);
    });

    // Issue #821 (D1): a verdict is staged under the lease, then completed, and only then does the
    // attempt give the claim back and tear its group down — the heartbeat stops between the two.
    it.each([
        ['a fault', FAULT],
        ['a conclusion', CONCLUDED],
    ] satisfies readonly (readonly [string, SetupHalt])[])(
        'stages and completes %s before the claim goes back and the group ends',
        async (_what, halt) => {
            const { ctx, calls, lines } = fencedAttempt();

            await end(ctx, setupDecision(halt));

            expect(calls).toEqual(['log', 'stage:job-1', 'complete:job-1', ...TEARDOWN]);
            expect(lines.join('\n')).toContain(halt.log);
        }
    );

    // BEL-160: a sweep blocked by leftovers still deleting is no failure of the attempt.
    describe('a sweep blocked by a terminating leftover', () => {
        const blocked = new LeftoverTerminating('the leftover pod p on node n is still terminating after its delete');
        const expected = {
            halt: 'interrupt',
            reason: `the claim waits for a leftover still terminating: ${blocked.message}`,
            refused: true,
            blocked: true,
        };

        it('maps a thrown sync to a blocked, refused interrupt', () => {
            expect(syncThrewHalt(blocked)).toEqual(expected);
        });

        it('maps a thrown run to a blocked interrupt decision', () => {
            expect(thrownRunDecision(JOB, blocked)).toMatchObject({ kind: 'interrupt', blocked: true, refused: true });
        });

        it('keeps blocked on the decision a setup halt becomes', () => {
            expect(setupDecision(expected as SetupHalt)).toMatchObject({ kind: 'interrupt', blocked: true });
        });
    });

    // Issue #822: a refusal the driver makes while alive goes back to the board as an interruption,
    // after the claim and with no verdict — the board frees the lease at once and records why.
    it('hands an interrupt back to the board before the claim goes back, reporting nothing', async () => {
        const { ctx, calls, lines } = fencedAttempt();

        await end(ctx, setupDecision({ halt: 'interrupt', reason: 'could not start the services: daemon refused' }));

        expect(calls).toEqual(['interrupt:job-1', 'log', ...TEARDOWN]);
        expect(lines.join('\n')).toContain(
            'could not start the services: daemon refused, handed back as an interruption'
        );
    });

    it('releases the claim from one loop file only', () => {
        const owners = loopSources()
            .filter(([, source]) => source.includes('releaseFence'))
            .map(([file]) => file);
        expect(owners).toEqual(['loop-fence.ts']);
    });

    // #828: the lifecycle has one owner. Teardown is `end()`'s (loop-conclusion.ts); the claim's
    // release is the fence's (loop-fence.ts); the attempt's phase and ending are written by
    // loop-phase.ts alone. A runner's `run()` and every other step only report facts.
    const filesMatching = (pattern: RegExp): string[] =>
        driverSources()
            .filter(([file, source]) => !/^(docker|k8s)/.test(file) && pattern.test(source))
            .map(([file]) => file);

    it('calls the group finish and the run-control close from loop-conclusion alone', () => {
        expect(filesMatching(/\brunner\.finish\(|(?<!function )\bcloseRunControl\(/)).toEqual(['loop-conclusion.ts']);
    });

    it('releases the services from end() alone, a start the attempt stopped waiting on included', () => {
        // loop-services.ts only hands the late start to end() (`abandonedServices`); the runner
        // interface only declares the method (runner.ts).
        expect(filesMatching(/\.releaseServices\(/)).toEqual(['loop-conclusion.ts']);
    });

    it('writes the phase and the ending through loop-phase alone', () => {
        expect(filesMatching(/\bstate\.(phase|ending)\s*=[^=]/)).toEqual(['loop-phase.ts']);
    });

    it('tells the board of an interruption or a suspension from end() alone, but for the adoption record', () => {
        // The adoption record (loop-adopt.ts) is the earlier claim's interruption, written by
        // runPhases under this claim's lease with no ending of this attempt.
        expect(filesMatching(/\bboard\s*\.(interrupt|suspend)\(/)).toEqual(['loop-adopt.ts', 'loop-conclusion.ts']);
    });

    it('defines both fences once, and no other loop file does', () => {
        const definers = loopSources()
            .filter(([, source]) => /export (async )?function (standDown|setupDecision)\(/.test(source))
            .map(([file]) => file);
        expect(definers).toEqual(['loop-fence.ts']);
    });

    it('keeps the helper steps pure — they answer data and settle for nobody', () => {
        // The pre-helper runs inside setup and is the other setup module, so a settlement or a
        // release of its own is a fence it should not own (issue #472).
        const helpers = loopSources().find(([file]) => file === 'loop-helpers.ts')?.[1] ?? '';
        expect(helpers.match(/await (ctx\.)?settle\(\)/g) ?? []).toEqual([]);
        expect(helpers.match(/releaseFence/g) ?? []).toEqual([]);
    });

    it('mints the attempt one signal, never one per step', () => {
        // The gate exec, the tree probe and the gate-session cancel all take `state.signal`: a
        // controller per transport is a controller that can answer a stand-down out of step with
        // the race that decides one (issue #472).
        const minting = loopSources()
            .filter(([file, source]) => file !== 'loop-attempt.ts' && source.includes('new AbortController'))
            .map(([file]) => file);
        expect(minting).toEqual([]);
    });

    it('leaves the phase files no second stand-down path and no phase-level check of their own', () => {
        // What remains of `down(state)` are re-checks after an await INSIDE a step (loop-gates,
        // loop-helpers); a phase boundary asks `standDown` (issue #488).
        const phaseFiles = ['loop-run.ts', 'loop-post-run.ts', 'loop-phase-checkpoints.ts'];
        const sources = loopSources().filter(([file]) => phaseFiles.includes(file));
        expect(sources.map(([file]) => file).sort()).toEqual([...phaseFiles].sort());
        for (const [, source] of sources) expect(source).not.toMatch(/settleNonFinish|\bdown\(/);
    });

    it('fences every phase boundary from loop-run and loop-post-run, and nowhere else', () => {
        const callers = loopSources()
            .filter(([file, source]) => file !== 'loop-fence.ts' && /endIfDown\(ctx, '/.test(source))
            .map(([file]) => file);
        expect(callers).toEqual(['loop-post-run.ts', 'loop-run.ts']);
    });
});

describe('one abort signal per attempt (issue #472)', () => {
    it('is aborted by the heartbeat verdict, through abortNow', () => {
        const state = newJobState();

        expect(state.signal.aborted).toBe(false);
        state.abortNow();
        expect(state.signal.aborted).toBe(true);
    });

    it('answers the step that won the race', async () => {
        const state = newJobState();

        expect(await raceStep(state.signal, Promise.resolve('value'))).toEqual({ value: 'value' });
    });

    it('never waits on a step the attempt already stood down', async () => {
        const state = newJobState();
        state.abortNow();

        // A promise nobody can settle: the race must answer on the signal, not on the step.
        expect(await raceStep(state.signal, new Promise<string>(() => {}))).toBeNull();
    });

    it('never lets an abandoned step reject into the void', async () => {
        const state = newJobState();
        state.abortNow();
        const failures: unknown[] = [];
        const onRejection = (why: unknown) => failures.push(why);
        process.on('unhandledRejection', onRejection);
        try {
            // A step already in flight when the stand-down lands, rejecting after it was abandoned.
            expect(await raceStep(state.signal, Promise.reject(new Error('the step threw late')))).toBeNull();
            await new Promise((resolve) => setImmediate(resolve));
            expect(failures).toEqual([]);
        } finally {
            process.off('unhandledRejection', onRejection);
        }
    });

    it('answers null when the stand-down lands mid-step', async () => {
        const state = newJobState();
        const running = raceStep(state.signal, new Promise<string>(() => {}));

        state.abortNow();

        expect(await running).toBeNull();
    });

    it('leaves no abort listener behind when a step won', async () => {
        // An attempt has one step per phase; a signal that kept every finished step's listener
        // would hold them all until the attempt ends.
        const state = newJobState();

        await raceStep(state.signal, Promise.resolve('value'));

        expect(getEventListeners(state.signal, 'abort')).toHaveLength(0);
    });
});
