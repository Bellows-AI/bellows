/**
 * `adoptStep` and `recordAdopted` driven directly: what the step answers for each way
 * `Runner.adopt` can come back, which flags it leaves on the attempt, and what it hands back to the
 * fence when the attempt stood down while the adoption was still reading. The adoption through the
 * claim loop is `loop/`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { newJobState } from '../src/loop/loop-attempt.js';
import { adoptStep, recordAdopted } from '../src/loop/loop-adopt.js';
import { type AttemptCtx, STOOD_DOWN } from '../src/loop/loop-types.js';
import { type AdoptedRun, AdoptionBlocked, LeftoverTerminating, type LiveRun, type Read } from '../src/runner.js';
import { SUPERVISOR_ENV, SUPERVISOR_REBIND_DELIVERY_MS } from '../src/supervisor-contract.js';
import { runJob } from '../src/loop/loop-run.js';
import { createStepBroker } from '../src/step-control.js';
import { job, ok, stubBoard, stubGateStack, stubRunner, stubRuntime } from './fixtures/loop-stubs.js';

const adopted: AdoptedRun = { outcome: ok(), claimSeq: 4 };

function setup(claimed: BoardJob, adopt: (j: BoardJob, signal?: AbortSignal) => Promise<AdoptedRun | LiveRun | null>) {
    const board = stubBoard([]).board;
    const runner = stubRunner(async () => ok(), { adopt });
    const released: string[] = [];
    (runner as { releaseFence?: (j: BoardJob) => Promise<void> }).releaseFence = async (j) => {
        released.push(j.id);
    };
    const logs: string[] = [];
    const rt = stubRuntime(board, runner, { log: (m) => logs.push(m) });
    const state = newJobState();
    const ctx: AttemptCtx = {
        rt,
        job: claimed,
        state,
        quiesce: async () => {},
        fenced: false,
        treeBefore: null,
        session: null,
    };
    return { ctx, board, released, logs, state };
}

const until = async (done: () => boolean) => {
    while (!done()) await tick();
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('adoptStep', () => {
    it('adopts nothing for an agent-less node, and never asks the runner', async () => {
        let asked = 0;
        const s = setup({ ...job(1), agent: false }, async () => {
            asked += 1;
            return adopted;
        });

        expect(await adoptStep(s.ctx)).toBeNull();
        expect(asked).toBe(0);
    });

    it('answers null, leaving the attempt unmarked, when there is no earlier run', async () => {
        const s = setup(job(1), async () => null);

        expect(await adoptStep(s.ctx)).toBeNull();
        expect(s.ctx.adopted).toBeUndefined();
        expect(s.ctx.fenced).toBe(false);
    });

    it('answers an interruption record and marks the attempt adopted and fenced, calling no board', async () => {
        const s = setup(job(1), async () => adopted);

        const answer = await adoptStep(s.ctx);

        expect(answer).toMatchObject({ record: 'interruption', claimSeq: 4 });
        expect(s.ctx.adopted).toBe(adopted);
        expect(s.ctx.fenced).toBe(true);
        expect(s.board.interrupted).toEqual([]);
        expect(s.board.completed).toEqual([]);
    });

    it('leaves the job to its lease when the run was read but could not be secured', async () => {
        const s = setup(job(1), async () => {
            throw new AdoptionBlocked('the claim moved');
        });

        const answer = await adoptStep(s.ctx);

        expect(answer).toMatchObject({ halt: 'leave' });
        expect(s.ctx.adopted).toBeUndefined();
    });

    it('answers a blocked interruption, keeping the group, when the adoption meets a terminating leftover', async () => {
        const s = setup(job(1), async () => {
            throw new LeftoverTerminating('the leftover pod p on node n is still terminating after its delete');
        });

        const answer = await adoptStep(s.ctx);

        expect(answer).toEqual({
            halt: 'interrupt',
            reason: 'the claim waits for a leftover still terminating: the leftover pod p on node n is still terminating after its delete',
            refused: true,
            blocked: true,
        });
        expect(s.state.keepGroup).toBe(true);
        expect(s.released).toEqual([]);
        expect(s.ctx.adopted).toBeUndefined();
    });

    it('leaves the job to its lease when the earlier run could not be read at all', async () => {
        const s = setup(job(1), async () => {
            throw new Error('apiserver said 503');
        });

        const answer = await adoptStep(s.ctx);

        expect(answer).toMatchObject({ halt: 'leave' });
        expect(s.ctx.adopted).toBeUndefined();
        expect(s.ctx.fenced).toBe(false);
    });

    it('syncs and runs nothing after an unreadable earlier run: no sweep follows', async () => {
        const board = stubBoard([]).board;
        const runner = stubRunner(async () => ok(), {
            adopt: async () => {
                throw new Error('apiserver said 503');
            },
        });
        await runJob(stubRuntime(board, runner), job(1));

        expect(runner.synced).toEqual([]);
        expect(board.sessions).toEqual([]);
        expect(board.completed).toEqual([]);
    });

    it('answers a stand-down when the attempt stood down mid-adoption', async () => {
        const s = setup(job(1), () => new Promise(() => {}));

        const pending = adoptStep(s.ctx);
        s.state.abortNow();

        expect(await pending).toBe(STOOD_DOWN);
    });

    it('hands the fence back exactly once when an abandoned adoption lands a run', async () => {
        let land: (run: AdoptedRun | null) => void = () => {};
        const s = setup(job(1), () => new Promise((resolve) => (land = resolve)));

        const pending = adoptStep(s.ctx);
        s.state.abortNow();
        await pending;
        land(adopted);
        await tick();

        expect(s.released).toEqual([job(1).id]);
    });

    it('releases nothing when an abandoned adoption lands no run', async () => {
        let land: (run: AdoptedRun | null) => void = () => {};
        const s = setup(job(1), () => new Promise((resolve) => (land = resolve)));

        const pending = adoptStep(s.ctx);
        s.state.abortNow();
        await pending;
        land(null);
        await tick();

        expect(s.released).toEqual([]);
    });

    it('swallows the rejection of an abandoned adoption', async () => {
        let fail: (e: Error) => void = () => {};
        const s = setup(job(1), () => new Promise((_, reject) => (fail = reject)));

        const pending = adoptStep(s.ctx);
        s.state.abortNow();
        await pending;
        fail(new Error('late'));
        await tick();

        expect(s.released).toEqual([]);
    });
});

describe('recordAdopted', () => {
    it('reports the earlier claim as an interruption under this lease, releasing nothing', async () => {
        const s = setup(job(1), async () => null);

        await recordAdopted(s.ctx, { record: 'interruption', reason: 'adopted claim 4', claimSeq: 4 });

        expect(s.board.interrupted).toEqual([
            { id: job(1).id, reason: 'adopted claim 4', release: false, claimSeq: 4 },
        ]);
    });

    it('logs a board that throws and still resolves', async () => {
        const s = setup(job(1), async () => null);
        s.board.interrupt = async () => {
            throw new Error('board unreachable');
        };

        await expect(
            recordAdopted(s.ctx, { record: 'interruption', reason: 'adopted claim 4', claimSeq: 4 })
        ).resolves.toBeUndefined();
        expect(s.logs.some((m) => m.includes('could not record the adopted interruption: board unreachable'))).toBe(
            true
        );
    });
});

describe('taking over a live run (#829)', () => {
    afterEach(() => vi.useRealTimers());

    const prior = { ...job(1), leaseToken: 'lease-prior' };
    const forget = vi.fn();
    const live: LiveRun = { live: true, prior, claimSeq: 4, session: 'sess-prior', startedAt: 'then', forget };

    function takeover(
        opts: {
            polled?: boolean;
            rebind?: () => Promise<void>;
            session?: string | null;
            serving?: () => Promise<Read<boolean>>;
            adopts?: (AdoptedRun | LiveRun | null)[];
        } = {}
    ) {
        forget.mockClear();
        vi.useFakeTimers({ toFake: ['Date'] });
        const claimed: BoardJob = {
            ...job(1),
            claimSeq: 5,
            leaseToken: 'lease-new',
            supervisorEnv: {
                [SUPERVISOR_ENV.controlUrl]: 'http://driver:1/',
                [SUPERVISOR_ENV.controlToken]: 'tok-new',
                [SUPERVISOR_ENV.agentToken]: 'tok-new-agent',
                [SUPERVISOR_ENV.exportToken]: 'tok-new-export',
            },
        };
        const adopts = [...(opts.adopts ?? [])];
        const asked: number[] = [];
        const s = setup(claimed, async () => {
            asked.push(asked.length);
            if (asked.length > 1 && adopts.length > 0) return adopts.shift() ?? null;
            return { ...live, session: opts.session === undefined ? 'sess-prior' : opts.session };
        });
        const { gates } = stubGateStack({}, { control: true, polled: opts.polled ?? true });
        s.ctx.rt = { ...s.ctx.rt, gates, sleep: async (ms) => void vi.setSystemTime(Date.now() + ms) };
        if (opts.rebind) (s.ctx.rt.runner as { rebind: unknown }).rebind = opts.rebind;
        if (opts.serving) (s.ctx.rt.runner as { supervisorServing: unknown }).supervisorServing = opts.serving;
        return { ...s, claimed, asked };
    }

    it('rebinds the prior group to this claim, then owns it only after the first poll', async () => {
        const s = takeover();

        const answer = await adoptStep(s.ctx);

        const runner = s.ctx.rt.runner as unknown as { rebound: { group: BoardJob; binding: unknown }[] };
        expect(runner.rebound).toEqual([
            {
                group: live.prior,
                binding: {
                    claimSeq: 5,
                    url: 'http://driver:1/',
                    token: 'tok-new',
                    agentToken: 'tok-new-agent',
                    exportToken: 'tok-new-export',
                    leaseToken: s.ctx.job.leaseToken,
                },
            },
        ]);
        expect(answer).toMatchObject({ record: 'interruption', claimSeq: 4 });
        expect(s.claimed.groupLease).toBe('lease-prior');
        expect(s.ctx.takeover).toMatchObject({ live: true, claimSeq: 4 });
        expect(s.ctx.adopted).toBeUndefined();
        expect(s.ctx.fenced).toBe(true);
        expect(s.state.keepGroup).toBeFalsy();
        expect(s.ctx.session).toEqual({ id: 'sess-prior', resume: true });
        expect(s.board.interrupted).toEqual([]);
    });

    it('counts a confirmed takeover as launched, so every exit before the launch retains the group', async () => {
        const s = takeover();

        await adoptStep(s.ctx);

        expect(s.state.launched).toBe(true);
    });

    /**
     * Runs a taken-over attempt through `runJob`, flipping the board's heartbeat the moment the
     * supervisor confirms the new endpoint — after the takeover counts as launched, before the launch.
     */
    async function takeoverThenBeat(beat: 'lost' | 'stop') {
        let confirmed = false;
        let verdicts = 0;
        const board = stubBoard([]).board;
        const held = board.heartbeat.bind(board);
        board.heartbeat = async (...args) => {
            if (!confirmed) return held(...args);
            verdicts += 1;
            return beat === 'lost' ? 'lost' : { result: 'held', cancelRequested: true };
        };
        // The step after the confirmation reports the interruption: hold it until a beat landed the verdict.
        const interrupt = board.interrupt.bind(board);
        board.interrupt = async (...args) => {
            await until(() => verdicts > 0);
            return interrupt(...args);
        };
        const { stack, gates } = stubGateStack({}, { control: true, polled: true });
        const polled = gates.server.controlPolled;
        gates.server.controlPolled = (token) => {
            const answer = polled(token);
            if (answer) confirmed = true;
            return answer;
        };
        const runner = stubRunner(async () => ok(), { adopt: async () => live });
        const released: string[] = [];
        (runner as { releaseFence?: (j: BoardJob) => Promise<void> }).releaseFence = async (j) => {
            released.push(j.id);
        };
        await runJob(stubRuntime(board, runner, { gates }), { ...job(1), claimSeq: 5, leaseToken: 'lease-new' });
        return { board, runner, released, stack };
    }

    it('retains a taken-over group whose lease is lost before the launch: no finish, no fence release, no hand-back', async () => {
        const t = await takeoverThenBeat('lost');

        expect(t.runner.finished).toEqual([]);
        expect(t.released).toEqual([]);
        expect(t.runner.killed).toEqual([]);
        expect(t.board.interrupted).toEqual([expect.objectContaining({ claimSeq: 4 })]);
        expect(t.board.suspended).toEqual([]);
        expect(t.board.completed).toEqual([]);
    });

    it('stops a taken-over agent on a Stop before the launch, the way a launched run is stopped', async () => {
        const t = await takeoverThenBeat('stop');

        expect(t.stack.killsRaised).toEqual(t.stack.controlOpened);
        expect(t.runner.killed).toEqual([job(1).id]);
        expect(t.board.completed).toEqual([]);
    });

    it('does not count an unconfirmed takeover as launched', async () => {
        const s = takeover({ polled: false });

        await adoptStep(s.ctx);

        expect(s.state.launched).toBe(false);
    });

    it('runs a session-less (opencode) takeover with a null session', async () => {
        const s = takeover({ session: null });

        await adoptStep(s.ctx);

        expect(s.ctx.session).toBeNull();
        expect(s.claimed.groupLease).toBe('lease-prior');
    });

    it('leaves the group to the lease when the rebind is rejected, owning nothing', async () => {
        const s = takeover({ rebind: async () => Promise.reject(new Error('binding refused')) });

        const answer = await adoptStep(s.ctx);

        expect(answer).toMatchObject({ halt: 'leave' });
        expect(s.claimed.groupLease).toBeUndefined();
        expect(s.state.keepGroup).toBe(true);
        expect(s.ctx.fenced).toBe(false);
    });

    it('leaves the group to the lease when the supervisor never polls within the delivery bound', async () => {
        const s = takeover({ polled: false });
        const started = Date.now();

        const answer = await adoptStep(s.ctx);

        expect(answer).toMatchObject({ halt: 'leave' });
        expect(Date.now() - started).toBeGreaterThan(SUPERVISOR_REBIND_DELIVERY_MS - 10_000);
        expect(s.claimed.groupLease).toBeUndefined();
        expect(s.state.keepGroup).toBe(true);
    });

    it('stands down mid-delivery keeping the group, never owning it', async () => {
        const s = takeover({ polled: false });
        s.ctx.rt = {
            ...s.ctx.rt,
            sleep: async (ms) => {
                vi.setSystemTime(Date.now() + ms);
                s.state.abortNow();
            },
        };

        const answer = await adoptStep(s.ctx);

        expect(answer).toBe(STOOD_DOWN);
        expect(s.claimed.groupLease).toBeUndefined();
        expect(s.state.keepGroup).toBe(true);
    });

    describe('an earlier group found finished while the rebind is awaited (#928)', () => {
        const ended = { outcome: ok(), claimSeq: 4 } satisfies AdoptedRun;

        it.each([
            ['stopped serving', { kind: 'value', value: false }],
            ['confirmed gone', { kind: 'absent' }],
        ] as [string, Read<boolean>][])(
            'adopts the finished runner once the supervisor is %s, not at the bound',
            async (_n, read) => {
                const s = takeover({ polled: false, serving: async () => read, adopts: [ended] });
                const started = Date.now();

                const answer = await adoptStep(s.ctx);

                expect(answer).toMatchObject({ record: 'interruption', claimSeq: 4 });
                expect(Date.now() - started).toBeLessThan(SUPERVISOR_REBIND_DELIVERY_MS / 2);
                expect(s.asked).toHaveLength(2);
                expect(forget).toHaveBeenCalledTimes(1);
                expect(s.ctx.adopted).toBe(ended);
                expect(s.ctx.takeover).toBeUndefined();
                expect(s.ctx.fenced).toBe(true);
                expect(s.claimed.groupLease).toBeUndefined();
                expect(s.state.keepGroup).toBeFalsy();
                expect(s.state.launched).toBe(false);
            }
        );

        it('lets the claim redo the task when the second adoption finds nothing to adopt', async () => {
            const s = takeover({ polled: false, serving: async () => ({ kind: 'absent' }), adopts: [null] });

            expect(await adoptStep(s.ctx)).toBeNull();
            expect(forget).toHaveBeenCalledTimes(1);
            expect(s.ctx.takeover).toBeUndefined();
            expect(s.state.keepGroup).toBeFalsy();
        });

        it('leaves it to the lease, without a third adoption, when the second adoption answers live again', async () => {
            const s = takeover({
                polled: false,
                serving: async () => ({ kind: 'value', value: false }),
                adopts: [live],
            });

            const answer = await adoptStep(s.ctx);

            expect(answer).toMatchObject({ halt: 'leave' });
            expect(s.asked).toHaveLength(2);
            expect(forget).toHaveBeenCalledTimes(2);
            expect(s.claimed.groupLease).toBeUndefined();
            expect(s.state.keepGroup).toBe(true);
            expect(s.ctx.fenced).toBe(false);
        });

        it('keeps waiting the whole bound on reads that prove nothing, then leaves', async () => {
            const s = takeover({
                polled: false,
                serving: async () => ({ kind: 'inconclusive', reason: 'the apiserver did not answer' }),
            });
            const started = Date.now();

            const answer = await adoptStep(s.ctx);

            expect(answer).toMatchObject({ halt: 'leave' });
            expect(Date.now() - started).toBeGreaterThan(SUPERVISOR_REBIND_DELIVERY_MS - 10_000);
            expect(s.asked).toHaveLength(1);
            expect(forget).not.toHaveBeenCalled();
            expect(s.state.keepGroup).toBe(true);
        });

        it("hands every probe the wait's deadline and the attempt's stand-down", async () => {
            const bounds: { deadline: number; signal?: AbortSignal | undefined }[] = [];
            const s = takeover({
                polled: false,
                serving: vi.fn(async (_group: BoardJob, bound: { deadline: number; signal?: AbortSignal }) => {
                    bounds.push(bound);
                    return { kind: 'value', value: true } as Read<boolean>;
                }) as never,
            });

            await adoptStep(s.ctx);

            expect(bounds.length).toBeGreaterThan(1);
            for (const bound of bounds) {
                expect(bound.signal).toBe(s.state.signal);
            }
            expect(new Set(bounds.map((bound) => bound.deadline)).size).toBe(1);
        });

        it('keeps waiting the whole bound when the probe itself throws', async () => {
            const s = takeover({ polled: false, serving: async () => Promise.reject(new Error('boom')) });

            expect(await adoptStep(s.ctx)).toMatchObject({ halt: 'leave' });
            expect(s.asked).toHaveLength(1);
            expect(forget).not.toHaveBeenCalled();
        });

        it('stands down when the attempt is stopped during the probe, adopting nothing again', async () => {
            const s = takeover({
                polled: false,
                serving: async () => {
                    s.state.abortNow();
                    return { kind: 'value', value: false };
                },
            });

            expect(await adoptStep(s.ctx)).toBe(STOOD_DOWN);
            expect(s.asked).toHaveLength(1);
            expect(forget).not.toHaveBeenCalled();
            expect(s.state.keepGroup).toBe(true);
        });
    });

    it('leaves a takeover it cannot deliver without a run-control endpoint', async () => {
        const s = takeover();
        const { gates: _gates, ...withoutGates } = s.ctx.rt;
        s.ctx.rt = withoutGates;

        expect(await adoptStep(s.ctx)).toMatchObject({ halt: 'leave' });
        expect(s.claimed.groupLease).toBeUndefined();
    });

    it('runs the taken-over agent through runJob: no sync, no new session, the run resumes under the prior lease', async () => {
        const { gates } = stubGateStack({}, { control: true, polled: true });
        const board = stubBoard([]).board;
        const runs: { job: BoardJob; session: unknown }[] = [];
        const runner = stubRunner(
            async (j, session) => {
                runs.push({ job: j, session });
                return ok();
            },
            { adopt: async () => live }
        );

        await runJob(stubRuntime(board, runner, { gates }), { ...job(1), claimSeq: 5, leaseToken: 'lease-new' });

        expect(runner.synced).toEqual([]);
        expect(board.sessions).toEqual([]);
        expect(runs).toHaveLength(1);
        expect(runs[0]?.job.groupLease).toBe('lease-prior');
        expect(runs[0]?.session).toEqual({ id: 'sess-prior', resume: true });
        expect(board.interrupted).toEqual([expect.objectContaining({ release: false, claimSeq: 4 })]);
    });

    // The agent exited, its supervisor served on: the report reached this holder's endpoint before the loop's
    // first contact check. The takeover reads it as contact and the run is over at once.
    it('carries a report buffered before first contact into the verdict, re-attaching nothing', async () => {
        const broker = createStepBroker();
        const buffered = {
            id: 'r1',
            outcome: 'success',
            cause: null,
            agentExit: 0,
            agentEnd: 'exited',
            drained: true,
            serving: true,
        };
        const attached: string[] = [];
        const { gates } = stubGateStack({}, { control: true });
        // The supervisor's report lands on the loop's token before the loop first looks for contact.
        gates.server.controlPolled = (t) => {
            if (!broker.has(t)) {
                broker.open(t);
                broker.attach(t);
                expect(broker.report(t, buffered)).toBe('accepted');
                const attach = broker.attach.bind(broker);
                broker.attach = (a) => {
                    attached.push(a);
                    attach(a);
                };
            }
            return broker.contacted(t);
        };
        let verdict: unknown;
        const board = stubBoard([]).board;
        const runner = stubRunner(
            async (j) => {
                verdict = await broker.awaitReport(j.supervisorEnv?.[SUPERVISOR_ENV.controlToken] ?? '');
                return ok();
            },
            { adopt: async () => live }
        );
        const rt = stubRuntime(board, runner, { gates });

        await runJob(rt, { ...job(1), claimSeq: 5, leaseToken: 'lease-new' });

        expect(verdict).toEqual(buffered);
        expect(attached).toEqual([]);
        expect(runner.synced).toEqual([]);
    });
});
