import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { GateReport } from '../src/db/job-store-types.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { createWorkflowStore } from '../src/db/workflow-store.js';
import type { WorkflowDefinition } from '../src/db/workflow-schema.js';
import { useTestDb } from './harness.js';
import { account, randomGithubId, testOrg } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
const ORG = testOrg();
const SESSION = randomUUID();

const db = useTestDb({ max: 4 });

/** A lease long enough that nothing in this suite outlives it by accident. */
const LEASE_SECONDS = 300;

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

/** The chained follow-ups must land; a refusal here is a setup failure, not a branch under test. */
const followUp = (target: JobStore, root: string, command: string, userId: string): Promise<{ id: string }> =>
    target.createFollowUp(root, command, userId).then((ref) => {
        if (typeof ref === 'string') throw new Error(`createFollowUp refused: ${ref}`);
        return ref;
    });

/** A saved workflow row for the job's snapshot to name. */
const new_workflow = async (definition: WorkflowDefinition, name: string): Promise<string> => {
    const created = await createWorkflowStore({ sql, orgId: ORG }).create({
        name,
        scope: { kind: 'org' },
        definition,
        createdBy: null,
    });
    return (created as { id: string }).id;
};

/** A store whose gates reader answers from memory: the SQL is under test here, not the file read. */
const gatedStore = (answer: {
    config: unknown;
    error: string | null;
    source?: 'worktree' | 'clone' | null;
}): JobStore =>
    createJobStore({
        sql,
        orgId: ORG,
        gates: {
            readFor: async () =>
                ({ source: 'clone', ...answer }) as { config: null; error: string | null; source: null },
        },
    });

describe.runIf(enabled)('gates on the job store', () => {
    it('carries the parsed declaration and the repo label on a gated claim', async () => {
        const GATE_CAT_GITHUB_ID = randomGithubId();
        const userId = await account(sql, GATE_CAT_GITHUB_ID, 'gate-cat');
        const gated = gatedStore({
            config: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            error: null,
        });
        await gated.create('fix the bug', userId, { repo: 'acme/web', executor: null });

        const claim = await gated.claim('driver-1', LEASE_SECONDS);

        expect(claim?.repo).toBe('acme/web');
        expect(claim?.gates).toEqual({ image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] });
        expect(claim?.gateError).toBeNull();
    });

    it('carries a gateError value — not a throw — when the file cannot be honoured', async () => {
        const GATE_DOG_GITHUB_ID = randomGithubId();
        const userId = await account(sql, GATE_DOG_GITHUB_ID, 'gate-dog');
        const broken = gatedStore({ config: null, error: '.bellows.yaml line 3: unknown key "timeout"' });
        await broken.create('fix the bug', userId, { repo: 'acme/web', executor: null });

        const claim = await broken.claim('driver-1', LEASE_SECONDS);

        expect(claim?.gates).toBeNull();
        expect(claim?.gateError).toBe('.bellows.yaml line 3: unknown key "timeout"');
    });

    // Issue #444: the claim names the tree its gates answer came from, so the driver can refuse
    // to gate on a base-clone answer its post-sync re-read could not replace. It rides even when
    // the answer is "no gates" — that answer is as stale as the tree it was read from.
    it('carries the tree the gates answer was read from, gated or not', async () => {
        const SOURCE_CAT_GITHUB_ID = randomGithubId();
        const userId = await account(sql, SOURCE_CAT_GITHUB_ID, 'source-cat');
        const fromClone = gatedStore({ config: null, error: null, source: 'clone' });
        await fromClone.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        const cloneClaim = await fromClone.claim('driver-1', LEASE_SECONDS);
        expect(cloneClaim?.gates).toBeUndefined();
        expect(cloneClaim?.gatesSource).toBe('clone');

        const fromWorktree = gatedStore({
            config: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            error: null,
            source: 'worktree',
        });
        await fromWorktree.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        expect((await fromWorktree.claim('driver-1', LEASE_SECONDS))?.gatesSource).toBe('worktree');
    });

    it('carries no gates at all for a repository that declares none', async () => {
        const PLAIN_CAT_GITHUB_ID = randomGithubId();
        const userId = await account(sql, PLAIN_CAT_GITHUB_ID, 'plain-cat');
        await store.create('echo hi', userId, { repo: 'acme/web', executor: null });

        const claim = await store.claim('driver-1', LEASE_SECONDS);

        // A store built without a gates reader — the state of every deployment and test that
        // predates the feature — reads as "no gates", not as an error.
        expect(claim?.gates).toBeUndefined();
        expect(claim?.gateError).toBeUndefined();
        expect(claim?.gatesSource).toBeUndefined();
    });

    it('replaces the gate state on every report, and answers the last one on read', async () => {
        const GATE_OWL_GITHUB_ID = randomGithubId();
        const userId = await account(sql, GATE_OWL_GITHUB_ID, 'gate-owl');
        await store.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        const claim = await store.claim('driver-1', LEASE_SECONDS);
        const running: GateReport[] = [{ name: 'test', status: 'running', exitCode: null, output: null }];
        const finished: GateReport[] = [{ name: 'test', status: 'failed', exitCode: 3, output: 'boom' }];

        expect(await store.gates(claim!.id, claim!.leaseToken, running)).toBe('ok');
        expect((await store.get(claim!.id))?.gates).toEqual(running);
        expect(await store.gates(claim!.id, claim!.leaseToken, finished)).toBe('ok');
        // REPLACE, never append: the second report is the whole truth, current/last only.
        expect((await store.get(claim!.id))?.gates).toEqual(finished);
        expect((await store.thread(claim!.id))?.[0]?.gates).toEqual(finished);
    });

    it('omits gates from the list projection, like output', async () => {
        const GATE_EMU_GITHUB_ID = randomGithubId();
        const userId = await account(sql, GATE_EMU_GITHUB_ID, 'gate-emu');
        await store.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        const claim = await store.claim('driver-1', LEASE_SECONDS);
        await store.gates(claim!.id, claim!.leaseToken, [
            { name: 'test', status: 'passed', exitCode: 0, output: 'all green' },
        ]);

        const listed = await store.list({ limit: 10 });
        expect(listed).toHaveLength(1);
        expect(listed[0]?.gates).toBeNull();
    });
});

describe.runIf(enabled)('gates on the job store: re-reads', () => {
    // The driver syncs the checkout after the claim, so the claim's gates answer can predate the
    // tree the run will actually see. The re-read is the freshness channel, lease-guarded like
    // every worker route.
    it('re-reads the gates for the lease holder, from the same checkout the claim read', async () => {
        const GATE_BAT_GITHUB_ID = randomGithubId();
        const userId = await account(sql, GATE_BAT_GITHUB_ID, 'gate-bat');
        // First answer: the stale tree the claim saw. Second: what the synced tree holds.
        const answers = [
            { config: null, error: null, source: 'clone' as const },
            {
                config: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
                error: null,
                source: 'worktree' as const,
            },
        ];
        let call = 0;
        const reader = createJobStore({
            sql,
            orgId: ORG,
            gates: {
                readFor: async () => answers[Math.min(call++, answers.length - 1)]!,
            },
        });
        await reader.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        const claim = await reader.claim('driver-1', LEASE_SECONDS);

        // A stale-tree read of nothing omits gates from the claim entirely — the shape every
        // ungated job carries.
        expect(claim?.gates).toBeUndefined();
        const reread = await reader.rereadGates(claim!.id, claim!.leaseToken);
        expect(reread).toEqual({
            result: 'ok',
            gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            gateError: null,
        });
    });

    // A worktree whose .bellows.yaml cannot be parsed fails a gated node, but a node that declared
    // `gates: false` never reads it — on the claim and on the re-read alike.
    it.each([
        { gates: false, expectError: false },
        { gates: true, expectError: true },
    ])('answers an unparseable .bellows.yaml per the node (gates: $gates)', async ({ gates, expectError }) => {
        const userId = await account(sql, randomGithubId(), gates ? 'gate-owl' : 'gate-fox');
        const PARSE_ERROR = '.bellows.yaml line 3: unknown key "setup" inside environment';
        const reader = createJobStore({
            sql,
            orgId: ORG,
            gates: { readFor: async () => ({ config: null, error: PARSE_ERROR, source: 'worktree' as const }) },
        });
        const definition: WorkflowDefinition = {
            entry: 'collect',
            params: [],
            nodes: [{ name: 'collect', kind: 'agent', session: 'fresh', gates, prompt: 'collect' }],
            edges: [],
        };
        const created = await new_workflow(definition, `reread-gates-${gates}`);
        await reader.create('collect', userId, {
            repo: 'acme/web',
            executor: null,
            workflow: { id: created, name: `reread-gates-${gates}`, node: 'collect', snapshot: definition, params: {} },
        });
        const claim = await reader.claim('driver-1', LEASE_SECONDS);

        expect(claim?.gateError ?? null).toBe(expectError ? PARSE_ERROR : null);
        expect(await reader.rereadGates(claim!.id, claim!.leaseToken)).toEqual({
            result: 'ok',
            gates: null,
            gateError: expectError ? PARSE_ERROR : null,
        });
    });

    // The gates the run satisfies live in the thread's worktree (issue #35), which is keyed by
    // the thread's ROOT job — so both the claim's read and the re-read must resolve the root
    // through the follow-up chain and hand THAT id to the reader.
    it('reads the gates of the thread root’s worktree, on the claim and on the re-read', async () => {
        const GATE_WOLF_GITHUB_ID = randomGithubId();
        const userId = await account(sql, GATE_WOLF_GITHUB_ID, 'gate-wolf');
        const seen: { workspacePath: string; repo: string; worktreeId: string | null }[] = [];
        const reader = createJobStore({
            sql,
            orgId: ORG,
            gates: {
                readFor: async (workspacePath, repo, worktreeId) => {
                    seen.push({ workspacePath, repo, worktreeId: worktreeId ?? null });
                    return { config: null, error: null, source: null };
                },
            },
        });
        // A finished root with a session, a finished follow-up on it, and a follow-up on the
        // follow-up — a three-row thread.
        await reader.create('root task', userId, { repo: 'acme/web', executor: null });
        const rootClaim = await reader.claim('driver-1', LEASE_SECONDS);
        const root = rootClaim!.id;
        await reader.session(root, rootClaim!.leaseToken, SESSION);
        await reader.complete(root, rootClaim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const child = await followUp(reader, root, 'adjust', userId);
        const childClaim = await reader.claim('driver-1', LEASE_SECONDS);
        await reader.session(child.id, childClaim!.leaseToken, SESSION);
        await reader.complete(child.id, childClaim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const grand = await followUp(reader, child.id, 'again', userId);

        // The grandchild is the only claimable row now; its claim reads the ROOT's worktree.
        seen.length = 0;
        const claim = await reader.claim('driver-1', LEASE_SECONDS);
        expect(claim?.id).toBe(grand.id);
        expect(claim?.rootJobId).toBe(root);
        expect(seen).toEqual([{ workspacePath: `${ORG}/${userId}`, repo: 'acme/web', worktreeId: root }]);

        // And the re-read resolves the same root, inside the lease guard.
        seen.length = 0;
        await reader.rereadGates(grand.id, claim!.leaseToken);
        expect(seen).toEqual([{ workspacePath: `${ORG}/${userId}`, repo: 'acme/web', worktreeId: root }]);
    });
});
