/**
 * Issue #829 (G6): the post-run phases — gates, post-run helpers, publish — leave a phase
 * checkpoint on the board, and an attempt that adopts a finished runner or takes a live one over
 * resumes after the last phase that finished instead of running every one again. An unconfirmed
 * read is never an empty one: any checkpoint the driver cannot vouch for runs its phase again.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import type { GateRun } from '../src/gates.js';
import type { PhaseCheckpoint } from '../src/board/board-phase-checkpoints.js';
import { PHASE_CHECKPOINT_READ_MS } from '../src/loop/loop-phase-checkpoints.js';
import type { HelperPlan } from '../src/helpers.js';
import type { PublishResult } from '../src/publish/publish.js';
import type { AdoptedRun, DeadService, LiveRun } from '../src/runner.js';
import { drive, gatedJob, ok, stubBoard, stubGateStack, stubRunner } from './fixtures/loop-stubs.js';

const TREE = 'h:after';
const deadMongo: DeadService = {
    name: 'test-mongo',
    image: 'mongo:8.0.11',
    state: 'failed',
    exitCode: 1,
    reason: 'Error',
    logTail: 'killed',
};
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

const passedReports = [
    { name: 'test', status: 'passed', exitCode: 0, output: 'test ok' },
    { name: 'lint', status: 'passed', exitCode: 0, output: 'lint ok' },
];
const gatesResult = {
    failure: null,
    deadServices: [],
    gatesSkipped: null,
    recoveredServices: [],
    reports: passedReports,
    setupCleared: true,
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
    result: { published, revision: null },
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
    leaseGone?: () => boolean;
    setupFailure?: BoardJob['setupFailure'];
    probe?: (signal: AbortSignal) => Promise<string | null>;
    policy?: BoardJob['policy'];
    deadServices?: DeadService[];
    /** A job that declares an `environment.setup` and no gates, its setup runs answered in order. */
    setupOnly?: { setups: GateRun[] };
}

async function run(scene: Scene = {}) {
    const claimed: BoardJob = {
        ...(scene.gated === false ? { ...gatedJob(1), gates: null } : gatedJob(1)),
        ...(scene.setupOnly ? { gates: { image: 'node:24', setup: 'npm ci', gates: [] } } : {}),
        attempts: 2,
        claimSeq: 3,
        ...(scene.post === false ? {} : { helperPlans: [postPlan] }),
        ...(scene.setupFailure ? { setupFailure: scene.setupFailure } : {}),
        ...(scene.policy ? { policy: scene.policy } : {}),
    } as BoardJob;
    const board = stubBoard([claimed], {
        githubToken: GITHUB_TOKEN,
        phaseCheckpoints: scene.checkpoints ?? null,
        phaseCheckpointWrite: scene.write ?? 'ok',
        ...(scene.leaseGone ? { leaseGone: scene.leaseGone } : {}),
    });
    const stack = stubGateStack({}, { control: Boolean(scene.adopted && 'live' in scene.adopted) });
    if (scene.setupOnly) {
        const answers = [...scene.setupOnly.setups];
        stack.stack.manager.runSetup = async (_key, setupOptions = {}) => {
            stack.stack.setups.push(setupOptions);
            return answers.shift() ?? null;
        };
    }
    const helperRuns: string[] = [];
    const runner = stubRunner(async () => ok(), {
        sync: { ok: true, reason: null, fingerprint: 'h:before' },
        probeTree: scene.probeTree === undefined ? TREE : scene.probeTree,
        publish: scene.publishResult ?? published,
        ...(scene.adopted === undefined ? {} : { adopt: async () => scene.adopted ?? null }),
        ...(scene.deadServices ? { deadServices: async () => scene.deadServices! } : {}),
    });
    if (scene.probe) runner.probeTree = async (_job, signal) => scene.probe!(signal as AbortSignal);
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
        const reports = [{ name: 'test', status: 'failed', exitCode: 1, output: 'FAIL src/a.test.ts' }];
        const r = await run({
            adopted,
            checkpoints: [gatesCp({ result: { ...gatesResult, failure, reports } })],
        });

        // The board's gates list was reset by this claim: the resumed phase puts the report back.
        expect(r.board.gatesReported.map((g) => g.results)).toEqual([reports]);

        expect(gatesRan(r)).toBe(false);
        expect(r.board.phaseCheckpointReads).toEqual([
            { id: r.claimed.id, leaseToken: r.claimed.leaseToken, runClaimSeq: 1 },
        ]);
        expect(r.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'gate' });
        expect(r.board.completed[0]!.output).toContain('FAIL src/a.test.ts');
        expect(r.logs).toContain(`job ${r.claimed.id}: resumed gates from claim 1's checkpoint`);
    });

    it('a2: a resumed pass clears the setup failure the live pass would have cleared', async () => {
        const setupFailure = { exitCode: 1, output: 'npm ci failed' };
        const r = await run({ adopted, setupFailure, checkpoints: [gatesCp()] });

        expect(gatesRan(r)).toBe(false);
        expect(r.claimed.setupFailure).toBeNull();
    });

    it('a3: a checkpoint whose reports are missing or malformed runs the gates again', async () => {
        const { reports: _reports, ...withoutReports } = gatesResult;
        for (const result of [withoutReports, { ...gatesResult, reports: [{ name: 'test', status: 'weird' }] }]) {
            const r = await run({ adopted, checkpoints: [gatesCp({ result })] });
            expect(gatesRan(r)).toBe(true);
        }
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
        const live: LiveRun = {
            live: true,
            prior,
            claimSeq: 4,
            session: 'sess',
            startedAt: 'then',
            forget: () => undefined,
        };
        const r = await run({ adopted: live, checkpoints: [gatesCp({ claimSeq: 4 })] });

        expect(r.board.phaseCheckpointReads.map((x) => x.runClaimSeq)).toEqual([4]);
        expect(r.board.phaseCheckpointsWritten.every((w) => w.runClaimSeq === 4)).toBe(true);
        expect(gatesRan(r)).toBe(false);
    });

    it('j: a tree that cannot be read runs the gates, records a gates row bound to no tree, and ignores the later ones', async () => {
        const r = await run({ adopted, probeTree: null, checkpoints: [gatesCp(), postCp(), publishCp()] });

        expect(gatesRan(r)).toBe(true);
        expect(r.helperRuns).toEqual(['notify']);
        // The null-tree row never resumes, and writing it makes the board drop the stale later rows.
        expect(r.board.phaseCheckpointsWritten.map((w) => [w.phase, w.tree])).toEqual([
            ['gates', null],
            ['post', null],
            ['publish', null],
        ]);
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
            checkpoints: [
                gatesCp(),
                postCp(),
                publishCp({ result: { published: { ok: true, published: 'yes' }, revision: null } }),
            ],
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

    it('l2: a stand-down during the read ends the read and the attempt runs and writes nothing', async () => {
        let gone = false;
        const r = await run({
            adopted,
            deadServices: [deadMongo],
            leaseGone: () => gone,
            checkpoints: (signal) =>
                new Promise((resolve) => {
                    gone = true;
                    signal!.addEventListener('abort', () => resolve(null));
                }),
        });

        expect(r.stack.ran.names).toEqual([]);
        expect(r.runner.probed).toEqual([]);
        expect(r.runner.deadServiceProbes).toBe(0);
        expect(r.runner.restartedServices).toEqual([]);
        expect(r.runner.resized).toEqual([]);
        expect(r.helperRuns).toEqual([]);
        expect(r.runner.published).toEqual([]);
        expect(r.board.phaseCheckpointsWritten).toEqual([]);
        expect(r.board.completed).toEqual([]);
        expect(r.logs.some((m) => m.includes('no phase checkpoints'))).toBe(false);
    });

    it('l3: a stand-down during the tree probe runs no phase', async () => {
        let gone = false;
        const r = await run({
            adopted,
            checkpoints: [gatesCp()],
            leaseGone: () => gone,
            probe: (signal) =>
                new Promise((resolve) => {
                    gone = true;
                    signal.addEventListener('abort', () => resolve(TREE));
                }),
        });

        expect(r.board.gatesReported).toEqual([]);
        expect(r.stack.ran.names).toEqual([]);
        expect(r.helperRuns).toEqual([]);
        expect(r.runner.published).toEqual([]);
        expect(r.board.phaseCheckpointsWritten).toEqual([]);
        expect(r.board.completed).toEqual([]);
    });

    it('l3b: a stand-down during an unreadable tree probe restarts no service and runs no gate', async () => {
        let gone = false;
        const r = await run({
            adopted,
            checkpoints: null,
            deadServices: [deadMongo],
            leaseGone: () => gone,
            probe: (signal) =>
                new Promise((resolve) => {
                    gone = true;
                    signal.addEventListener('abort', () => resolve(null));
                }),
        });

        expect(r.stack.ran.names).toEqual([]);
        expect(r.runner.deadServiceProbes).toBe(0);
        expect(r.runner.restartedServices).toEqual([]);
        expect(r.runner.resized).toEqual([]);
        expect(r.helperRuns).toEqual([]);
        expect(r.runner.published).toEqual([]);
        expect(r.board.phaseCheckpointsWritten).toEqual([]);
        expect(r.board.completed).toEqual([]);
    });

    it('l4: a read that hangs is cut by the timeout signal and every phase runs', async () => {
        const timeout = new AbortController();
        const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
            return ms === PHASE_CHECKPOINT_READ_MS ? timeout.signal : new AbortController().signal;
        });
        try {
            const r = await run({
                adopted,
                checkpoints: (signal) =>
                    new Promise((resolve) => {
                        signal!.addEventListener('abort', () => resolve(null));
                        timeout.abort();
                    }),
            });

            expect(gatesRan(r)).toBe(true);
            expect(r.helperRuns).toEqual(['notify']);
            expect(r.runner.published).toHaveLength(1);
        } finally {
            spy.mockRestore();
        }
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
                result: { published, revision: null },
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

    it('m: a gates write the board did not take leaves no post or publish checkpoint behind it', async () => {
        const r = await run({ adopted: null, write: 'rejected' });

        expect(r.board.phaseCheckpointsWritten.map((w) => w.phase)).toEqual(['gates']);
        expect(r.runner.published).toHaveLength(1);
    });

    it('n: with no gates, a post write the board did not take leaves no publish checkpoint', async () => {
        const r = await run({ adopted: null, gated: false, write: 'rejected' });

        expect(r.board.phaseCheckpointsWritten.map((w) => w.phase)).toEqual(['post']);
        expect(r.runner.published).toHaveLength(1);
    });

    it('o: a publish checkpoint binds the revision its evidence authorised', async () => {
        const r = await run({
            adopted,
            checkpoints: [gatesCp(), postCp(), publishCp({ result: { published, revision: 'h:stale' } })],
        });

        expect(r.runner.published).toHaveLength(1);
    });

    it('p: a publish checkpoint on the probed tree under an evidence policy is not pushed again', async () => {
        const r = await run({
            adopted,
            policy: { gates: true },
            checkpoints: [gatesCp(), postCp(), publishCp({ result: { published, revision: TREE } })],
        });

        expect(r.runner.published).toEqual([]);
        expect(r.board.phaseCheckpointsWritten).toEqual([]);
        expect(r.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

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

// Issue #917: a failed `environment.setup` lived only in the first driver's memory, so a holder that
// adopted or took the run over could skip the end-of-run pass that would have refused it.
describe('the setup outcome an adopted or taken-over run carries', () => {
    const SETUP_FAILED: GateRun = { exitCode: 7, output: 'npm ERR! registry down' };
    const SETUP_OK: GateRun = { exitCode: 0, output: 'installed' };
    const setupCp = (failure: { exitCode: number | null; output: string } | null): PhaseCheckpoint => ({
        phase: 'setup',
        claimSeq: 1,
        tree: null,
        result: { failure },
    });
    const live: LiveRun = {
        live: true,
        prior: { ...gatedJob(1), claimSeq: 1 } as BoardJob,
        claimSeq: 1,
        session: 'sess',
        startedAt: 'then',
        forget: () => undefined,
    };
    // An adopter re-runs the pre-agent setup itself (one run, which passes here); a takeover does not.
    const holders = [
        ['adopted', adopted, [SETUP_OK]],
        ['taken over', live, []],
    ] as const;

    it.each(holders)(
        'a %s run whose earlier driver recorded a failed setup still runs its end pass',
        async (_h, how, before) => {
            const r = await run({
                adopted: how,
                post: false,
                checkpoints: [setupCp({ exitCode: 7, output: 'npm ERR! registry down' })],
                setupOnly: { setups: [...before, SETUP_FAILED] },
            });

            expect(r.stack.setups).toHaveLength(before.length + 1);
            expect(r.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'gate', exitCode: 7 });
            expect(r.board.completed[0]!.output).toContain('[setup failed — the gate did not run]');
        }
    );

    it.each(holders)('a %s run whose setup outcome cannot be read runs its end pass too', async (_h, how, before) => {
        const r = await run({
            adopted: how,
            post: false,
            checkpoints: null,
            setupOnly: { setups: [...before, SETUP_OK] },
        });

        expect(r.stack.setups).toHaveLength(before.length + 1);
        expect(r.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it.each(holders)('a %s run whose setup stood recorded as passed skips the end pass', async (_h, how, before) => {
        const r = await run({
            adopted: how,
            post: false,
            checkpoints: [setupCp(null)],
            setupOnly: { setups: [...before] },
        });

        expect(r.stack.setups).toHaveLength(before.length);
        expect(r.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('a fresh run records the setup outcome before the agent starts, failed or passed', async () => {
        const failed = await run({ post: false, setupOnly: { setups: [SETUP_FAILED, SETUP_OK] } });
        expect(failed.board.phaseCheckpointsWritten[0]).toMatchObject({
            phase: 'setup',
            tree: null,
            runClaimSeq: 3,
            result: { failure: { exitCode: 7, output: 'npm ERR! registry down' } },
        });
        const passed = await run({ post: false, setupOnly: { setups: [SETUP_OK] } });
        expect(passed.board.phaseCheckpointsWritten[0]).toMatchObject({ phase: 'setup', result: { failure: null } });
    });
});
