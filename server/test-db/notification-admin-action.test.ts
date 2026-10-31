import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { notificationEventOf } from '@factory-ai/core';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { IdempotencyInput } from '../src/db/jobs/job-store-idempotency.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { createNotificationOutboxStore } from '../src/notifications/outbox-store.js';
import { createNotificationSubscriptionStore } from '../src/notifications/subscription-store.js';
import type { NotificationSubscriptionStore, SubscriptionFields } from '../src/notifications/subscription-store.js';
import { sweepRuntimeWakes } from '../src/db/workflows/workflow-blocks/runtime.js';
import type { WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { useTestDb } from './harness.js';
import { mustCreate, testOrg, testUser } from './fixtures.js';

/**
 * An org admin's follow-up, retry, wait poke or wait cancel on another member's task emits one
 * task.admin_action in the action's transaction, naming the actor and the author (docs/notifications.md).
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const REPO = 'acme/widgets';
const PUBLIC_URL = 'https://board.example.test';
const AUTHOR_USER = testUser('author-admin-event');
const ADMIN_USER = testUser('admin-admin-event');
const MEMBER_USER = testUser('member-admin-event');
const AUTHOR = AUTHOR_USER.id;
const ADMIN = ADMIN_USER.id;
const MEMBER = MEMBER_USER.id;
const db = useTestDb({ orgs: [ORG], users: [AUTHOR_USER, ADMIN_USER, MEMBER_USER], max: 6 });

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

let sql: Sql;
let store: JobStore;
let prs: ReturnType<typeof createPrLifecycleStore>;
let subs: NotificationSubscriptionStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    store = createJobStore({ sql, orgId: ORG, prs });
    subs = createNotificationSubscriptionStore({ sql, orgId: ORG });
});

const fields = (eventKinds: SubscriptionFields['eventKinds']): SubscriptionFields => ({
    connectorKind: 'fake',
    connectorConfig: { target: `room-${Math.random()}` },
    eventKinds,
    repos: [],
    workflows: [],
    enabled: true,
});

const claimOf = async (id: string): Promise<Claim> => {
    for (let i = 0; i < 50; i += 1) {
        const claim = await store.claim(`w-${randomUUID()}`, 300);
        if (!claim) break;
        if (claim.id === id) return claim;
        await store.complete(claim.id, claim.leaseToken, { status: 'failed', exitCode: 1, output: 'leftover' });
    }
    throw new Error(`job ${id} was never claimable`);
};

const finishedTask = async (): Promise<string> => {
    const { id } = await mustCreate(store.create('author task', AUTHOR, { repo: null, executor: null }));
    const claim = await claimOf(id);
    await store.session(claim.id, claim.leaseToken, randomUUID());
    await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
    return id;
};

const publishedThread = async (prNumber: number): Promise<string> => {
    const { id: root } = await mustCreate(
        store.create('start the thread', AUTHOR, {
            repo: REPO,
            executor: null,
            workflow: {
                id: randomUUID(),
                name: `admin-event-${prNumber}`,
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

const must = <T extends { id: string }>(ref: T | string): T => {
    if (typeof ref === 'string') throw new Error(`refused: ${ref}`);
    return ref;
};

interface EventRow {
    id: string;
    kind: string;
    job_id: string;
    root_job_id: string;
    action: string | null;
    actor_user_id: string | null;
    actor_login: string | null;
    author_user_id: string | null;
    author_login: string | null;
    command: string;
}

const adminEvents = (root: string) =>
    sql<EventRow[]>`
        select id, kind, job_id, root_job_id, action, actor_user_id, actor_login, author_user_id, author_login, command
        from notification_event
        where org_id = ${ORG} and root_job_id = ${root} and kind = 'task.admin_action'
        order by occurred_at, id
    `;

const idemKey = (operation: IdempotencyInput['operation']): IdempotencyInput => ({
    operation,
    key: `key-${randomUUID()}`,
    fingerprint: 'fp-a',
});

describe.skipIf(!enabled)('task.admin_action — database', () => {
    it('an admin follow-up emits one event naming actor, author, action and the new job', async () => {
        const root = await finishedTask();
        const ref = must(await store.createFollowUp(root, 'admin says', ADMIN, undefined, undefined, true));

        const rows = await adminEvents(root);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            kind: 'task.admin_action',
            action: 'follow-up',
            job_id: ref.id,
            root_job_id: root,
            actor_user_id: ADMIN,
            actor_login: ADMIN_USER.login,
            author_user_id: AUTHOR,
            author_login: AUTHOR_USER.login,
            command: 'admin says',
        });
    });

    it('an admin retry emits action retry for the new job', async () => {
        const root = await finishedTask();
        const ref = must(await store.createRetry(root, ADMIN, undefined, true));

        const rows = await adminEvents(root);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action: 'retry', job_id: ref.id, actor_user_id: ADMIN });
    });

    it('an admin poke emits action wait-poke for the continuation', async () => {
        const root = await publishedThread(9201);
        expect(await store.pokeWait(root, ADMIN, true)).toEqual({ result: 'ok', woken: true });

        const [continuation] = await sql<{ id: string }[]>`
            select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'review'
        `;
        const rows = await adminEvents(root);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action: 'wait-poke', job_id: continuation!.id, author_user_id: AUTHOR });
    });

    it('an admin cancel emits one event for the root; a second cancel emits nothing', async () => {
        const root = await publishedThread(9202);
        expect(await store.cancelWait(root, ADMIN, true)).toEqual({ result: 'ok' });
        expect(await store.cancelWait(root, ADMIN, true)).toBe('no_wait');

        const rows = await adminEvents(root);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action: 'wait-cancel', job_id: root, actor_user_id: ADMIN });
    });

    it("the owner's own actions emit nothing, even when the owner is an admin", async () => {
        const root = await publishedThread(9203);
        expect(await store.pokeWait(root, AUTHOR, false)).toEqual({ result: 'ok', woken: true });
        expect(await store.cancelWait(root, AUTHOR, true)).not.toBe('forbidden');
        const followed = await finishedTask();
        must(await store.createFollowUp(followed, 'mine', AUTHOR, undefined, undefined, true));
        const retried = await finishedTask();
        must(await store.createRetry(retried, AUTHOR, undefined, true));

        for (const thread of [root, followed, retried]) expect(await adminEvents(thread)).toHaveLength(0);
    });

    it('a sweep wake emits nothing', async () => {
        const root = await publishedThread(9204);
        await prs.recordDelivery({
            deliveryId: `d-${randomUUID()}`,
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 9204,
        });
        await sweepRuntimeWakes({ sql, orgId: ORG, prs });
        expect(await adminEvents(root)).toHaveLength(0);
    });

    it('a refused member action emits nothing', async () => {
        const root = await finishedTask();
        expect(await store.createFollowUp(root, 'nope', MEMBER, undefined, undefined, false)).toBe('forbidden');
        expect(await store.createRetry(root, MEMBER, undefined, false)).toBe('forbidden');
        expect(await adminEvents(root)).toHaveLength(0);
    });

    it('an idempotent replay returns the same job and emits no second event', async () => {
        const root = await finishedTask();
        const input = idemKey('follow-up');
        const first = must(await store.createFollowUp(root, 'once', ADMIN, input, undefined, true));
        const again = must(await store.createFollowUp(root, 'once', ADMIN, input, undefined, true));

        expect(again.id).toBe(first.id);
        expect(await adminEvents(root)).toHaveLength(1);
    });

    it('an admin event fans out to task.admin_action subscriptions only', async () => {
        const wanted = await subs.create(fields(['task.admin_action']));
        const other = await subs.create(fields(['task.blocked']));
        const root = await finishedTask();
        must(await store.createFollowUp(root, 'admin says', ADMIN, undefined, undefined, true));

        const [event] = await adminEvents(root);
        const out = await sql<{ subscription_id: string }[]>`
            select subscription_id from notification_outbox where org_id = ${ORG} and event_id = ${event!.id}
        `;
        expect(out.map((r) => r.subscription_id)).toEqual([wanted.id]);
        expect(out.map((r) => r.subscription_id)).not.toContain(other.id);
    });

    it('the outbox lease carries action, actor and author', async () => {
        const sub = await subs.create(fields(['task.admin_action']));
        const root = await finishedTask();
        must(await store.createFollowUp(root, 'admin says', ADMIN, undefined, undefined, true));

        const outbox = createNotificationOutboxStore({ sql, orgId: ORG });
        const lease = await outbox.lease(1000, 60_000);
        try {
            const item = lease!.items.find((i) => i.subscriptionId === sub.id && i.event.rootJobId === root);
            expect(item!.event).toMatchObject({
                kind: 'task.admin_action',
                action: 'follow-up',
                actor: { id: ADMIN, login: ADMIN_USER.login },
                author: { id: AUTHOR, login: AUTHOR_USER.login },
            });
            expect(notificationEventOf(item!.event, PUBLIC_URL).link).toBe(`${PUBLIC_URL}/tasks/${root}`);
        } finally {
            await outbox.release(lease!.token);
        }
    });

    it('the widened checks accept the kind', async () => {
        await expect(subs.create(fields(['task.admin_action']))).resolves.toBeTruthy();
    });
});
