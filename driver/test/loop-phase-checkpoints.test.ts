/**
 * Issue #829 (G6): the post-run phases — gates, post-run helpers, publish — leave a phase
 * checkpoint on the board, and an attempt that adopts a finished runner or takes a live one over
 * resumes after the last phase that finished instead of running every one again. An unconfirmed
 * read is never an empty one: any checkpoint the driver cannot vouch for runs its phase again.
 */
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import type { PhaseCheckpoint } from '../src/board-phase-checkpoints.js';
import type { HelperPlan } from '../src/helpers.js';
import type { PublishResult } from '../src/publish.js';
import type { AdoptedRun, LiveRun } from '../src/runner.js';
import { drive, gatedJob, ok, stubBoard, stubGateStack, stubRunner } from './fixtures/loop-stubs.js';

const TREE = 'h:after';
const GITHUB_TOKEN = 'ghs_stubbed_installation_token';

const postPlan: HelperPlan = { helperId: 'notify', phase: 'post', input: null, githubWriting: false };

const published: PublishResult = {
    ok: true,
    published: true,
    branch: 'fix/1',
    prUrl: 'https://github.com/o/r/pull/9',
    reason: null,
    cause: null,
    repository: 'o/r',
    baseBranch: 'main',
    prNumber: 9,
};

const gatesResult = {
    failure: null,
    deadServices: [],
    gatesSkipped: null,
    recoveredServices: [],
};
const gatesCp = (over: Partial<PhaseCheckpoint> = {}): PhaseCheckpoint => ({
    phase: 'gates',
    claimSeq: 1,
    tree: TREE,
    result: gatesResult,
    ...over,
});
const postCp = (over: Partial<PhaseCheckpoint> = {}): PhaseCheckpoint => ({
    phase: 'post',
    claimSeq: 1,
    tree: null,
    result: { failure: null },
    ...over,
});
const publishCp = (over: Partial<PhaseCheckpoint> = {}): PhaseCheckpoint => ({
    phase: 'publish',
    claimSeq: 1,
    tree: null,
    result: published,
    ...over,
});

interface Scene {
    adopted?: AdoptedRun | LiveRun | null;
    checkpoints?: PhaseCheckpoint[] | null | ((signal?: AbortSignal) => Promise<PhaseCheckpoint[] | null>);
    write?: 'ok' | 'lost' | 'rejected' | 'throw';
    probeTree?: string | null;
    gated?: boolean;
    post?: boolean;
    publishResult?: PublishResult;
}

async function run(scene: Scene = {}) {
    const claimed: BoardJob = {
        ...(scene.gated === false ? { ...gatedJob(1), gates: null } : gatedJob(1)),
        attempts: 2,
        claimSeq: 3,
        ...(scene.post === false ? {} : { helperPlans: [postPlan] }),
    } as BoardJob;
    const board = stubBoard([claimed], {
        githubToken: GITHUB_TOKEN,
        phaseCheckpoints: scene.checkpoints ?? null,
        phaseCheckpointWrite: scene.write ?? 'ok',
    });
    const stack = stubGateStack({}, { control: Boolean(scene.adopted && 'live' in scene.adopted) });
    const helperRuns: string[] = [];
    const runner = stubRunner(async () => ok(), {
        sync: { ok: true, reason: null, fingerprint: 'h:before' },
        probeTree: scene.probeTree === undefined ? TREE : scene.probeTree,
        publish: scene.publishResult ?? published,
        ...(scene.adopted === undefined ? {} : { adopt: async () => scene.adopted ?? null }),
    });
    runner.runHelper = async (_job, plan) => {
        helperRuns.push(plan.helperId);
        return { ok: true, output: null };
    };
    const logs: string[] = [];
    await drive({ ...board, runner, gates: stack.gates, log: (m) => logs.push(m) });
    return { board: board.board, stack: stack.stack, runner, helperRuns, claimed, logs };
}

const adopted: AdoptedRun = { outcome: ok({ output: 'the adopted run' }), claimSeq: 1 };
const gatesRan = (r: Awaited<ReturnType<typeof run>>) => r.stack.ran.names.length > 0;

describe('resuming an adopted run from its phase checkpoints', () => {
    it('a: skips the gates a checkpoint on the same tree covers, and the verdict carries its failure', async () => {
        const failure = { name: 'test', exitCode: 1, output: 'FAIL src/a.test.ts' };
        const r = await run({
            adopted,
            checkpoints: [gatesCp({ result: { ...gatesResult, failure } })],
        });

        expect(gatesRan(r)).toBe(false);
        expect(r.board.phaseCheckpointReads).toEqual([
            { id: r.claimed.id, leaseToken: r.claimed.leaseToken, runClaimSeq: 1 },
        ]);
        expect(r.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'gate' });
        expect(r.board.completed[0]!.output).toContain('FAIL src/a.test.ts');
        expect(r.logs).toContain(`job ${r.claimed.id}: resumed gates from claim 1's checkpoint`);
    });

    it('b: runs the gates again for a checkpoint on another tree, and ignores the later phases', async () => {
        const r = await run({ adopted, checkpoints: [gatesCp({ tree: 'h:other' }), postCp(), publishCp()] });

        expect(gatesRan(r)).toBe(true);
        expect(r.helperRuns).toEqual(['notify']);
        expect(r.runner.published).toHaveLength(1);
        expect(r.board.phaseCheckpointsWritten.map((w) => [w.phase, w.tree])).toEqual([
            ['gates', TREE],
            ['post', null],
            ['publish', null],
        ]);
    });

    it('c: runs every phase when the read is unconfirmed', async () => {
        const r = await run({ adopted, checkpoints: null });

        expect(gatesRan(r)).toBe(true);
        expect(r.helperRuns).toEqual(['notify']);
        expect(r.runner.published).toHaveLength(1);
    });

    it('d: resumes after the gates and post checkpoints: only the publish runs, and writes its own', async () => {
        const r = await run({ adopted, checkpoints: [gatesCp(), postCp()] });

        expect(gatesRan(r)).toBe(false);
        expect(r.helperRuns).toEqual([]);
        expect(r.runner.published).toHaveLength(1);
        expect(r.board.phaseCheckpointsWritten.map((w) => w.phase)).toEqual(['publish']);
    });

    it('e: with all three checkpoints runs nothing and reports the checkpointed publication', async () => {
        const r = await run({ adopted, checkpoints: [gatesCp(), postCp(), publishCp()] });

        expect(gatesRan(r)).toBe(false);
        expect(r.helperRuns).toEqual([]);
        // The sync's ask remains; the publish's is the one a resumed publication never makes.
        expect(r.board.githubAsks).toHaveLength(
            (await run({ adopted, checkpoints: [gatesCp(), postCp()] })).board.githubAsks.length - 1
        );
        expect(r.runner.published).toEqual([]);
        expect(r.board.phaseCheckpointsWritten).toEqual([]);
        expect(r.board.completed[0]).toMatchObject({
            status: 'succeeded',
            publication: { repo: 'o/r', prNumber: 9, headBranch: 'fix/1', baseBranch: 'main' },
        });
    });

    it('g: a taken-over run reads with the claim sequence of the run it took over', async () => {
        const prior = { ...gatedJob(1), claimSeq: 4 } as BoardJob;
        const live: LiveRun = { live: true, prior, claimSeq: 4, session: 'sess', startedAt: 'then' };
        const r = await run({ adopted: live, checkpoints: [gatesCp({ claimSeq: 4 })] });

        expect(r.board.phaseCheckpointReads.map((x) => x.runClaimSeq)).toEqual([4]);
        expect(r.board.phaseCheckpointsWritten.every((w) => w.runClaimSeq === 4)).toBe(true);
        expect(gatesRan(r)).toBe(false);
    });

    it('j: a tree that cannot be read runs the gates, writes no gates checkpoint, and ignores the later ones', async () => {
        const r = await run({ adopted, probeTree: null, checkpoints: [gatesCp(), postCp(), publishCp()] });

        expect(gatesRan(r)).toBe(true);
        expect(r.helperRuns).toEqual(['notify']);
        expect(r.board.phaseCheckpointsWritten.map((w) => w.phase)).toEqual(['post', 'publish']);
    });

    it.each([
        ['a malformed gates result', gatesCp({ result: { failure: 'boom' } })],
        [
            'a gates result with a service missing its fields',
            gatesCp({ result: { ...gatesResult, deadServices: [{}] } }),
        ],
        ['a gates result with no skip reason field', gatesCp({ result: { failure: null } })],
    ])('runs the gates again for %s', async (_what, cp) => {
        const r = await run({ adopted, checkpoints: [cp, postCp(), publishCp()] });

        expect(gatesRan(r)).toBe(true);
        expect(r.helperRuns).toEqual(['notify']);
    });

    it('runs the publish again for a checkpoint that is not a publication', async () => {
        const r = await run({
            adopted,
            checkpoints: [gatesCp(), postCp(), publishCp({ result: { ok: true, published: 'yes' } })],
        });

        expect(r.runner.published).toHaveLength(1);
    });

    it('l: bounds the read by a signal, so a stand-down or a hung board ends it', async () => {
        const signals: (AbortSignal | undefined)[] = [];
        const r = await run({
            adopted,
            checkpoints: async (signal) => {
                signals.push(signal);
                return [gatesCp()];
            },
        });

        expect(signals).toHaveLength(1);
        expect(signals[0]).toBeInstanceOf(AbortSignal);
        expect(signals[0]!.aborted).toBe(false);
        expect(r.board.phaseCheckpointReads).toHaveLength(1);
    });
});

describe('writing the phase checkpoints', () => {
    it('f: a fresh run reads nothing and writes gates, post, publish in order under its own lease', async () => {
        const r = await run({ adopted: null });

        expect(r.board.phaseCheckpointReads).toEqual([]);
        expect(r.board.phaseCheckpointsWritten).toEqual([
            {
                id: r.claimed.id,
                leaseToken: r.claimed.leaseToken,
                runClaimSeq: 3,
                phase: 'gates',
                tree: TREE,
                result: gatesResult,
            },
            {
                id: r.claimed.id,
                leaseToken: r.claimed.leaseToken,
                runClaimSeq: 3,
                phase: 'post',
                tree: null,
                result: { failure: null },
            },
            {
                id: r.claimed.id,
                leaseToken: r.claimed.leaseToken,
                runClaimSeq: 3,
                phase: 'publish',
                tree: null,
                result: published,
            },
        ]);
    });

    it.each(['lost', 'rejected', 'throw'] as const)(
        'h: a write the board answers %s leaves the verdict unchanged',
        async (write) => {
            const r = await run({ adopted: null, write });

            expect(r.board.completed).toHaveLength(1);
            expect(r.board.completed[0]).toMatchObject({ status: 'succeeded' });
        }
    );

    it('i: a publish that did not land leaves no publish checkpoint', async () => {
        const failed: PublishResult = {
            ...published,
            ok: false,
            published: false,
            reason: 'push refused',
            cause: null,
        };
        const r = await run({ adopted: null, publishResult: failed });

        expect(r.board.phaseCheckpointsWritten.map((w) => w.phase)).toEqual(['gates', 'post']);
    });

    it('k: no checkpoint body carries the GitHub token', async () => {
        const r = await run({ adopted: null });

        expect(r.board.githubAsks.length).toBeGreaterThan(0);
        expect(JSON.stringify(r.board.phaseCheckpointsWritten)).not.toContain(GITHUB_TOKEN);
    });
});
