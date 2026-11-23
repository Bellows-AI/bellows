import { randomUUID } from 'node:crypto';
import { githubRepo, type RepoRef } from '@factory-ai/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { issueVerdictReclaim } from '../src/db/jobs/job-store-reclaim-queue.js';
import type { Claim, JobStore, ReviewerSpec } from '../src/db/jobs/job-store-types.js';
import { reviewRefOf } from '../src/db/jobs/job-store-reviews.js';
import type { WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { useTestDb } from './harness.js';
import { mustCreate, testOrg, testUser } from './fixtures.js';

/**
 * A job's derived rows — follow-up, retry, workflow successor, review child, reclaim, execution record, PR
 * operation and admin event — carry the forge, host and path of the thread they derive from (docs/repos.md). The
 * thread is turned GitLab by raw SQL: no edge creates one yet, so the column default (github) is what a copy
 * that forgets the pair would write.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const AUTHOR_USER = testUser('repo-ref-author');
const ADMIN_USER = testUser('repo-ref-admin');
const LEASE_SECONDS = 300;
const GITLAB: RepoRef = { forge: 'gitlab', host: 'gl.example', path: 'g/sub/p' };
const TRIPLE = { forge: GITLAB.forge, host: GITLAB.host, repo: GITLAB.path };

const db = useTestDb({ orgs: [ORG], users: [AUTHOR_USER, ADMIN_USER], max: 4 });

const REVIEWER: ReviewerSpec = { name: 'security', instructions: 'Look.', timeoutMinutes: 7, connections: [] };

const walk: WorkflowDefinition = {
    entry: 'first',
    params: [],
    nodes: [
        { name: 'first', kind: 'agent', session: 'fresh', prompt: 'first' },
        { name: 'second', kind: 'agent', session: 'fresh', prompt: 'second' },
    ],
    edges: [{ from: 'first', to: 'second', when: 'succeeded' }],
};

let sql: Sql;
let store: JobStore;
let reviewing: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    reviewing = createJobStore({
        sql,
        orgId: ORG,
        plan: {
            readFor: async () => ({ config: null, error: null, services: [], revision: null, reviewers: [REVIEWER] }),
        },
        githubApp: true,
    });
});

/** The claim of `id`, failing whatever else is queued ahead of it (the org's board is shared by this file's cases). */
const claimOf = async (id: string, s: JobStore = store): Promise<Claim> => {
    for (let i = 0; i < 50; i += 1) {
        const claim = await s.claim(`w-${randomUUID()}`, LEASE_SECONDS);
        if (!claim) break;
        if (claim.id === id) return claim;
        await s.complete(claim.id, claim.leaseToken, { status: 'failed', exitCode: 1, output: 'leftover' });
    }
    throw new Error(`job ${id} was never claimable`);
};

const toGitlab = (id: string) =>
    sql`update job set forge = ${GITLAB.forge}, host = ${GITLAB.host}, repo = ${GITLAB.path}
        where org_id = ${ORG} and id = ${id}`;

/** A queued GitHub root, turned GitLab. */
const gitlabRoot = async (workflow?: boolean): Promise<string> => {
    const { id } = await mustCreate(
        store.create('thread', AUTHOR_USER.id, {
            repo: githubRepo('o/n'),
            executor: null,
            ...(workflow
                ? {
                      workflow: {
                          id: randomUUID(),
                          name: `ref-${randomUUID()}`,
                          node: 'first',
                          snapshot: walk,
                          params: {},
                      },
                  }
                : {}),
        } as never)
    );
    await toGitlab(id);
    return id;
};

/** A finished GitLab root that reported a session: the state a follow-up and a retry accept. */
const finishedGitlabRoot = async (): Promise<string> => {
    const id = await gitlabRoot();
    const claim = await claimOf(id);
    await store.session(id, claim.leaseToken, randomUUID());
    await store.complete(id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
    return id;
};

const tripleOf = async (id: string) => {
    const [row] = await sql`select forge, host, repo from job where org_id = ${ORG} and id = ${id}`;
    return row;
};

const must = <T extends { id: string }>(ref: T | string): T => {
    if (typeof ref === 'string') throw new Error(`refused: ${ref}`);
    return ref;
};

describe.skipIf(!enabled)('derived job rows carry the thread forge and host', () => {
    it('a follow-up child', async () => {
        const root = await finishedGitlabRoot();
        const child = must(await store.createFollowUp(root, 'again', AUTHOR_USER.id));
        expect(await tripleOf(child.id)).toEqual(TRIPLE);
    });

    it('a retry and a reopen', async () => {
        const root = await finishedGitlabRoot();
        const retry = must(await store.createRetry(root, AUTHOR_USER.id));
        expect(await tripleOf(retry.id)).toEqual(TRIPLE);

        const claim = await claimOf(retry.id);
        await store.complete(retry.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });
        await store.markDone(root, AUTHOR_USER.id);
        expect(await store.reopen(root)).toEqual({ result: 'ok' });
        const rows = await sql<{ id: string; forge: string; host: string; repo: string }[]>`
            select id, forge, host, repo from job where org_id = ${ORG} and root_job_id = ${root}
        `;
        expect(rows.length).toBeGreaterThanOrEqual(2);
        for (const row of rows) expect({ forge: row.forge, host: row.host, repo: row.repo }).toEqual(TRIPLE);
    });

    it('a workflow successor', async () => {
        const root = await gitlabRoot(true);
        const claim = await claimOf(root);
        await store.complete(root, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });
        const [second] = await sql<{ id: string }[]>`
            select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'second'
        `;
        expect(await tripleOf(second!.id)).toEqual(TRIPLE);
    });

    it('a review child', async () => {
        const root = await gitlabRoot();
        const caller = await claimOf(root, reviewing);
        const asked = await reviewing.requestReview(caller.id, caller.leaseToken, {
            key: 'sec-1',
            profile: 'security',
            revision: 'h:2',
            ref: reviewRefOf(caller.id, 'sec-1'),
        });
        expect(asked).toMatchObject({ claim: expect.anything() });
        const [review] = await sql<{ id: string }[]>`
            select id from job where org_id = ${ORG} and review_of = ${caller.id}
        `;
        expect(await tripleOf(review!.id)).toEqual(TRIPLE);
    });

    it('a removed thread reclaim, a done thread reclaim and a verdict reclaim', async () => {
        const removed = await finishedGitlabRoot();
        await store.removeThread(removed, null);
        expect(
            await sql`select forge, host, repo from task_reclaim where org_id = ${ORG} and root_job_id = ${removed}`
        ).toEqual([TRIPLE]);

        const done = await finishedGitlabRoot();
        await store.markDone(done, AUTHOR_USER.id);
        expect(
            await sql`select forge, host, repo from task_reclaim where org_id = ${ORG} and root_job_id = ${done}`
        ).toEqual([TRIPLE]);

        await sql`delete from task_reclaim where org_id = ${ORG} and root_job_id = ${done}`;
        await sql.begin((tx) =>
            issueVerdictReclaim(tx, { orgId: ORG }, done, { worker: 'w', leaseToken: randomUUID() })
        );
        expect(
            await sql`select forge, host, repo from task_reclaim where org_id = ${ORG} and root_job_id = ${done}`
        ).toEqual([TRIPLE]);
    });

    it('the execution record after a claim and a PR operation', async () => {
        const root = await gitlabRoot();
        const claim = await claimOf(root);
        expect(
            await sql`select forge, host, repo from job_execution where org_id = ${ORG} and job_id = ${root}`
        ).toEqual([TRIPLE]);

        const written = await store.writePrOperation(root, claim.leaseToken, {
            operationId: randomUUID(),
            operation: 'created',
            repo: GITLAB.path,
            prNumber: 3,
            prUrl: 'https://gl.example/g/sub/p/-/merge_requests/3',
            branch: 'factory/x',
        });
        expect(written).toEqual({ result: 'ok' });
        expect(
            await sql`select forge, host, repo from job_pr_operation where org_id = ${ORG} and job_id = ${root}`
        ).toEqual([TRIPLE]);
    });

    it("an admin's follow-up event", async () => {
        const root = await finishedGitlabRoot();
        const ref = must(await store.createFollowUp(root, 'admin says', ADMIN_USER.id, undefined, undefined, true));
        expect(
            await sql`select forge, host, repo from notification_event
                      where org_id = ${ORG} and job_id = ${ref.id} and kind = 'task.admin_action'`
        ).toEqual([TRIPLE]);
    });

    it('store.create writes the ref it is given', async () => {
        const { id } = await mustCreate(store.create('from a ref', null, { repo: GITLAB, executor: null } as never));
        expect(await tripleOf(id)).toEqual(TRIPLE);
    });
});
