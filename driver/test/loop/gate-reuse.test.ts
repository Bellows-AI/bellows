import { describe, expect, it } from 'vitest';
import type { GateRunRecord } from '../../src/board/board-gate-runs.js';
import type { BoardJob } from '../../src/board/board.js';
import type { DeadService } from '../../src/runner.js';
import { gateRunRow, SAME_TREE } from '../fixtures/gate-runs.js';
import { drive, gatedJob, ok, stubBoard, stubGateStack, stubRunner } from '../fixtures/loop-stubs.js';

/**
 * Reusing a verified gate pass at completion (issue #983): the end-of-run pass skips a declared gate
 * whose LATEST recorded run — any scope — is a full, unfiltered ad-hoc pass of the same gate identity,
 * on the very tree the completion probe reads, untouched while it ran, under the same run claim. Every
 * other state of the record, and any read the loop could not confirm, runs the gate as it always did.
 * Both executors share the one gate manager and the one probe script: the two `EXECUTOR` values here
 * pin that parity.
 *
 * The cases marked GUARD pass before the change too (every gate ran then): they pin that a stale or
 * unconfirmed record never becomes a skip.
 */
/** The gate probe reading the completion tree, content and fingerprint alike. */
const SAME_GATE_TREE = () => ({ fingerprint: SAME_TREE, content: SAME_TREE, mutatedSince: false });
/** A fresh claim per call: the loop writes onto the job it is handed (the gate pair, the setup outcome). */
const claimedJob = (): BoardJob => ({ ...gatedJob(1), publish: false });
const CLAIMED = claimedJob();

interface Scene {
    rows?: GateRunRecord[] | null | ((signal?: AbortSignal) => Promise<GateRunRecord[] | null>);
    /** The completion probe's tree, or a reader of it; `undefined` reads SAME_TREE. */
    tree?: string | null | (() => string | null);
    job?: BoardJob;
    deadServices?: () => Promise<DeadService[]>;
    /** The gate stack's options: scripted setup, a gate that edits the tree, a pending ad-hoc quiesce. */
    stack?: Parameters<typeof stubGateStack>[1];
    /** What the runner's gate probe reads, per call: a gate that runs may move it. */
    gateTree?: () => string | null;
    /** The gate probe's content key, per call; `undefined` reads the same value as `gateTree`. */
    gateContent?: () => string | null;
    /** The startup sync's fingerprint; `undefined` reads a known one. */
    syncFingerprint?: string | null;
}

const EXECUTORS = [
    ['docker', {}],
    ['kubernetes', { EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory', RUNNER_SERVICES: '0' }],
] as const;

describe.each(EXECUTORS)('reusing a verified gate pass at completion on the %s executor', (_executor, env) => {
    async function run(scene: Scene = {}) {
        const claimed = scene.job ?? claimedJob();
        const board = stubBoard([claimed], { gateRuns: scene.rows === undefined ? null : scene.rows });
        const stack = stubGateStack({}, scene.stack);
        const runner = stubRunner(async () => ok(), {
            sync: {
                ok: true,
                reason: null,
                fingerprint: scene.syncFingerprint === undefined ? 'h:before' : scene.syncFingerprint,
            },
            probeTree: scene.tree === undefined ? SAME_TREE : scene.tree,
            gateTree: () => {
                const fingerprint = scene.gateTree ? scene.gateTree() : SAME_TREE;
                const content = scene.gateContent ? scene.gateContent() : fingerprint;
                return { fingerprint, content, mutatedSince: false };
            },
            ...(scene.deadServices ? { deadServices: scene.deadServices } : {}),
        });
        await drive({ ...board, runner, gates: stack.gates }, env);
        return { board: board.board, stack: stack.stack, runner, claimed };
    }

    const passes = (job: BoardJob = CLAIMED, over: Partial<GateRunRecord> = {}): GateRunRecord[] =>
        ['test', 'lint'].map((name) => gateRunRow(job, name, over));
    const lastReports = (r: Awaited<ReturnType<typeof run>>) => r.board.gatesReported.at(-1)!.results;

    it('runs no gate when every required gate passed on the unchanged tree, and reports each as reused', async () => {
        const rows = passes();
        const r = await run({ rows, job: { ...CLAIMED, policy: { gates: true } } as BoardJob });

        expect(r.stack.ran.names).toEqual([]);
        expect(r.board.gateRunReads).toEqual([
            { id: CLAIMED.id, leaseToken: CLAIMED.leaseToken, runClaimSeq: CLAIMED.claimSeq },
        ]);
        expect(lastReports(r)).toEqual([
            {
                name: 'test',
                status: 'passed',
                exitCode: 0,
                output: expect.stringContaining('reused'),
                executionId: rows[0]!.executionId,
                reused: {
                    executionId: rows[0]!.executionId,
                    finishedAt: rows[0]!.finishedAt,
                    reason: expect.stringContaining('unchanged'),
                },
            },
            {
                name: 'lint',
                status: 'passed',
                exitCode: 0,
                output: expect.stringContaining('reused'),
                executionId: rows[1]!.executionId,
                reused: {
                    executionId: rows[1]!.executionId,
                    finishedAt: rows[1]!.finishedAt,
                    reason: expect.stringContaining('unchanged'),
                },
            },
        ]);
        // The verdict is the same one a live pass gives: evidence stays {outcome, treeAfter}.
        expect(r.board.completed[0]).toMatchObject({
            status: 'succeeded',
            evidence: { gates: 'passed', treeAfter: SAME_TREE },
        });
    });

    // ---- a publish between the pass and completion (issue #983, found live) ---------------------
    // The agent gates, then publishes: the publish commits the very bytes the gates passed on, which
    // moves HEAD and the fingerprint but not the content key the passes were recorded against.
    it('reuses passes a publish commit kept: the fingerprint moved, the content did not', async () => {
        const r = await run({
            rows: passes(),
            job: { ...CLAIMED, policy: { gates: true } } as BoardJob,
            tree: 'h:published',
            gateTree: () => 'h:published',
            gateContent: () => SAME_TREE,
        });

        expect(r.stack.ran.names).toEqual([]);
        expect(r.board.completed[0]).toMatchObject({
            status: 'succeeded',
            evidence: { gates: 'passed', treeAfter: 'h:published' },
        });
    });

    it.each<[string, Scene]>([
        [
            'the content matches but the checkout no longer reads the completion tree',
            { rows: passes(), tree: 'h:published', gateTree: () => 'h:moved-again', gateContent: () => SAME_TREE },
        ],
        [
            'the content key could not be read',
            { rows: passes(), tree: 'h:published', gateTree: () => 'h:published', gateContent: () => null },
        ],
    ])('GUARD: runs every gate when %s', async (_why, scene) => {
        const r = await run(scene);
        expect(r.stack.ran.names).toEqual(['test', 'lint']);
    });

    it('runs only the gate whose pass is missing: test reused, lint runs', async () => {
        const r = await run({ rows: [gateRunRow(CLAIMED, 'test')] });

        expect(r.stack.ran.names).toEqual(['lint']);
        const reports = lastReports(r);
        expect(reports.map((g) => [g.name, g.status, 'reused' in g])).toEqual([
            ['test', 'passed', true],
            ['lint', 'passed', false],
        ]);
    });

    it('still fails on a gate that fails when the other was reused', async () => {
        const board = stubBoard([claimedJob()], { gateRuns: [gateRunRow(CLAIMED, 'test')] });
        const stack = stubGateStack({ lint: 1 });
        const runner = stubRunner(async () => ok(), {
            sync: { ok: true, reason: null, fingerprint: 'h:before' },
            probeTree: SAME_TREE,
            gateTree: SAME_GATE_TREE,
        });
        await drive({ ...board, runner, gates: stack.gates }, env);

        expect(stack.stack.ran.names).toEqual(['lint']);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'gate' });
    });

    // ---- GUARD: nothing eligible, every gate runs -------------------------------------------------
    it.each<[string, () => Scene]>([
        ['a later edit: the completion tree differs', () => ({ rows: passes(), tree: 'h:edited' })],
        ['a completion tree that could not be read', () => ({ rows: passes(), tree: null })],
        ['a null gate-runs read', () => ({ rows: null })],
        ['a changed command', () => ({ rows: passes(CLAIMED, { identity: 'b'.repeat(64) }) })],
        ['a filtered latest run', () => ({ rows: passes(CLAIMED, { filtered: true }) })],
        ['a null tree before', () => ({ rows: passes(CLAIMED, { treeBefore: null }) })],
        ['a null tree after', () => ({ rows: passes(CLAIMED, { treeAfter: null }) })],
        ['a tree that moved during the run', () => ({ rows: passes(CLAIMED, { treeBefore: 'h:other' }) })],
        ['a mutation the guard saw', () => ({ rows: passes(CLAIMED, { mutatedSince: true }) })],
        ['a mutation the guard could not measure', () => ({ rows: passes(CLAIMED, { mutatedSince: null }) })],
        ['another run claim sequence', () => ({ rows: passes(CLAIMED, { runClaimSeq: 2 }) })],
        ['a completion-pass row', () => ({ rows: passes(CLAIMED, { source: 'completion' }) })],
        ['a failed row', () => ({ rows: passes(CLAIMED, { outcome: 'failed', exitCode: 1 }) })],
        ['an incomplete row', () => ({ rows: passes(CLAIMED, { outcome: 'incomplete', exitCode: null }) })],
        ['a running row', () => ({ rows: passes(CLAIMED, { outcome: 'running', exitCode: null }) })],
        ['a not_started row', () => ({ rows: passes(CLAIMED, { outcome: 'not_started', exitCode: null }) })],
        ['a setup_failed row', () => ({ rows: passes(CLAIMED, { outcome: 'setup_failed', exitCode: 1 }) })],
    ])('GUARD: runs every gate for %s', async (_what, scene) => {
        const r = await run(scene());

        expect(r.stack.ran.names).toEqual(['test', 'lint']);
        expect(lastReports(r).some((g) => 'reused' in g)).toBe(false);
    });

    it('lets the latest row decide: a pass older than a later running, failed or filtered row is not reused', async () => {
        const [oldTest, oldLint] = passes();
        const later = (gate: string, over: Partial<GateRunRecord>) => gateRunRow(CLAIMED, gate, over);
        const r = await run({
            rows: [
                oldTest!,
                oldLint!,
                later('test', { outcome: 'running', exitCode: null, treeAfter: null, mutatedSince: null }),
                later('lint', { filtered: true }),
            ],
        });

        expect(r.stack.ran.names).toEqual(['test', 'lint']);
    });

    it('a later pass over an earlier failure is reused: the last row of the gate wins', async () => {
        const r = await run({
            rows: [
                gateRunRow(CLAIMED, 'test', { outcome: 'failed', exitCode: 1 }),
                gateRunRow(CLAIMED, 'test'),
                gateRunRow(CLAIMED, 'lint'),
            ],
        });

        expect(r.stack.ran.names).toEqual([]);
    });

    it('GUARD: runs a gate whose environment changed by one env value: the identity differs', async () => {
        const withEnv = { ...CLAIMED, env: { API_URL: 'https://a.example' } } as unknown as BoardJob;
        const rows = ['test', 'lint'].map((name) => gateRunRow(withEnv, name));
        const changed = { ...CLAIMED, env: { API_URL: 'https://b.example' } } as unknown as BoardJob;
        const r = await run({ rows, job: changed });

        expect(r.stack.ran.names).toEqual(['test', 'lint']);
    });

    it('GUARD: never runs or requires an on-demand gate, reused or not', async () => {
        const job: BoardJob = {
            ...CLAIMED,
            gates: {
                image: 'node:24',
                gates: [
                    ...CLAIMED.gates!.gates,
                    { name: 'ui', command: 'npm run verify:ui', timeoutMinutes: 45, onDemand: true },
                ],
            },
        };
        const r = await run({ job, rows: null });

        expect(r.stack.ran.names).toEqual(['test', 'lint']);
    });

    it('still restarts a dead service before the gates, then reuses', async () => {
        let probes = 0;
        const dead: DeadService = {
            name: 'db',
            image: 'postgres:16',
            state: 'failed',
            exitCode: 1,
            reason: 'Error',
            logTail: 'killed',
        };
        const r = await run({ rows: passes(), deadServices: async () => (probes++ === 0 ? [dead] : []) });

        expect(r.runner.restartedServices).toEqual([CLAIMED.id]);
        expect(r.stack.ran.names).toEqual([]);
    });

    // ---- the reuse is revalidated against the tree the completion pass leaves ------------------------
    it('does not reuse a pass once an earlier gate of the same pass changed the tree', async () => {
        let tree = SAME_TREE;
        const r = await run({
            rows: [gateRunRow(CLAIMED, 'lint')],
            gateTree: () => tree,
            stack: {
                onRun: (name) => {
                    if (name === 'test') tree = 'h:formatted';
                },
            },
        });

        expect(r.stack.ran.names).toEqual(['test', 'lint']);
        expect(lastReports(r).some((g) => 'reused' in g)).toBe(false);
    });

    it('runs a reused gate again when a later gate of the pass changed the tree it certified', async () => {
        let tree = SAME_TREE;
        const r = await run({
            rows: [gateRunRow(CLAIMED, 'test')],
            gateTree: () => tree,
            stack: {
                onRun: (name) => {
                    if (name === 'lint') tree = 'h:formatted';
                },
            },
        });

        expect(r.stack.ran.names).toEqual(['lint', 'test', 'lint']);
        expect(lastReports(r).some((g) => 'reused' in g)).toBe(false);
    });

    it('a tree that cannot be re-read after a gate ran is not a confirmation', async () => {
        let tree: string | null = SAME_TREE;
        const r = await run({
            rows: [gateRunRow(CLAIMED, 'lint')],
            gateTree: () => tree,
            stack: { onRun: () => (tree = null) },
        });

        expect(r.stack.ran.names).toEqual(['test', 'lint']);
    });

    // ---- the ad-hoc runs are settled before the record is read ------------------------------------
    it('closes ad-hoc admission and waits for the in-flight ones before it reads the record', async () => {
        let settle: (() => void) | undefined;
        const events: string[] = [];
        const pending = new Promise<void>((resolve) => {
            settle = resolve;
        });
        const rows = async (): Promise<GateRunRecord[]> => {
            events.push('read');
            return passes();
        };
        const driven = run({
            rows,
            stack: {
                quiesce: async () => {
                    events.push('quiesce');
                    await pending;
                    events.push('settled');
                },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(events).toEqual(['quiesce']);
        settle?.();
        const r = await driven;

        expect(events).toEqual(['quiesce', 'settled', 'read']);
        expect(r.stack.quiesced).toEqual([r.claimed.gateEnv!.BELLOWS_GATE_TOKEN]);
    });

    it('reads the completion tree only after the in-flight ad-hoc runs settled: a drain that moved it reuses nothing', async () => {
        // An on-demand gate still running at the agent's end writes a file while it drains: the passes
        // certify the tree from before it, so the completion tree must be read after the drain.
        let tree = SAME_TREE;
        const r = await run({
            rows: passes(),
            tree: () => tree,
            gateTree: () => tree,
            stack: {
                quiesce: async () => {
                    tree = 'h:drained';
                },
            },
        });

        expect(r.stack.ran.names).toEqual(['test', 'lint']);
        expect(lastReports(r).some((g) => 'reused' in g)).toBe(false);
    });

    it('settles the ad-hoc runs before the completion gates even when the startup tree is unknown', async () => {
        // No startup fingerprint: nothing is reused, but a draining ad-hoc gate must still not run
        // alongside the completion pass and move the tree after a check passed.
        const events: string[] = [];
        const r = await run({
            rows: passes(),
            syncFingerprint: null,
            stack: {
                quiesce: async () => void events.push('quiesce'),
                onRun: (name) => events.push(name),
            },
        });

        expect(events).toEqual(['quiesce', 'test', 'lint']);
        expect(r.stack.quiesced).toEqual([r.claimed.gateEnv!.BELLOWS_GATE_TOKEN]);
    });

    // ---- setup must have succeeded in this claim's environment ------------------------------------
    describe('with an environment setup', () => {
        const withSetup = (): BoardJob => ({ ...CLAIMED, gates: { ...CLAIMED.gates!, setup: 'npm ci' } });

        it('a failed setup is retried by the gates: nothing is reused over it', async () => {
            const job = withSetup();
            const r = await run({
                job,
                rows: passes(job),
                stack: { setup: { exitCode: 1, output: 'npm ci failed' } },
            });

            expect(r.stack.ran.names).toEqual(['test', 'lint']);
            expect(lastReports(r).some((g) => 'reused' in g)).toBe(false);
        });

        it('a setup that succeeded in this claim lets the passes be reused', async () => {
            const job = withSetup();
            const r = await run({ job, rows: passes(job), stack: { setup: { exitCode: 0, output: '' } } });

            expect(r.stack.ran.names).toEqual([]);
        });
    });

    it('a stop during the read stands down with no verdict and runs nothing', async () => {
        const options: { cancelRequested?: boolean; gateRuns?: (signal?: AbortSignal) => Promise<null> } = {};
        // The read that never answers: only the stand-down's abort ends it.
        options.gateRuns = (signal) =>
            new Promise((resolve) => {
                options.cancelRequested = true;
                signal?.addEventListener('abort', () => resolve(null), { once: true });
            });
        const board = stubBoard([claimedJob()], options);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok(), {
            sync: { ok: true, reason: null, fingerprint: 'h:before' },
            probeTree: SAME_TREE,
            gateTree: SAME_GATE_TREE,
        });
        await drive({ ...board, runner, gates: stack.gates }, env);

        expect(stack.stack.ran.names).toEqual([]);
        expect(board.board.completed).toEqual([]);
    });
});
