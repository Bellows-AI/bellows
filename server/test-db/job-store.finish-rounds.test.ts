import { randomUUID } from 'node:crypto';
import { DEFAULT_GATE_FIX_ROUNDS, githubRepo } from '@factory-ai/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { insertJobInTx } from '../src/db/jobs/job-store-thread-actions.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import type { CreateTarget } from '../src/db/jobs/job-store-action-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { sweepRuntimeWakes } from '../src/db/workflows/workflow-blocks/runtime.js';
import type { WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { useTestDb } from './harness.js';
import { expireLease, mustCreate, testOrg } from './fixtures.js';

/**
 * The round cap a run's finish pass is held to: the thread root's `gate_fix_rounds`, frozen at create for every
 * mode — the selected profile's value, the default when none resolved, 0 only when the profile says 0 — and carried
 * on every claim of the thread as `finishRounds`: a follow-up, a workflow successor (a woken one too) and a
 * takeover read the root's value, never their own row's.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'worker-1';
const REPO = 'acme/widgets';
const db = useTestDb({ orgs: [ORG], max: 8 });

let sql: Sql;
let store: JobStore;
let prs: ReturnType<typeof createPrLifecycleStore>;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    store = createJobStore({ sql, orgId: ORG, prs });
});

/** implement -> review: a plain successor. */
const walk: WorkflowDefinition = {
    entry: 'implement',
    params: [],
    nodes: [
        { name: 'implement', kind: 'agent', session: 'resume', prompt: 'implement' },
        { name: 'review', kind: 'agent', session: 'fresh', prompt: 'review the work' },
    ],
    edges: [{ from: 'implement', to: 'review', when: 'succeeded' }],
};

/** verify (publish) -> review, a `pr-delivery-wait` boundary: the successor parks until a delivery wakes it. */
const waiting: WorkflowDefinition = {
    entry: 'verify',
    params: [],
    nodes: [
        { name: 'verify', kind: 'agent', session: 'fresh', publish: true, prompt: 'verify' },
        {
            name: 'review',
            kind: 'agent',
            session: 'fresh',
            prompt: 'react to review',
            runtime: { runtime: 'pr-delivery-wait', block: 'fake/test-block', params: {} },
        },
    ],
    edges: [{ from: 'verify', to: 'review', when: 'succeeded' }],
};

const workflowOf = (definition: WorkflowDefinition) => ({
    id: randomUUID(),
    name: `wf-${randomUUID().slice(0, 8)}`,
    node: definition.entry,
    snapshot: definition,
    params: {},
});

async function profile(name: string, rounds: number): Promise<void> {
    await sql`
        insert into executor_profile (org_id, user_id, name, type, config, gate_fix_rounds, position)
        values (${ORG}, null, ${name}, 'claude-code', '{}'::jsonb, ${rounds}, 0)`;
}

async function create(target: Partial<CreateTarget> = {}): Promise<string> {
    return (await mustCreate(store.create('do the thing', null, { repo: null, executor: null, ...target }))).id;
}

async function claim(): Promise<Claim> {
    const claimed = await store.claim(WORKER, 60);
    expect(claimed).not.toBeNull();
    return claimed!;
}

const nodeOf = async (c: Claim): Promise<string | null> =>
    (await sql<{ node: string | null }[]>`select workflow_node as node from job where id = ${c.id}`)[0]!.node;

async function succeed(c: Claim, extra: object = {}): Promise<void> {
    await store.complete(c.id, c.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done', ...extra });
}

describe.skipIf(!enabled)('the finish round cap on the claim', () => {
    it('carries the default on an objective root that resolved no profile', async () => {
        await create();
        expect((await claim()).finishRounds).toBe(DEFAULT_GATE_FIX_ROUNDS);
    });

    it('carries the selected profile’s value, and 0 only when the profile says 0', async () => {
        await profile('five', 5);
        await profile('off', 0);
        await create({ executor: 'five', executorScope: 'org' });
        expect((await claim()).finishRounds).toBe(5);
        await create({ executor: 'off', executorScope: 'org' });
        expect((await claim()).finishRounds).toBe(0);
    });

    it('carries the default when the named profile does not resolve, never 0', async () => {
        await create({ executor: 'gone', executorScope: 'org' });
        expect((await claim()).finishRounds).toBe(DEFAULT_GATE_FIX_ROUNDS);
    });

    it('freezes the cap on a workflow-mode root too', async () => {
        await profile('two', 2);
        await create({ executor: 'two', executorScope: 'org', workflow: workflowOf(walk) });
        expect((await claim()).finishRounds).toBe(2);
        await create({ workflow: workflowOf(walk) });
        expect((await claim()).finishRounds).toBe(DEFAULT_GATE_FIX_ROUNDS);
    });

    it('carries the root’s value on a follow-up and a takeover, whatever a later profile edit says', async () => {
        await profile('four', 4);
        const root = await create({ executor: 'four', executorScope: 'org' });
        await sql`update executor_profile set gate_fix_rounds = 1 where org_id = ${ORG} and name = 'four'`;
        await succeed(await claim());
        const follow = await store.createFollowUp(root, 'and the next step', null);
        if (typeof follow === 'string') throw new Error(follow);
        const first = await claim();
        expect(first.id).toBe(follow.id);
        expect(first.finishRounds).toBe(4);
        await expireLease(sql, first.id);
        const takeover = await claim();
        expect(takeover.id).toBe(first.id);
        expect(takeover.claimSeq).toBeGreaterThan(first.claimSeq);
        expect(takeover.finishRounds).toBe(4);
    });

    it('carries the root’s value on a workflow successor', async () => {
        await profile('three', 1);
        await create({ executor: 'three', executorScope: 'org', workflow: workflowOf(walk) });
        await succeed(await claim());
        const successor = await claim();
        expect(await nodeOf(successor)).toBe('review');
        expect(successor.finishRounds).toBe(1);
    });

    it('carries the root’s value on a parked successor once a delivery wakes it', async () => {
        await profile('waits', 6);
        const root = await create({
            repo: githubRepo(REPO),
            executor: 'waits',
            executorScope: 'org',
            workflow: workflowOf(waiting),
        });
        const entry = await claim();
        await store.session(entry.id, entry.leaseToken, `sess-${root}`);
        await succeed(entry, {
            publication: {
                repo: REPO,
                prNumber: 41,
                prUrl: `https://github.com/${REPO}/pull/41`,
                headBranch: `factory/${root}`,
                baseBranch: 'main',
            },
        });
        expect(await store.claim(WORKER, 60)).toBeNull();
        await prs.recordDelivery({
            deliveryId: randomUUID(),
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 41,
        });
        await sweepRuntimeWakes({ sql, orgId: ORG, prs });
        const woken = await claim();
        expect(await nodeOf(woken)).toBe('review');
        expect(woken.finishRounds).toBe(6);
    });

    it('freezes the cap on a root a batch launches, through the same insert', async () => {
        await sql.begin((tx) =>
            insertJobInTx(
                tx,
                { sql, orgId: ORG },
                { command: 'batch task', createdBy: null, target: { repo: null, executor: null } }
            )
        );
        expect((await claim()).finishRounds).toBe(DEFAULT_GATE_FIX_ROUNDS);
    });
});
