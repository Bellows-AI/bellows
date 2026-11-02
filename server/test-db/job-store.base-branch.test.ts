import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { expireLease, testOrg, testUser } from './fixtures.js';

/**
 * a task names the branch it bases on at creation; the choice lives on the root row and
 * every claim of the thread (retry, follow-up, reclaim) reads it from there, so no insert site
 * copies it. A batch task's frozen target still wins (batch-dispatch.test.ts pins that).
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'worker-1';
const LEASE_SECONDS = 60;
const BRANCH = 'release/1';
const USER = testUser('base-branch-user');
const db = useTestDb({ orgs: [ORG], users: [USER], max: 8 });

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

async function queue(baseBranch?: string | null): Promise<string> {
    const created = await store.create('do the work', USER.id, {
        repo: null,
        executor: null,
        ...(baseBranch === undefined ? {} : { baseBranch }),
    });
    if (typeof created === 'string') throw new Error(created);
    return created.id;
}

async function claim(): Promise<Claim> {
    const claimed = (await store.claim(WORKER, LEASE_SECONDS)) as Claim | null;
    expect(claimed).not.toBeNull();
    return claimed!;
}

describe.skipIf(!enabled)('task base branch — database', () => {
    it('stores the branch on the root and the claim carries it', async () => {
        const id = await queue(BRANCH);
        const [row] = await sql<{ base_branch: string | null }[]>`select base_branch from job where id = ${id}`;
        expect(row?.base_branch).toBe(BRANCH);
        expect(await claim()).toMatchObject({ id, baseBranch: BRANCH });
    });

    it('a task with no branch claims with none', async () => {
        await queue();
        expect(await claim()).not.toHaveProperty('baseBranch');
        await sql`delete from job`;
        await queue(null);
        expect(await claim()).not.toHaveProperty('baseBranch');
    });

    it('a retry claims with the root branch', async () => {
        const root = await queue(BRANCH);
        const first = await claim();
        await store.complete(first.id, first.leaseToken, { status: 'failed', exitCode: 1, output: 'red' });
        const retry = await store.createRetry(root, USER.id);
        if (typeof retry === 'string') throw new Error(`retry refused: ${retry}`);
        expect(await claim()).toMatchObject({ id: retry.id, baseBranch: BRANCH });
    });

    it('a follow-up claims with the root branch', async () => {
        const root = await queue(BRANCH);
        const first = await claim();
        await store.session(first.id, first.leaseToken, randomUUID());
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });
        const followUp = await store.createFollowUp(root, 'and also this', USER.id);
        if (typeof followUp === 'string') throw new Error(`follow-up refused: ${followUp}`);
        expect(await claim()).toMatchObject({ id: followUp.id, baseBranch: BRANCH });
    });

    it('a workflow successor claims with the root branch', async () => {
        const walk: WorkflowDefinition = {
            entry: 'implement',
            params: [],
            nodes: [
                { name: 'implement', kind: 'agent', session: 'resume', prompt: 'implement' },
                { name: 'review', kind: 'agent', session: 'fresh', prompt: 'review the work', publish: true },
            ],
            edges: [{ from: 'implement', to: 'review', when: 'succeeded' }],
        };
        // job.workflow_id carries no foreign key, so a hand-built snapshot walks without the workflow store.
        const created = await store.create('fix the thing', USER.id, {
            repo: null,
            executor: null,
            baseBranch: BRANCH,
            workflow: { id: randomUUID(), name: 'walk', node: walk.entry, snapshot: walk, params: {} },
        });
        if (typeof created === 'string') throw new Error(created);
        const first = await claim();
        await store.session(first.id, first.leaseToken, randomUUID());
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });

        const successor = await claim();
        expect(successor.id).not.toBe(first.id);
        const [row] = await sql<
            { workflow_node: string | null }[]
        >`select workflow_node from job where id = ${successor.id}`;
        expect(row?.workflow_node).toBe('review');
        expect(successor.baseBranch).toBe(BRANCH);
    });

    it('an expired-lease reclaim of the same row still carries the branch', async () => {
        const id = await queue(BRANCH);
        const first = await claim();
        await expireLease(sql, id);
        const second = await claim();
        expect(second.id).toBe(id);
        expect(second.claimSeq).toBe(first.claimSeq + 1);
        expect(second.baseBranch).toBe(BRANCH);
    });

    it('get and thread report the branch on every row of the thread, and null when none was asked for', async () => {
        const root = await queue(BRANCH);
        const first = await claim();
        await store.session(first.id, first.leaseToken, randomUUID());
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });
        const followUp = await store.createFollowUp(root, 'more', USER.id);
        if (typeof followUp === 'string') throw new Error(`follow-up refused: ${followUp}`);

        expect((await store.get(followUp.id))?.baseBranch).toBe(BRANCH);
        const thread = await store.thread(root);
        expect(thread?.map((job) => job.baseBranch)).toEqual([BRANCH, BRANCH]);

        const plain = await queue();
        expect((await store.get(plain))?.baseBranch).toBeNull();
    });
});
