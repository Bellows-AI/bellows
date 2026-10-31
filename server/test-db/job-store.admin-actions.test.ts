import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { ConnectionRefusedError } from '../src/db/connection-bindings.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { sweepRuntimeWakes } from '../src/db/workflows/workflow-blocks/runtime.js';
import type { WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { useTestDb } from './harness.js';
import { mustCreate, oauthConnection, testOrg, testUser } from './fixtures.js';

/**
 * An org admin acts on another member's task: the row's `created_by` is the actor, the thread root's
 * `execution_user_id` stays the owner, and the claim runs every row of the thread as the owner.
 */

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
let otherOrgStore: JobStore;
let prs: ReturnType<typeof createPrLifecycleStore>;
/** The targets the env resolver was asked for, newest last. */
const envTargets: { userId: string | null; repo: string | null }[] = [];

const ORG = testOrg();
const OTHER_ORG = testOrg();
const REPO = 'acme/widgets';
const LEASE_SECONDS = 300;
const AUTHOR_USER = testUser('author-admin-actions');
const ADMIN_USER = testUser('admin-admin-actions');
const MEMBER_USER = testUser('member-admin-actions');
const AUTHOR = AUTHOR_USER.id;
const ADMIN = ADMIN_USER.id;
const MEMBER = MEMBER_USER.id;

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [AUTHOR_USER, ADMIN_USER, MEMBER_USER], max: 8 });

const waitingWorkflow: WorkflowDefinition = {
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

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    store = createJobStore({
        sql,
        orgId: ORG,
        prs,
        executorConfig: createUserExecutorStore({ sql, orgId: ORG }),
        env: {
            async resolveFor(target) {
                envTargets.push(target);
                return {};
            },
        },
    });
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
});

/** Claims until the named job comes up; anything else claimed on the way belongs to an earlier case and is failed. */
const claimOf = async (id: string): Promise<Claim> => {
    for (let i = 0; i < 50; i += 1) {
        const claim = await store.claim(`w-${randomUUID()}`, LEASE_SECONDS);
        if (!claim) break;
        if (claim.id === id) return claim;
        await store.complete(claim.id, claim.leaseToken, { status: 'failed', exitCode: 1, output: 'leftover' });
    }
    throw new Error(`job ${id} was never claimable`);
};

/** Takes the claim to a succeeded verdict that reported a session. */
const finish = async (claim: Claim): Promise<void> => {
    await store.session(claim.id, claim.leaseToken, randomUUID());
    await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
};

/** A finished task of `owner`'s: the thread root, terminal and idle. */
const finishedTask = async (owner: string | null = AUTHOR, executor: string | null = null): Promise<string> => {
    const { id } = await mustCreate(store.create('author task', owner, { repo: null, executor }));
    await finish(await claimOf(id));
    return id;
};

const must = <T extends { id: string }>(ref: T | string): T => {
    if (typeof ref === 'string') throw new Error(`refused: ${ref}`);
    return ref;
};

const rowOf = async (id: string) => {
    const [row] = await sql<{ created_by: string | null; session_id: string | null; root_job_id: string }[]>`
        select created_by, session_id, root_job_id from job where id = ${id}
    `;
    return row!;
};

describe.skipIf(!enabled)('admin follow-up and retry', () => {
    it("an admin follows up another member's finished task", async () => {
        const root = await finishedTask();
        const parent = await rowOf(root);

        const ref = must(await store.createFollowUp(root, 'admin says', ADMIN, undefined, undefined, true));

        const row = await rowOf(ref.id);
        expect(row.created_by).toBe(ADMIN);
        expect(row.root_job_id).toBe(root);
        expect(row.session_id).toBe(parent.session_id);
        const chain = await store.thread(root);
        expect(chain?.find((job) => job.id === ref.id)?.actingFor?.id).toBe(AUTHOR);
        expect(chain?.find((job) => job.id === root)?.actingFor).toBeNull();
    });

    it("an admin retries another member's terminal task", async () => {
        const root = await finishedTask();

        const ref = must(await store.createRetry(root, ADMIN, undefined, true));

        expect((await rowOf(ref.id)).created_by).toBe(ADMIN);
        expect((await store.thread(root))?.find((job) => job.id === ref.id)?.actingFor?.id).toBe(AUTHOR);
    });

    it("a member still cannot follow up or retry another member's task", async () => {
        const root = await finishedTask();

        expect(await store.createFollowUp(root, 'x', MEMBER)).toBe('forbidden');
        expect(await store.createFollowUp(root, 'x', MEMBER, undefined, undefined, false)).toBe('forbidden');
        expect(await store.createRetry(root, MEMBER)).toBe('forbidden');
        expect(await store.createRetry(root, MEMBER, undefined, false)).toBe('forbidden');
    });

    it('the admin flag with a null caller is not admin', async () => {
        const root = await finishedTask();

        expect(await store.createFollowUp(root, 'x', null, undefined, undefined, true)).toBe('forbidden');
        expect(await store.createRetry(root, null, undefined, true)).toBe('forbidden');
    });

    it("another org's admin answers missing", async () => {
        const root = await finishedTask();

        expect(await otherOrgStore.createFollowUp(root, 'x', ADMIN, undefined, undefined, true)).toBe('missing');
        expect(await otherOrgStore.createRetry(root, ADMIN, undefined, true)).toBe('missing');
    });

    it("the author can still follow up after an admin's turn", async () => {
        const root = await finishedTask();
        const adminTurn = must(await store.createFollowUp(root, 'admin says', ADMIN, undefined, undefined, true));
        await finish(await claimOf(adminTurn.id));

        // A plain member is still locked out of the thread whose head the admin wrote.
        expect(await store.createRetry(adminTurn.id, MEMBER)).toBe('forbidden');
        const again = await store.createFollowUp(adminTurn.id, 'author says', AUTHOR);
        expect(typeof again).toBe('object');
    });

    it("an admin's turn claims in the author's workspace and identity", async () => {
        const root = await finishedTask();
        const ref = must(await store.createFollowUp(root, 'admin says', ADMIN, undefined, undefined, true));

        const claim = await claimOf(ref.id);

        expect(claim.workspacePath).toBe(`${ORG}/${AUTHOR}`);
        expect(claim.userId).toBe(AUTHOR);
        expect((await store.get(ref.id))?.workspacePath).toBe(`${ORG}/${AUTHOR}`);
    });

    it("an admin-authored row under the author's root claims as the author whatever its created_by", async () => {
        const root = await finishedTask();
        const parent = await rowOf(root);
        const [seeded] = await sql<{ id: string }[]>`
            insert into job (org_id, command, created_by, repo, parent_job_id, session_id, root_job_id)
            values (${ORG}, 'seeded admin turn', ${ADMIN}, null, ${root}, ${parent.session_id}, ${root})
            returning id
        `;

        const claim = await claimOf(seeded!.id);

        expect(claim.workspacePath).toBe(`${ORG}/${AUTHOR}`);
        expect(claim.userId).toBe(AUTHOR);
    });

    it("an admin's turn resolves the author's user-scoped executor", async () => {
        await createUserExecutorStore({ sql, orgId: ORG }).replace(AUTHOR, [
            { name: 'mine', type: 'claude-code', config: { model: 'author-model' } },
        ]);
        const root = await finishedTask(AUTHOR, 'mine');
        const ref = must(await store.createFollowUp(root, 'admin says', ADMIN, undefined, undefined, true));

        const claim = await claimOf(ref.id);

        expect(claim.executorType).toBe('claude-code');
        expect(claim.executorRefusal).toBeNull();
    });

    it("an admin's turn resolves the author's member env", async () => {
        const root = await finishedTask();
        const ref = must(await store.createFollowUp(root, 'admin says', ADMIN, undefined, undefined, true));
        envTargets.length = 0;

        await claimOf(ref.id);

        expect(envTargets.length).toBeGreaterThan(0);
        expect(envTargets.at(-1)?.userId).toBe(AUTHOR);
    });

    it('refusal order is unchanged for an admin', async () => {
        const busy = await mustCreate(store.create('still queued', AUTHOR, { repo: null, executor: null }));
        expect(await store.createFollowUp(busy.id, 'x', ADMIN, undefined, undefined, true)).toBe('not_finished');
        expect(await store.createRetry(busy.id, ADMIN, undefined, true)).toBe('not_finished');

        const closed = await finishedTask();
        await store.markDone(closed, AUTHOR);
        expect(await store.createFollowUp(closed, 'x', ADMIN, undefined, undefined, true)).toBe('task_done');
        expect(await store.createRetry(closed, ADMIN, undefined, true)).toBe('task_done');
    });

    it('explicit connections on an admin follow-up are refused and queue nothing', async () => {
        const root = await finishedTask();
        const connection = await oauthConnection(sql, ORG, ADMIN);
        const count = () => sql<{ n: number }[]>`select count(*)::int as n from job where root_job_id = ${root}`;
        const before = (await count())[0]!.n;

        await expect(store.createFollowUp(root, 'x', ADMIN, undefined, [connection.id], true)).rejects.toBeInstanceOf(
            ConnectionRefusedError
        );

        expect((await count())[0]!.n).toBe(before);
    });
});

const publishedThread = async (prNumber: number): Promise<string> => {
    const { id: root } = await mustCreate(
        store.create('start the thread', AUTHOR, {
            repo: REPO,
            executor: null,
            workflow: {
                id: randomUUID(),
                name: `admin-wait-${prNumber}`,
                node: waitingWorkflow.entry,
                snapshot: waitingWorkflow,
                params: {},
            },
        })
    );
    const claim = await claimOf(root);
    await store.session(claim.id, claim.leaseToken, `sess-${prNumber}`);
    await store.complete(claim.id, claim.leaseToken, {
        status: 'succeeded',
        exitCode: 0,
        output: 'published',
        publication: {
            repo: REPO,
            prNumber,
            prUrl: `https://github.com/${REPO}/pull/${prNumber}`,
            headBranch: `factory/${root}`,
            baseBranch: 'main',
        },
    });
    return root;
};

const continuationOf = async (root: string) => {
    const rows = await sql<{ id: string; created_by: string | null }[]>`
        select id, created_by from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'review'
    `;
    return rows;
};

describe.skipIf(!enabled)('admin wait control', () => {
    it("an admin cancels another member's wait; a member is forbidden", async () => {
        const root = await publishedThread(9101);

        expect(await store.cancelWait(root, MEMBER, false)).toBe('forbidden');
        expect(await store.cancelWait(root, ADMIN, true)).toEqual({ result: 'ok' });

        const [wait] = await sql<{ cancelled_by: string | null }[]>`
            select cancelled_by from workflow_wait where org_id = ${ORG} and root_job_id = ${root}
        `;
        expect(wait?.cancelled_by).toBe(ADMIN);
    });

    it("an admin pokes another member's wait: the continuation is the admin's turn", async () => {
        const root = await publishedThread(9102);

        expect(await store.pokeWait(root, MEMBER, false)).toBe('forbidden');
        expect(await store.pokeWait(root, ADMIN, true)).toEqual({ result: 'ok', woken: true });

        const [continuation] = await continuationOf(root);
        expect(continuation?.created_by).toBe(ADMIN);
        const chain = await store.thread(root);
        expect(chain?.find((job) => job.id === continuation!.id)?.actingFor?.id).toBe(AUTHOR);
        const claim = await claimOf(continuation!.id);
        expect(claim.workspacePath).toBe(`${ORG}/${AUTHOR}`);
        expect(claim.userId).toBe(AUTHOR);
    });

    it("the author's own poke is unchanged", async () => {
        const root = await publishedThread(9103);

        expect(await store.pokeWait(root, AUTHOR)).toEqual({ result: 'ok', woken: true });

        const [continuation] = await continuationOf(root);
        expect(continuation?.created_by).toBe(AUTHOR);
        expect((await store.thread(root))?.find((job) => job.id === continuation!.id)?.actingFor).toBeNull();
    });

    it('an admin who is the owner pokes as an ordinary author', async () => {
        const root = await publishedThread(9104);

        expect(await store.pokeWait(root, AUTHOR, true)).toEqual({ result: 'ok', woken: true });

        expect((await continuationOf(root))[0]?.created_by).toBe(AUTHOR);
    });

    it('a sweep wake records no actor', async () => {
        const root = await publishedThread(9105);
        await prs.recordDelivery({
            deliveryId: `d-${randomUUID()}`,
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 9105,
        });

        await sweepRuntimeWakes({ sql, orgId: ORG, prs });

        const rows = await continuationOf(root);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.created_by).toBe(AUTHOR);
    });
});
