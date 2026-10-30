import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { BatchPlan } from '@factory-ai/core';
import { createBatchStore } from '../src/db/batches/batch-store.js';
import type { BatchStore } from '../src/db/batches/batch-store-types.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { useTestDb } from './harness.js';
import { startRow, testOrg, testUser } from './fixtures.js';
import { batchPlan, headOf as sharedHeadOf, prTask, rootOf, startBatch } from './batch-fixtures.js';

/**
 * BEL-134: task.blocked fires only when a person must act. A plain thread's failure emits when nothing
 * recovers it (notification-events.test.ts); a batch task emits once its durable `attention` is set,
 * on the thread head, never for a failure the batch retries or repairs by itself.
 */
const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;
const db = useTestDb({ orgs: [ORG], users: [ALICE_USER], max: 10 });

let sql: Sql;
let jobs: JobStore;
let store: BatchStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    const prs = createPrLifecycleStore({ sql, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG, prs });
    store = createBatchStore({
        sql,
        orgId: ORG,
        stop: (id, by) => jobs.stop(id, by),
        close: (id, by) => jobs.markDone(id, by),
    });
});

const task = (key: string) => ({
    key,
    objective: `do ${key}`,
    acceptance: `${key} works`,
    verification: 'npm test',
    completion: { kind: 'accepted', condition: 'reviewed' },
});
const planWith = (budgets: Record<string, number> = {}): BatchPlan =>
    batchPlan('Blocked', [{ key: 'one', tasks: [task('a')] }], budgets);
const frozen = (source: BatchPlan) => startBatch(store, source, ALICE);
const headOf = (root: string) => sharedHeadOf(sql, root);

/** Launches the batch and returns its single task's root. */
async function launched(source: BatchPlan): Promise<{ id: string; root: string }> {
    const id = await frozen(source);
    await store.reconcile(id);
    return { id, root: await rootOf(store, id, 'a') };
}

/** Ends the thread head's run as failed with a structured reason and cause, as the verdict does. */
async function failWith(
    root: string,
    failureKind: string | null,
    status: 'failed' | 'dead' = 'failed',
    failureCause: string | null = null
) {
    const head = await headOf(root);
    await startRow(sql, head.id);
    await sql`
        update job set status = ${status}, failure_kind = ${failureKind}, failure_cause = ${failureCause},
            finished_at = now(), lease_token = null
        where id = ${head.id}
    `;
}

const blockedOf = (root: string) =>
    sql<{ id: string; job_id: string; reason: string | null; kind: string }[]>`
        select id, job_id, reason, kind from notification_event
        where org_id = ${ORG} and root_job_id = ${root} and kind = 'task.blocked' order by occurred_at, id
    `;

const idOf = async (jobId: string): Promise<string> =>
    (await sql<{ id: string }[]>`select md5(${jobId}::text || '/task.blocked')::uuid as id`)[0]!.id;

/** A running head with one pending question, as the worker leaves it. */
async function askQuestion(root: string) {
    const head = await headOf(root);
    const lease = randomUUID();
    await sql`update job set status = 'running', claimed_by = 'w1', started_at = now() where id = ${head.id}`;
    await sql`update job set lease_token = ${lease}, attempts = 1, claim_seq = 1 where id = ${head.id}`;
    await sql`
        insert into job_question (org_id, job_id, question_id, attempt, claim_seq, lease_token, questions, state)
        values (${ORG}, ${head.id}, 'q1', 1, 1, ${lease}, ${sql.json([{ question: 'which db?' }])}, 'pending')
    `;
}

describe.skipIf(!enabled)('task.blocked for a batch task', () => {
    it('an infrastructure failure the batch retries emits nothing', async () => {
        const { id, root } = await launched(planWith());
        await failWith(root, 'timeout');
        await store.reconcile(id);
        expect(await blockedOf(root)).toHaveLength(0);
    });

    it('a repairable gate failure the batch repairs emits nothing', async () => {
        const { id, root } = await launched(planWith());
        await failWith(root, 'gate', 'failed', 'verification');
        await store.reconcile(id);
        expect(await blockedOf(root)).toHaveLength(0);
    });

    it('recovery budget exhausted emits one task.blocked on the failed head', async () => {
        const { id, root } = await launched(planWith({ repairs: 1 }));
        await failWith(root, 'gate', 'failed', 'verification');
        await store.reconcile(id);
        await failWith(root, 'gate', 'failed', 'verification');
        await store.reconcile(id);
        const head = await headOf(root);
        const rows = await blockedOf(root);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            job_id: head.id,
            id: await idOf(head.id),
            reason: 'budget:gate:verification',
        });
    });

    it('a run that reports itself blocked emits one task.blocked', async () => {
        const { id, root } = await launched(planWith());
        await failWith(root, 'blocked');
        await store.reconcile(id);
        const rows = await blockedOf(root);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.reason).toBe('blocked:blocked');
    });

    it('a dead run with no infrastructure budget emits one task.blocked', async () => {
        const { id, root } = await launched(planWith({ infraRetries: 0 }));
        await failWith(root, null, 'dead');
        await store.reconcile(id);
        const rows = await blockedOf(root);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.reason).toBe('budget:dead');
    });

    it('a failure in a cancelled batch emits nothing', async () => {
        const { id, root } = await launched(planWith());
        // The fence alone: the head's run is still going when the cancellation lands, then fails.
        await sql`update batch set cancelled_at = now() where org_id = ${ORG} and id = ${id}`;
        await failWith(root, 'gate', 'failed', 'verification');
        await store.reconcile(id);
        expect(await blockedOf(root)).toHaveLength(0);
    });

    it('a running task asking a question emits no task.blocked', async () => {
        const { id, root } = await launched(planWith());
        await askQuestion(root);
        await store.reconcile(id);
        expect((await store.get(id))!.tasks[0]).toMatchObject({ execution: 'running', attention: 'question' });
        expect(await blockedOf(root)).toHaveLength(0);
    });

    it('a run that dies with its question unanswered emits one task.blocked', async () => {
        const { id, root } = await launched(planWith());
        await askQuestion(root);
        await store.reconcile(id);
        const head = await headOf(root);
        await sql`update job_question set state = 'expired' where job_id = ${head.id}`;
        await failWith(root, 'timeout');
        await store.reconcile(id);
        expect((await store.get(id))!.tasks[0]).toMatchObject({ execution: 'failed', attention: 'question' });
        const rows = await blockedOf(root);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.reason).toBe('question:timeout');
    });

    it('an execution change alone on a question task emits task.blocked', async () => {
        const { id, root } = await launched(planWith());
        await askQuestion(root);
        await store.reconcile(id);
        await failWith(root, 'timeout');
        await sql`update batch_task set execution = 'failed' where org_id = ${ORG} and root_job_id = ${root}`;
        const rows = await blockedOf(root);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.reason).toBe('question:timeout');
    });

    it('an attention set and cleared in one transaction emits nothing', async () => {
        const { root } = await launched(planWith());
        await failWith(root, 'timeout');
        await sql.begin(async (tx) => {
            await tx`update batch_task set attention = 'budget' where org_id = ${ORG} and root_job_id = ${root}`;
            await tx`update batch_task set attention = null where org_id = ${ORG} and root_job_id = ${root}`;
        });
        expect(await blockedOf(root)).toHaveLength(0);
    });

    it('a replayed and concurrent reconcile emits once', async () => {
        const { id, root } = await launched(planWith({ infraRetries: 0 }));
        await failWith(root, null, 'dead');
        await Promise.all([store.reconcile(id), store.reconcile(id)]);
        await store.reconcile(id);
        expect(await blockedOf(root)).toHaveLength(1);
    });

    it('a refused repair emits task.blocked', async () => {
        const source = batchPlan('Busy', [{ key: 'one', tasks: [prTask('a')] }]);
        const { id, root } = await launched(source);
        await failWith(root, 'gate', 'failed', 'verification');
        // An older member still queued under the failed head: the repair is refused, not queued behind it.
        await sql`
            insert into job (org_id, command, created_by, repo, root_job_id, created_at)
            select org_id, 'busy', created_by, repo, root_job_id, created_at - interval '1 minute'
            from job where id = ${root}
        `;
        await store.reconcile(id);
        expect((await store.get(id))!.tasks[0]).toMatchObject({ execution: 'failed', attention: 'refused' });
        const rows = await blockedOf(root);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.reason).toBe('refused');
    });
});
