import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createBatchStore } from '../src/db/batches/batch-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { batchPlan, BATCH_REPO, startBatch } from './batch-fixtures.js';
import { startRow, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * BATCHES_ENABLED off: a batch's thread is unreachable through the task paths. The rows a
 * batch left are kept — the flag only stops them being claimed, retried, followed up or force-closed —
 * and a job outside a batch behaves the same either way.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;

const db = useTestDb({ orgs: [ORG], users: [ALICE_USER] });

let sql: Sql;
let on: JobStore;
let off: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    on = createJobStore({ sql, orgId: ORG });
    off = createJobStore({ sql, orgId: ORG, batches: false });
});

/** A started, dispatched one-task batch; resolves to the task's root job. */
async function dispatched(): Promise<string> {
    const batches = createBatchStore({
        sql,
        orgId: ORG,
        stop: (id, by) => on.stop(id, by),
        close: (id, by) => on.markDone(id, by),
    });
    const plan = batchPlan('Flag', [
        {
            key: 'one',
            tasks: [
                {
                    key: 'a',
                    objective: 'do a',
                    acceptance: 'a works',
                    verification: 'npm test',
                    completion: { kind: 'accepted', condition: 'reviewed' },
                },
            ],
        },
    ]);
    const id = await startBatch(batches, plan, ALICE);
    await batches.reconcile(id);
    return (await batches.get(id))!.tasks[0]!.rootJobId!;
}

async function finish(id: string, status: 'failed' | 'succeeded') {
    await startRow(sql, id);
    await sql`update job set status = ${status}, finished_at = now(), lease_token = null where id = ${id}`;
}

describe.skipIf(!enabled)('batches off: the claim', () => {
    it('skips a queued batch job, keeps the row, and still claims a single task', async () => {
        const root = await dispatched();
        const loose = (await off.create('echo hi', ALICE, {
            repo: BATCH_REPO,
            executor: null,
        })) as { id: string };

        expect(await off.claim('w1', 300)).toMatchObject({ id: loose.id });
        expect(await off.claim('w1', 300)).toBeNull();
        const [row] = await sql`select status from job where id = ${root}`;
        expect(row!.status).toBe('queued');
    });

    it('claims the batch job again once the flag is on', async () => {
        const root = await dispatched();
        expect((await on.claim('w1', 300)) as Claim).toMatchObject({ id: root });
    });
});

describe.skipIf(!enabled)('batches off: retry, follow-up and force-close on a batch thread', () => {
    it('refuses a retry with batches_disabled and inserts nothing', async () => {
        const root = await dispatched();
        await finish(root, 'failed');
        expect(await off.createRetry(root, ALICE)).toBe('batches_disabled');
        expect(Number((await sql`select count(*) from job where root_job_id = ${root}`)[0]!.count)).toBe(1);
    });

    it('refuses a follow-up with batches_disabled and inserts nothing', async () => {
        const root = await dispatched();
        await finish(root, 'succeeded');
        expect(await off.createFollowUp(root, 'adjust', ALICE)).toBe('batches_disabled');
        expect(Number((await sql`select count(*) from job where root_job_id = ${root}`)[0]!.count)).toBe(1);
    });

    it('refuses a Done on a live batch thread with batches_disabled; on, it still answers batch', async () => {
        const root = await dispatched();
        await finish(root, 'succeeded');
        expect(await off.markDone(root, ALICE)).toBe('batches_disabled');
        expect(await on.markDone(root, ALICE)).toBe('batch');
    });

    it('retries and follows up a job outside a batch the same with the flag off', async () => {
        const loose = (await off.create('echo hi', ALICE, {
            repo: BATCH_REPO,
            executor: null,
        })) as { id: string };
        await finish(loose.id, 'failed');
        expect(await off.createRetry(loose.id, ALICE)).toMatchObject({
            id: expect.any(String),
        });
    });
});
