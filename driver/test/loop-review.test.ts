import { describe, expect, it } from 'vitest';
import type { BoardJob, HeartbeatVerdict, ReviewClaim, ReviewReport } from '../src/board.js';
import { CONTROL_TOKEN_ENV, CONTROL_URL_ENV } from '../src/claim.js';
import { newJobState } from '../src/loop-attempt.js';
import { createLoop } from '../src/loop.js';
import { cancelReviews, createReviewRelay, superviseReview } from '../src/loop-review.js';
import { StepChannelClosed } from '../src/step-control.js';
import type { StepResult } from '../src/supervisor-contract.js';
import { openRunControl } from '../src/loop-gates.js';
import { SUPERVISOR_ENV } from '../src/supervisor-contract.js';
import type { LoopRuntime } from '../src/loop-types.js';
import { config, job, ok, sleep, stubBoard, stubGateStack, stubRunner } from './fixtures/loop-stubs.js';

/**
 * What a run's control channel carries (issue #549): the question, publish and reviewer relays, and
 * how the driver supervises a review the board leased in-band (issue #774).
 */

const JOB = {
    id: '00000001-1111-4111-8111-111111111111',
    command: 'job',
    leaseToken: '00000001-2222-4222-8222-222222222222',
} as BoardJob;

function opened() {
    const calls: unknown[][] = [];
    const rt = {
        gates: {
            server: {
                listen: async () => 9099,
                openControl: (token: string, relay?: unknown, publisher?: unknown, reviewer?: unknown) => {
                    calls.push([token, relay, publisher, reviewer]);
                },
                // Recorded as the call's agent token: the fifth entry, after the supervisor's relays.
                grantAgent: (_token: string, agentToken: string) => {
                    calls[0]?.push(agentToken);
                },
                // The exporter's token: the sixth entry, after the agent's.
                grantExporter: (_token: string, exporterToken: string) => {
                    calls[0]?.push(exporterToken);
                },
            },
            advertiseUrl: (port: number) => `http://driver:${port}`,
        },
        log: () => {},
    } as unknown as LoopRuntime;
    return { rt, calls, state: newJobState() };
}

describe('openRunControl', () => {
    it('gives an ordinary attempt the question, publish and reviewer relays, and the endpoint in its env', async () => {
        const job = { ...JOB } as BoardJob;
        const { rt, calls, state } = opened();
        await openRunControl(rt, job, state);
        const [token, questions, publisher, reviewer, agentToken, exporterToken] = calls[0] as [
            string,
            object,
            object,
            { request: unknown; read: unknown },
            string,
            string,
        ];
        expect(questions).toBeDefined();
        expect(publisher).toBeDefined();
        expect(reviewer).toMatchObject({ request: expect.any(Function), read: expect.any(Function) });
        // Three tokens of one lease: the agent's rides its env beside the endpoint, the supervisor's
        // and the exporter's only the supervisor-side env — never the agent's.
        expect(new Set([token, agentToken, exporterToken]).size).toBe(3);
        expect(job.gateEnv).toMatchObject({ [CONTROL_URL_ENV]: 'http://driver:9099', [CONTROL_TOKEN_ENV]: agentToken });
        expect(job.supervisorEnv).toEqual({
            [SUPERVISOR_ENV.controlUrl]: 'http://driver:9099',
            [SUPERVISOR_ENV.controlToken]: token,
            [SUPERVISOR_ENV.exportToken]: exporterToken,
        });
        expect(JSON.stringify(job.gateEnv)).not.toContain(token);
        expect(JSON.stringify(job.gateEnv)).not.toContain(exporterToken);
        expect(state.control).toBe(token);
    });
});

const STEP = (over: Partial<StepResult> = {}): StepResult => ({
    exitCode: 0,
    stdout: 'the review text',
    stderr: '',
    timedOut: false,
    ...over,
});

const REVIEW = {
    ...job(2),
    rootJobId: job(1).id,
    reviewRun: { profile: 'security', ref: 'refs/factory/review/root/sec-1', timeoutMinutes: 5 },
} as ReviewClaim;

const REPORT = (status: ReviewReport['status']): ReviewReport => ({
    id: REVIEW.id,
    key: 'sec-1',
    profile: 'security',
    status,
    verdict: status === 'succeeded' ? 'clean' : 'none',
    revision: 'head:abc',
    findings: null,
    failureKind: null,
    evidence: { state: 'none' } as unknown as ReviewReport['evidence'],
});

/** Lets the macrotask queue turn, so a fire-and-forget supervision makes progress. */
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const until = async (done: () => boolean) => {
    for (let i = 0; i < 500 && !done(); i++) await turn();
    expect(done()).toBe(true);
};
/** Resolves with `answer` once `signal` aborts: a review step that runs until it is cancelled. */
const untilAborted = (signal: AbortSignal | undefined, answer: StepResult) =>
    new Promise<StepResult>((resolve) => signal?.addEventListener('abort', () => resolve(answer), { once: true }));

function supervising(
    options: Parameters<typeof stubRunner>[1] = {},
    boardOptions: Parameters<typeof stubBoard>[1] = {}
) {
    const board = stubBoard([], boardOptions);
    const runner = stubRunner(async () => ok(), options);
    const state = newJobState();
    const logs: string[] = [];
    const rt = {
        board: board.board,
        runner,
        config: config(),
        log: (m: string) => logs.push(m),
        sleep,
    } as unknown as LoopRuntime;
    const start = (review: ReviewClaim = REVIEW, key = 'sec-1') =>
        superviseReview(rt, state, { caller: job(1), review, key });
    const settled = () => state.reviews.get('sec-1')?.settled ?? Promise.resolve();
    return { board: board.board, runner, state, rt, logs, start, settled };
}

describe('a review the board leased in-band (issue #774)', () => {
    it('is restored and run in the caller’s group, its row heartbeat and completed with the step’s output', async () => {
        const t = supervising({ runReview: async () => STEP() });
        t.start();
        await t.settled();
        expect(t.runner.reviewerResized).toEqual(['run', 'idle']);
        expect(t.runner.reviewed).toHaveLength(1);
        expect(t.runner.reviewed[0]!.review.id).toBe(REVIEW.id);
        expect(t.runner.reviewed[0]!.session).toMatchObject({ resume: false });
        expect(t.board.sessions).toEqual([{ id: REVIEW.id, sessionId: t.runner.reviewed[0]!.session!.id }]);
        expect(t.board.completed).toEqual([
            { id: REVIEW.id, status: 'succeeded', exitCode: 0, output: 'the review text' },
        ]);
        expect(t.state.reviews.size).toBe(0);
    });

    it('heartbeats the review row under its own lease while the step runs', async () => {
        const beats: string[] = [];
        let release = (): void => {};
        const t = supervising({
            runReview: () => new Promise<StepResult>((resolve) => (release = () => resolve(STEP()))),
        });
        t.board.heartbeat = async (claimed) => {
            beats.push(claimed.id);
            return { result: 'held', cancelRequested: false };
        };
        t.start();
        await until(() => beats.length >= 2);
        release();
        await t.settled();
        expect(new Set(beats)).toEqual(new Set([REVIEW.id]));
    });

    it('resumes the session a re-leased review recorded, recording nothing new', async () => {
        const t = supervising({ runReview: async () => STEP() });
        t.start({ ...REVIEW, resumeSessionId: 'sess-prev' } as ReviewClaim);
        await t.settled();
        expect(t.runner.reviewed[0]!.session).toEqual({ id: 'sess-prev', resume: true });
        expect(t.board.sessions).toEqual([]);
    });

    it('starts one supervision per key: a retried request whose answer was lost gets no second reviewer', async () => {
        const releases: (() => void)[] = [];
        const t = supervising({
            runReview: () => new Promise<StepResult>((resolve) => releases.push(() => resolve(STEP()))),
        });
        t.start();
        t.start();
        t.start({ ...REVIEW, id: job(3).id } as ReviewClaim, 'other');
        await until(() => t.runner.reviewed.length === 2);
        for (const release of releases) release();
        await Promise.all([...t.state.reviews.values()].map((r) => r.settled));
        expect(t.runner.reviewed.map((r) => r.review.id)).toEqual([REVIEW.id, job(3).id]);
    });

    it('cancels the step when the heartbeat is refused (409), and settles the row failed', async () => {
        const t = supervising({ runReview: (_c, _r, _s, signal) => untilAborted(signal, STEP({ exitCode: 130 })) });
        t.board.heartbeat = async () => 'lost';
        t.start();
        await t.settled();
        expect(t.board.completed).toEqual([
            {
                id: REVIEW.id,
                status: 'failed',
                exitCode: null,
                output: 'the review was cancelled',
                failureKind: 'runner_error',
            },
        ]);
    });

    it('cancels the step when the board raises cancelRequested on the review row', async () => {
        const t = supervising({ runReview: (_c, _r, _s, signal) => untilAborted(signal, STEP({ exitCode: 130 })) });
        t.board.heartbeat = async () => ({ result: 'held', cancelRequested: true }) as HeartbeatVerdict;
        t.start();
        await t.settled();
        expect(t.board.completed[0]).toMatchObject({ id: REVIEW.id, status: 'failed' });
    });

    it('retries a heartbeat that errors: the review keeps running', async () => {
        let beats = 0;
        const t = supervising({
            runReview: async (_c, _r, _s, signal) => {
                await until(() => beats >= 3);
                expect(signal?.aborted).toBe(false);
                return STEP();
            },
        });
        t.board.heartbeat = async () => {
            beats += 1;
            if (beats < 3) throw new Error('board unreachable');
            return { result: 'held', cancelRequested: false };
        };
        t.start();
        await t.settled();
        expect(t.board.completed[0]).toMatchObject({ id: REVIEW.id, status: 'succeeded' });
    });

    it('fails the review row with `timeout` when the step times out, leaving the caller untouched', async () => {
        const t = supervising({
            runReview: async () => STEP({ exitCode: 124, timedOut: true, stdout: '', stderr: 'budget' }),
        });
        t.start();
        await t.settled();
        expect(t.board.completed).toEqual([
            { id: REVIEW.id, status: 'failed', exitCode: 124, output: 'budget', failureKind: 'timeout' },
        ]);
        expect(t.board.completed.map((c) => c.id)).not.toContain(job(1).id);
        expect(t.state).toMatchObject({ finished: false, lost: false, stopped: false, removed: false });
        expect(t.state.signal.aborted).toBe(false);
    });

    it('completes nothing when the supervisor was lost: that is no verdict on the review', async () => {
        const t = supervising({
            runReview: async () => {
                throw new StepChannelClosed('the review answered');
            },
        });
        t.start();
        await t.settled();
        expect(t.board.completed).toEqual([]);
        expect(t.runner.reviewerResized).toEqual(['run', 'idle']);
    });

    it('ends the row failed when the step cannot be run at all', async () => {
        const t = supervising({ runReview: async () => STEP({ exitCode: 1, stdout: '', stderr: 'no repository' }) });
        t.start();
        await t.settled();
        expect(t.board.completed[0]).toMatchObject({
            status: 'failed',
            failureKind: 'runner_error',
            output: 'no repository',
        });
    });

    it('is cancelled by the caller’s finish: the step is aborted, the row settled, the reviewer idled', async () => {
        const t = supervising({ runReview: (_c, _r, _s, signal) => untilAborted(signal, STEP({ exitCode: 130 })) });
        t.start();
        await until(() => t.runner.reviewed.length === 1);
        await cancelReviews(t.state);
        expect(t.board.completed).toEqual([
            {
                id: REVIEW.id,
                status: 'failed',
                exitCode: null,
                output: 'the review was cancelled',
                failureKind: 'runner_error',
            },
        ]);
        expect(t.runner.reviewerResized).toEqual(['run', 'idle']);
        expect(t.state.reviews.size).toBe(0);
    });

    it('is cancelled by the caller standing down', async () => {
        const t = supervising({ runReview: (_c, _r, _s, signal) => untilAborted(signal, STEP({ exitCode: 130 })) });
        t.start();
        await until(() => t.runner.reviewed.length === 1);
        t.state.abortNow();
        await t.settled();
        expect(t.board.completed[0]).toMatchObject({ id: REVIEW.id, status: 'failed' });
    });
});

describe('the review relay, asked for a review the board answers without a claim', () => {
    it('starts nothing for an existing review', async () => {
        const t = supervising({ probeTree: 'head:abc', runReview: async () => STEP() });
        t.runner.snapshotTree = async () => ({ ok: true, ref: REVIEW.reviewRun.ref });
        t.board.requestReview = async () => ({ result: 'ok', review: REPORT('succeeded'), created: false });
        const verdict = await createReviewRelay(t.rt, job(1), t.state).request('sec-1', 'security');
        expect(verdict).toMatchObject({ created: false });
        expect(t.state.reviews.size).toBe(0);
        expect(t.runner.reviewed).toEqual([]);
    });

    it('starts the supervision for a created review, answered with its claim', async () => {
        const t = supervising({ probeTree: 'head:abc', runReview: async () => STEP() });
        t.runner.snapshotTree = async () => ({ ok: true, ref: REVIEW.reviewRun.ref });
        t.board.requestReview = async () => ({ result: 'ok', review: REPORT('running'), created: true, claim: REVIEW });
        await createReviewRelay(t.rt, job(1), t.state).request('sec-1', 'security');
        await t.settled();
        expect(t.runner.reviewed.map((r) => r.review.id)).toEqual([REVIEW.id]);
    });
});

describe('concurrency 1: a caller that waits on its review', () => {
    it('completes: the review runs in the caller’s group, not through a second slot', async () => {
        const caller = job(1);
        const board = stubBoard([caller, REVIEW]);
        const { stack, gates } = stubGateStack({}, { control: true });
        const reviewDone = () => board.board.completed.some((c) => c.id === REVIEW.id);
        board.board.requestReview = async () => ({
            result: 'ok',
            review: REPORT('running'),
            created: true,
            claim: REVIEW,
        });
        board.board.readReview = async () => ({
            result: 'ok',
            review: REPORT(reviewDone() ? 'succeeded' : 'running'),
            created: false,
        });
        const runner = stubRunner(
            async (running) => {
                if (running.id !== caller.id) return ok();
                const relay = stack.controls.get(running.gateEnv?.BELLOWS_CONTROL_TOKEN ?? '')?.reviewer;
                if (!relay) throw new Error('no reviewer relay on the control entry');
                await relay.request('sec-1', 'security');
                // A bounded wait on the board's own word, on a clock of macrotasks.
                for (let i = 0; i < 200; i++) {
                    const verdict = await relay.read('sec-1');
                    if (typeof verdict === 'object' && 'review' in verdict && verdict.review.status !== 'running') {
                        return ok();
                    }
                    await turn();
                }
                throw new Error('the review never ran');
            },
            { probeTree: 'head:abc', runReview: async () => STEP() }
        );
        runner.snapshotTree = async () => ({ ok: true, ref: REVIEW.reviewRun.ref });
        const loop = createLoop({
            board: board.board,
            runner,
            config: config({ DRIVER_CONCURRENCY: '1' }),
            gates,
            sleep,
        });
        board.attach(loop);
        await loop.start();

        expect(board.board.completed.find((c) => c.id === caller.id)?.status).toBe('succeeded');
        expect(runner.reviewed.map((r) => r.review.id)).toEqual([REVIEW.id]);
    });
});
