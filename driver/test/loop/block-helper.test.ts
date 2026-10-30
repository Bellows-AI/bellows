import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import type { RunOutcome, RunSession } from '../../src/runner.js';
import type { HelperPlan, HelperResult } from '../../src/helpers.js';
import { StepChannelClosed } from '../../src/step-control.js';
import type { LoopRuntime } from '../../src/loop/loop-types.js';
import { newJobState, watchOutput } from '../../src/loop/loop-attempt.js';
import { transition } from '../../src/loop/loop-phase.js';
import {
    config,
    drive,
    gatedJob,
    job,
    ok,
    sleep,
    stubBoard,
    stubGateStack,
    stubRunner,
} from '../fixtures/loop-stubs.js';

describe('block-helper steps (issue #207)', () => {
    /** A runner whose `runHelper` records every call and answers scripted results in order. */
    function runnerWithHelper(
        run: (job: BoardJob, session: RunSession | null) => Promise<RunOutcome>,
        results: HelperResult[]
    ) {
        const runner = stubRunner(run);
        const calls: { jobId: string; plan: HelperPlan; token: string | undefined }[] = [];
        const queue = [...results];
        runner.runHelper = async (helperJob, plan, { token } = {}) => {
            calls.push({ jobId: helperJob.id, plan, token });
            return queue.shift() ?? { ok: true, output: null };
        };
        return { runner, calls };
    }

    const helperPlan = (over: Partial<HelperPlan> = {}): HelperPlan => ({
        helperId: 'noop',
        phase: 'pre',
        input: null,
        githubWriting: false,
        ...over,
    });

    it('runs a declared pre-helper before the agent, and never launches the agent when it fails', async () => {
        const runCalls: string[] = [];
        const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }]);
        const { runner, calls } = runnerWithHelper(
            async (helperJob) => {
                runCalls.push(helperJob.id);
                return ok();
            },
            [{ ok: false, reason: 'runner_error', message: 'the helper blew up' }]
        );

        await drive({ ...board, runner });

        expect(calls).toHaveLength(1);
        expect(calls[0]!.plan.phase).toBe('pre');
        // The agent never launches — the whole point of the pre-phase gate.
        expect(runCalls).toEqual([]);
        expect(board.board.completed).toEqual([
            {
                id: job(1).id,
                status: 'failed',
                exitCode: null,
                output: expect.stringContaining('the helper blew up'),
                failureKind: 'helper',
                failureCause: 'transport',
            },
        ]);
    });

    it('runs the agent normally after a pre-helper succeeds', async () => {
        const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }]);
        const { runner, calls } = runnerWithHelper(async () => ok(), [{ ok: true, output: null }]);

        await drive({ ...board, runner });

        expect(calls).toHaveLength(1);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('asks the board for a fresh install token before a github-writing pre-helper, never a read-only one', async () => {
        // publish: false isolates the assertion to the pre-helper's own ask — otherwise the
        // ordinary publish flow (publishIfDue) asks for its own fresh token too, on a job this
        // plain would otherwise publish (absent `publish` reads as "publish").
        const board = stubBoard([{ ...job(1), publish: false, helperPlans: [helperPlan({ githubWriting: true })] }], {
            githubToken: 'fresh-install-token',
        });
        const { runner, calls } = runnerWithHelper(async () => ok(), [{ ok: true, output: null }]);

        await drive({ ...board, runner });

        expect(board.board.githubAsks).toEqual([job(1).id]);
        expect(calls[0]!.token).toBe('fresh-install-token');

        const readOnlyBoard = stubBoard([
            { ...job(2), publish: false, helperPlans: [helperPlan({ githubWriting: false })] },
        ]);
        const { runner: readOnlyRunner, calls: readOnlyCalls } = runnerWithHelper(
            async () => ok(),
            [{ ok: true, output: null }]
        );
        await drive({ ...readOnlyBoard, runner: readOnlyRunner });
        expect(readOnlyBoard.board.githubAsks).toEqual([]);
        expect(readOnlyCalls[0]!.token).toBeUndefined();
    });

    it('runs a declared post-helper after the agent, and fails the verdict — skipping publish — when it fails', async () => {
        const board = stubBoard([
            { ...job(1), repo: 'Bellows-AI/bellows', helperPlans: [helperPlan({ phase: 'post' })] },
        ]);
        const { runner, calls } = runnerWithHelper(
            async () => ok(),
            [{ ok: false, reason: 'malformed_output', message: 'unreadable verdict' }]
        );
        runner.publishGit = async (publishedJob) => {
            runner.published.push(publishedJob);
            return {
                ok: true,
                published: true,
                branch: 'fix/1',
                prUrl: 'https://github.com/o/r/pull/1',
                reason: null,
                cause: null,
                repository: 'o/r',
                baseBranch: 'main',
                prNumber: 1,
            };
        };

        await drive({ ...board, runner });

        expect(calls[0]!.plan.phase).toBe('post');
        expect(board.board.completed[0]).toMatchObject({
            status: 'failed',
            failureKind: 'helper',
            failureCause: 'unknown',
        });
        expect(board.board.completed[0]!.output).toContain('unreadable verdict');
        // Publish never runs: a failed post-helper dooms the verdict exactly like a failed gate.
        expect(runner.published).toEqual([]);
    });

    // Issue #826: the claim that adopts a finished agent runs its post-helpers again, under a new
    // lease. The effect each one names must be the same one the lost claim named, or no receipt
    // the lost claim left could ever answer it.
    it('names a post-helper effect the same on the claim that ran the agent and the claim that adopted it', async () => {
        const plans = [helperPlan({ phase: 'post' })];
        const effects: (string | undefined)[] = [];
        const record = (runner: ReturnType<typeof stubRunner>) => {
            runner.runHelper = async (_job, _plan, { effectId } = {}) => {
                effects.push(effectId);
                return { ok: true, output: null };
            };
        };
        const ran = stubRunner(async () => ok());
        record(ran);
        await drive({ ...stubBoard([{ ...job(1), helperPlans: plans }]), runner: ran });

        const replacement = { ...job(1), helperPlans: plans, attempts: 2, claimSeq: 2, leaseToken: job(2).leaseToken };
        const adopting = stubRunner(async () => ok(), {
            adopt: async () => ({ outcome: ok(), claimSeq: 1 }),
        });
        record(adopting);
        await drive({ ...stubBoard([replacement]), runner: adopting });

        expect(effects).toHaveLength(2);
        expect(effects[0]).toEqual(expect.any(String));
        expect(effects[1]).toBe(effects[0]);
        expect(effects[0]).not.toContain(job(1).leaseToken);
    });

    it.each<['pre' | 'post']>([['pre'], ['post']])(
        'hands a %s-helper whose supervisor was lost back as an interruption, never a failed verdict',
        async (phase) => {
            const board = stubBoard([{ ...job(1), helperPlans: [helperPlan({ phase })] }]);
            const runner = stubRunner(async () => ok());
            runner.runHelper = async () => {
                throw new StepChannelClosed('the helper');
            };

            await drive({ ...board, runner });

            expect(board.board.completed).toEqual([]);
            expect(board.board.interrupted).toEqual([
                { id: job(1).id, reason: expect.stringContaining('infrastructure loss'), release: true },
            ]);
        }
    );

    it('a non-zero exit is named after the agent, not a post-helper failure', async () => {
        const { kindOf, ledgerOf } = await import('../../src/loop/loop-ledger.js');
        const helperFailure = {
            helperId: 'noop',
            result: { ok: false as const, reason: 'malformed_output' as const, message: 'x' },
        };
        const parts = { outcome: ok({ exitCode: 1 }), failure: null, deadServices: [], helperFailure, published: null };
        expect(kindOf(ledgerOf(parts))).toBe('runner_error');
    });

    it.each([
        ['blocked', ok({ output: 'FACTORY_BLOCKED: no access' }), 'the agent reported it is blocked'],
        ['a non-zero exit', ok({ exitCode: 1 }), "the agent's run exited 1"],
        ['a timeout', ok({ exitCode: 1, timedOut: true }), 'the agent timed out'],
        ['a cache kill', ok({ exitCode: 1, cacheLost: 'c' }), 'the run was killed for prompt-cache loss'],
        ['a premature finish', ok({ finishReason: 'length' }), "the agent's run ended before it finished"],
    ])('runs no post-helper after %s, writing or not', async (_label, outcome, why) => {
        for (const githubWriting of [true, false]) {
            const board = stubBoard([
                { ...job(1), publish: false, helperPlans: [helperPlan({ phase: 'post', githubWriting })] },
            ]);
            const { runner, calls } = runnerWithHelper(async () => outcome, []);

            const logs: string[] = [];
            await drive({ ...board, runner, log: (m) => logs.push(m) });

            expect(calls).toEqual([]);
            expect(board.board.githubAsks).toEqual([]);
            expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
            expect(logs).toContain(`job ${job(1).id}: post-run helpers skipped — ${why}`);
        }
    });

    it('still runs a post-helper over a clean run whose gate failed', async () => {
        const board = stubBoard([{ ...gatedJob(1), helperPlans: [helperPlan({ phase: 'post' })] }]);
        const stack = stubGateStack({ test: 1 });
        const { runner, calls } = runnerWithHelper(async () => ok(), [{ ok: true, output: null }]);

        await drive({ ...board, runner, gates: stack.gates });

        expect(calls).toHaveLength(1);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'gate' });
    });

    it('a succeeding post-helper does not disturb an otherwise-succeeded verdict', async () => {
        const board = stubBoard([{ ...job(1), helperPlans: [helperPlan({ phase: 'post' })] }]);
        const { runner, calls } = runnerWithHelper(async () => ok(), [{ ok: true, output: { fine: true } }]);

        await drive({ ...board, runner });

        expect(calls).toHaveLength(1);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('pays no helper work at all for a job with no declared plans', async () => {
        const board = stubBoard([job(1)]);
        // The stub's runHelper throws: a call would fail the job.
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('stands a job down while a pre-helper is still running, without launching the agent', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }], options);
        const runCalls: string[] = [];
        const runner = stubRunner(async (helperJob) => {
            runCalls.push(helperJob.id);
            throw new Error('the agent must not launch');
        });
        const released: string[] = [];
        runner.releaseFence = async (fencedJob) => {
            released.push(fencedJob.id);
        };
        let seen: AbortSignal | undefined;
        runner.runHelper = async (_job, _plan, { signal } = {}) => {
            // The stop lands while the pre-helper is in flight.
            seen = signal;
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { ok: true, output: null };
        };

        const started = drive({ ...board, runner });
        // Let the setup-poll heartbeat carry the stop in while the helper is pending.
        await new Promise((resolve) => setTimeout(resolve, 10));
        await started;

        // The helper was handed the stand-down's signal and it fired (issue #488): cancelled, not only raced.
        expect(seen?.aborted).toBe(true);
        expect(runCalls).toEqual([]);
        expect(released).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    it('releases the kubernetes checkout fence when a pre-helper fails, since no runner launches to release it', async () => {
        const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }]);
        const { runner } = runnerWithHelper(
            async () => ok(),
            [{ ok: false, reason: 'unknown_helper', message: 'nope' }]
        );
        const released: string[] = [];
        runner.releaseFence = async (fencedJob) => {
            released.push(fencedJob.id);
        };

        await drive({ ...board, runner });

        expect(released).toEqual([job(1).id]);
    });

    describe('pre-helper conclude and composite helper programs (issue #230)', () => {
        it('completes the job succeeded exactly once when a pre-helper concludes, never launching the agent', async () => {
            const runCalls: string[] = [];
            const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }]);
            const { runner, calls } = runnerWithHelper(
                async (helperJob) => {
                    runCalls.push(helperJob.id);
                    return ok();
                },
                [{ ok: true, output: { decided: 'up-to-date' }, control: 'conclude' }]
            );
            // A conclusion is a setup refusal like any other, and no runner is coming to release
            // the checkout claim (issue #469).
            const released: string[] = [];
            runner.releaseFence = async (fencedJob) => {
                released.push(fencedJob.id);
            };

            await drive({ ...board, runner });

            expect(calls).toHaveLength(1);
            expect(runCalls).toEqual([]);
            expect(released).toEqual([job(1).id]);
            expect(board.board.completed).toEqual([
                {
                    id: job(1).id,
                    status: 'succeeded',
                    exitCode: 0,
                    output: JSON.stringify({ decided: 'up-to-date' }),
                },
            ]);
        });

        // Issue #503: a fresh-session node that concludes started no conversation, so none is reported.
        it('reports no session for a fresh-session claim a pre-helper concludes', async () => {
            const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }]);
            const { runner } = runnerWithHelper(
                async () => ok(),
                [{ ok: true, output: 'MERGE-REBASED', control: 'conclude' }]
            );

            await drive({ ...board, runner });

            expect(board.board.sessions).toEqual([]);
            expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', output: 'MERGE-REBASED' });
        });

        it('a pre-helper answering control: "continue" explicitly runs the agent, same as answering none at all', async () => {
            const board = stubBoard([{ ...job(1), helperPlans: [helperPlan()] }]);
            const { runner, calls } = runnerWithHelper(
                async () => ok(),
                [{ ok: true, output: null, control: 'continue' }]
            );

            await drive({ ...board, runner });

            expect(calls).toHaveLength(1);
            expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', exitCode: 0 });
        });

        it('a concluding pre-helper skips every later declared pre-plan', async () => {
            const board = stubBoard([
                { ...job(1), helperPlans: [helperPlan({ input: 'first' }), helperPlan({ input: 'second' })] },
            ]);
            const { runner, calls } = runnerWithHelper(
                async () => ok(),
                [{ ok: true, output: null, control: 'conclude' }]
            );

            await drive({ ...board, runner });

            expect(calls).toHaveLength(1);
            expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        });

        it('a post-helper reporting "conclude" fails the verdict with invalid_control and skips publish', async () => {
            const board = stubBoard([
                { ...job(1), repo: 'Bellows-AI/bellows', helperPlans: [helperPlan({ phase: 'post' })] },
            ]);
            const { runner } = runnerWithHelper(async () => ok(), [{ ok: true, output: null, control: 'conclude' }]);
            runner.publishGit = async (publishedJob) => {
                runner.published.push(publishedJob);
                return {
                    ok: true,
                    published: true,
                    branch: 'fix/1',
                    prUrl: 'https://github.com/o/r/pull/1',
                    reason: null,
                    cause: null,
                    repository: 'o/r',
                    baseBranch: 'main',
                    prNumber: 1,
                };
            };

            await drive({ ...board, runner });

            expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
            expect(board.board.completed[0]!.output).toContain('only valid for a pre-run helper');
            expect(runner.published).toEqual([]);
        });

        it('sequences a declared composite plan over its child script steps, propagating output between them', async () => {
            const board = stubBoard([{ ...job(1), helperPlans: [helperPlan({ helperId: 'sequence-fixture' })] }]);
            const { runner, calls } = runnerWithHelper(
                async () => ok(),
                [
                    { ok: true, output: { echoed: 'first' } },
                    { ok: true, output: { echoed: 'second' } },
                ]
            );

            await drive({ ...board, runner });

            expect(calls).toHaveLength(2);
            expect(calls[0]!.plan.helperId).toBe('noop');
            expect(calls[0]!.plan.input).toEqual({ step: 0, seed: null });
            expect(calls[1]!.plan.helperId).toBe('noop');
            expect(calls[1]!.plan.input).toEqual({ step: 1, receivedFromStep0: { echoed: 'first' } });
            expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        });

        it("a composite's own finalize decides conclude vs. continue from its declared input", async () => {
            const concludingBoard = stubBoard([
                { ...job(1), helperPlans: [helperPlan({ helperId: 'sequence-fixture', input: { conclude: true } })] },
            ]);
            const { runner: concludingRunner } = runnerWithHelper(
                async () => ok(),
                [
                    { ok: true, output: null },
                    { ok: true, output: null },
                ]
            );
            await drive({ ...concludingBoard, runner: concludingRunner });
            expect(concludingBoard.board.completed[0]).toMatchObject({ status: 'succeeded', exitCode: 0 });

            const continuingBoard = stubBoard([
                { ...job(2), helperPlans: [helperPlan({ helperId: 'sequence-fixture', input: { conclude: false } })] },
            ]);
            const runCalls: string[] = [];
            const { runner: continuingRunner } = runnerWithHelper(
                async (helperJob) => {
                    runCalls.push(helperJob.id);
                    return ok();
                },
                [
                    { ok: true, output: null },
                    { ok: true, output: null },
                ]
            );
            await drive({ ...continuingBoard, runner: continuingRunner });
            expect(runCalls).toEqual([job(2).id]);
        });

        it("propagates a composite child's own failure reason unchanged, and never runs the following child", async () => {
            const board = stubBoard([{ ...job(1), helperPlans: [helperPlan({ helperId: 'sequence-fixture' })] }]);
            const { runner, calls } = runnerWithHelper(
                async () => ok(),
                [{ ok: false, reason: 'timeout', message: 'the child ran out of time' }]
            );

            await drive({ ...board, runner });

            expect(calls).toHaveLength(1);
            expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
            expect(board.board.completed[0]!.output).toContain('timeout');
            expect(board.board.completed[0]!.output).toContain('the child ran out of time');
        });

        it('stands the job down between composite child steps, without ever running the second child or the agent', async () => {
            const options: { cancelRequested?: boolean } = {};
            const board = stubBoard(
                [{ ...job(1), helperPlans: [helperPlan({ helperId: 'sequence-fixture' })] }],
                options
            );
            const runCalls: string[] = [];
            const runner = stubRunner(async (helperJob) => {
                runCalls.push(helperJob.id);
                throw new Error('the agent must not launch');
            });
            const released: string[] = [];
            runner.releaseFence = async (fencedJob) => {
                released.push(fencedJob.id);
            };
            const childCalls: HelperPlan[] = [];
            runner.runHelper = async (_helperJob, plan) => {
                childCalls.push(plan);
                // The stop lands while the FIRST child is in flight.
                options.cancelRequested = true;
                await new Promise((resolve) => setTimeout(resolve, 30));
                return { ok: true, output: null };
            };

            const started = drive({ ...board, runner });
            await new Promise((resolve) => setTimeout(resolve, 10));
            await started;

            expect(childCalls).toHaveLength(1);
            expect(runCalls).toEqual([]);
            expect(released).toEqual([job(1).id]);
            expect(board.board.suspended).toEqual([job(1).id]);
            expect(board.board.completed).toEqual([]);
        });

        it('fails closed as invalid_composite_plan when the declared plan itself claims githubWriting, before any child runs', async () => {
            const board = stubBoard([
                { ...job(1), helperPlans: [helperPlan({ helperId: 'sequence-fixture', githubWriting: true })] },
            ]);
            const { runner, calls } = runnerWithHelper(async () => ok(), []);

            await drive({ ...board, runner });

            expect(calls).toEqual([]);
            expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
            expect(board.board.completed[0]!.output).toContain('invalid_composite_plan');
        });

        it("asks the board for no token at all when neither of a composite's declared steps writes to GitHub", async () => {
            // sequence-fixture's own two steps both declare githubWriting: false — each child call
            // still goes through the SAME per-child token-minting closure a plain plan's single call
            // does (pinned by "asks the board for a fresh install token…" above), so a composite whose
            // steps are all read-only asks the board for nothing, exactly like a read-only plain plan.
            const board = stubBoard(
                [{ ...job(1), publish: false, helperPlans: [helperPlan({ helperId: 'sequence-fixture' })] }],
                {
                    githubToken: 'fresh-install-token',
                }
            );
            const { runner, calls } = runnerWithHelper(
                async () => ok(),
                [
                    { ok: true, output: null },
                    { ok: true, output: null },
                ]
            );

            await drive({ ...board, runner });

            expect(board.board.githubAsks).toEqual([]);
            expect(calls.map((c) => c.token)).toEqual([undefined, undefined]);
        });
    });
});

describe('the output pump snapshot', () => {
    /**
     * The timeout note's active/idle verdict keys on the age of the last CHANGED tail (issue
     * #339). A runner that re-pushes the same tail — kubernetes's repeated identical log polls —
     * must not fake freshness: only a changed tail stamps the pump, and the activity line is the
     * newest tail's last non-empty line.
     */
    it('stamps lastOutputAt only when the tail changes, and derives the activity line', async () => {
        const board = stubBoard([]);
        const runner = stubRunner(async () => ok());
        const rt: LoopRuntime = {
            board: board.board,
            runner,
            config: config(),
            log: () => {},
            sleep,
            reclaims: new Map(),
            report: async () => 'held',
        };
        const state = newJobState();
        // Only Date is faked: the stamp is Date.now(), and the clock must move between pushes
        // by the test's say, not the wall clock's. The pump's own sleep stays real.
        vi.useFakeTimers({ toFake: ['Date'] });
        const pump = watchOutput(rt, job(1), state);
        try {
            expect(pump.snapshot().lastOutputAt).toBeNull();
            expect(pump.snapshot().activity).toBeNull();

            vi.setSystemTime(1_000);
            pump.push('$ npm test');
            expect(pump.snapshot().lastOutputAt).toBe(1_000);
            expect(pump.snapshot().activity).toBe('$ npm test');

            // The same tail again — a re-poll, not progress. The stamp must not move.
            vi.setSystemTime(2_000);
            pump.push('$ npm test');
            expect(pump.snapshot().lastOutputAt).toBe(1_000);

            vi.setSystemTime(3_000);
            pump.push('$ npm run lint\n');
            expect(pump.snapshot().lastOutputAt).toBe(3_000);
            expect(pump.snapshot().activity).toBe('$ npm run lint');
        } finally {
            vi.useRealTimers();
            transition(state, 'ended');
            state.wake();
        }
    });
});
