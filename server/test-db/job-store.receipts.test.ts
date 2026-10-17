import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

/**
 * Issue #821: a settle's answer is durable. An attempt's conclusion — complete, suspend, requeue or
 * a released interrupt — records a receipt in the settle's own transaction, so the identical
 * request replayed after its response was lost answers the original result instead of `lost`, and
 * a different request under the concluded lease is still refused. A threadDone verdict queues its
 * worktree reclaim claimed by the completing worker, and the reclaimed marker follows the ack.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'worker-1';
const LEASE_SECONDS = 300;
const db = useTestDb({ max: 4, orgs: [ORG] });

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

async function queue(): Promise<string> {
    const job = await store.create('do the thing', null, { repo: null, executor: null });
    if (typeof job === 'string') throw new Error(job);
    return job.id;
}

const claim = async (worker = WORKER): Promise<Claim> => {
    const c = await store.claim(worker, LEASE_SECONDS);
    if (!c) throw new Error('nothing was claimable');
    return c;
};

const succeeded = { status: 'succeeded', exitCode: 0, output: 'done' } as const;

const receipts = (id: string) =>
    sql<{ operation: string }[]>`select operation from job_settle_receipt where org_id = ${ORG} and job_id = ${id}`;

const reclaimRows = (root: string) =>
    sql<{ id: string; claimed_by: string | null }[]>`
        select id, claimed_by from task_reclaim where org_id = ${ORG} and root_job_id = ${root}
    `;

const reclaimedAt = async (root: string): Promise<Date | null> => {
    const [row] = await sql<{ worktree_reclaimed_at: Date | null }[]>`
        select worktree_reclaimed_at from job where org_id = ${ORG} and id = ${root}
    `;
    return row!.worktree_reclaimed_at;
};

/**
 * A done thread whose last member is running: the root finished with a session, a follow-up was
 * queued, the root was marked done and the follow-up claimed. Its verdict is the threadDone one.
 */
async function doneThreadRunning(): Promise<{ root: string; followUp: string; lease: Claim }> {
    const root = await queue();
    const first = await claim();
    await store.session(root, first.leaseToken, randomUUID());
    await store.complete(root, first.leaseToken, succeeded);
    const followUp = await store.createFollowUp(root, 'adjust it', null);
    if (typeof followUp === 'string') throw new Error(followUp);
    await store.markDone(root, null);
    const lease = await claim();
    expect(lease.id).toBe(followUp.id);
    return { root, followUp: followUp.id, lease };
}

describe.skipIf(!enabled)('settle receipts — database', () => {
    it('records one receipt per concluded attempt', async () => {
        const id = await queue();
        const c = await claim();
        await store.complete(id, c.leaseToken, succeeded);
        expect(await receipts(id)).toEqual([{ operation: 'complete' }]);
    });

    it('an identical complete replayed after its response was lost answers the original result', async () => {
        const id = await queue();
        const c = await claim();
        const first = await store.complete(id, c.leaseToken, succeeded);
        expect(first).toMatchObject({ result: 'ok', threadDone: false });
        const before = await store.get(id);

        expect(await store.complete(id, c.leaseToken, succeeded)).toEqual(first);
        const after = await store.get(id);
        expect(after).toMatchObject({ status: 'succeeded', output: 'done', finishedAt: before!.finishedAt });
        expect(await receipts(id)).toHaveLength(1);
    });

    it('a conflicting complete under a concluded lease is rejected as lost', async () => {
        const id = await queue();
        const c = await claim();
        await store.complete(id, c.leaseToken, succeeded);
        expect(await store.complete(id, c.leaseToken, { status: 'failed', exitCode: 1, output: 'boom' })).toEqual({
            result: 'lost',
        });
        expect(await store.get(id)).toMatchObject({ status: 'succeeded', output: 'done' });
    });

    it('a complete under a token that never concluded the job stays lost', async () => {
        const id = await queue();
        await claim();
        expect(await store.complete(id, randomUUID(), succeeded)).toEqual({ result: 'lost' });
    });

    it('two identical concurrent completes conclude once with equal answers', async () => {
        const id = await queue();
        const c = await claim();
        const [a, b] = await Promise.all([
            store.complete(id, c.leaseToken, succeeded),
            store.complete(id, c.leaseToken, succeeded),
        ]);
        expect(a).toEqual(b);
        expect(a).toMatchObject({ result: 'ok' });
        expect(await receipts(id)).toHaveLength(1);
    });

    it('a replayed threadDone complete reruns nothing and answers the same reclaim', async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        const first = await store.complete(followUp, lease.leaseToken, succeeded);
        expect(first).toMatchObject({ result: 'ok', threadDone: true, reclaimId: expect.any(String) });
        const threadSize = (await sql`select id from job where org_id = ${ORG} and root_job_id = ${root}`).length;

        expect(await store.complete(followUp, lease.leaseToken, succeeded)).toEqual(first);
        expect(await reclaimRows(root)).toHaveLength(1);
        expect(await sql`select id from job where org_id = ${ORG} and root_job_id = ${root}`).toHaveLength(threadSize);
    });

    it('an identical suspend replay answers its original status', async () => {
        const id = await queue();
        const c = await claim();
        await store.stop(id, null);
        const first = await store.suspend(id, c.leaseToken);
        expect(first).toEqual({ result: 'ok', status: 'stopped' });
        expect(await store.suspend(id, c.leaseToken)).toEqual(first);
        expect(await receipts(id)).toEqual([{ operation: 'suspend' }]);
    });

    it('an identical requeue replay answers its original status', async () => {
        const id = await queue();
        const c = await claim();
        const first = await store.requeue(id, c.leaseToken);
        expect(first).toEqual({ result: 'ok', status: 'queued' });
        expect(await store.requeue(id, c.leaseToken)).toEqual(first);
        expect(await store.get(id)).toMatchObject({ status: 'queued', attempts: 0 });
    });

    it('an identical released interrupt replay answers its original status and records one interruption', async () => {
        const id = await queue();
        const c = await claim();
        const ask = { reason: 'the node was drained', release: true } as const;
        const first = await store.interrupt(id, c.leaseToken, ask);
        expect(first).toEqual({ result: 'ok', status: 'queued' });
        expect(await store.interrupt(id, c.leaseToken, ask)).toEqual(first);
        const row = await store.get(id);
        expect(row!.interruptions).toHaveLength(1);
        expect(row!.attempts).toBe(0);
    });

    it('a released interrupt replayed with a different reason is rejected as lost', async () => {
        const id = await queue();
        const c = await claim();
        await store.interrupt(id, c.leaseToken, { reason: 'drained', release: true });
        expect(await store.interrupt(id, c.leaseToken, { reason: 'evicted', release: true })).toEqual({
            result: 'lost',
        });
    });

    it('a suspend after the attempt completed is rejected as lost', async () => {
        const id = await queue();
        const c = await claim();
        await store.complete(id, c.leaseToken, succeeded);
        expect(await store.suspend(id, c.leaseToken)).toEqual({ result: 'lost' });
    });

    it('a requeue replay of a superseded attempt answers its own receipt and leaves the newer attempt running', async () => {
        const id = await queue();
        const old = await claim();
        await store.requeue(id, old.leaseToken);
        await sql`update job set lease_expires_at = now() where id = ${id}`;
        const fresh = await claim('worker-2');
        const attempts = (await store.get(id))!.attempts;

        expect(await store.requeue(id, old.leaseToken)).toEqual({ result: 'ok', status: 'queued' });
        expect(await store.get(id)).toMatchObject({ status: 'running', attempts });
        expect(await store.requeue(id, fresh.leaseToken)).toEqual({ result: 'ok', status: 'queued' });
    });

    it('an adoption (release false) stays idempotent and writes no receipt', async () => {
        const id = await queue();
        const c = await claim();
        const ask = { reason: 'the previous runner was evicted', release: false, claimSeq: c.claimSeq } as const;
        expect(await store.interrupt(id, c.leaseToken, ask)).toEqual({ result: 'ok', status: 'running' });
        expect(await store.interrupt(id, c.leaseToken, ask)).toEqual({ result: 'ok', status: 'running' });
        expect((await store.get(id))!.interruptions).toHaveLength(1);
        expect(await receipts(id)).toHaveLength(0);
    });
});

describe.skipIf(!enabled)('the verdict-time worktree reclaim — database', () => {
    it('queues the reclaim claimed by the completing worker and leaves the marker unset', async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        const verdict = await store.complete(followUp, lease.leaseToken, succeeded);
        if (verdict.result !== 'ok') throw new Error(verdict.result);
        expect(verdict.threadDone).toBe(true);
        expect(await reclaimRows(root)).toEqual([{ id: verdict.reclaimId, claimed_by: WORKER }]);
        expect(await reclaimedAt(root)).toBeNull();
    });

    it('stamps the marker on the ack of the verdict reclaim', async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        const verdict = await store.complete(followUp, lease.leaseToken, succeeded);
        if (verdict.result !== 'ok' || !verdict.reclaimId) throw new Error('no reclaim was issued');
        expect(await store.ackReclaim(verdict.reclaimId, WORKER)).toBe('ok');
        expect(await reclaimedAt(root)).not.toBeNull();
        expect(await reclaimRows(root)).toHaveLength(0);
    });

    it('a reopen during the verdict reclaim answers reclaiming, and reclaimed only after the ack', async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        const verdict = await store.complete(followUp, lease.leaseToken, succeeded);
        if (verdict.result !== 'ok' || !verdict.reclaimId) throw new Error('no reclaim was issued');
        expect(await store.reopen(root)).toBe('reclaiming');
        await store.ackReclaim(verdict.reclaimId, WORKER);
        expect(await store.reopen(root)).toBe('reclaimed');
    });

    it('an unacked verdict reclaim is offered to the queue once its lease expires', async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        const verdict = await store.complete(followUp, lease.leaseToken, succeeded);
        if (verdict.result !== 'ok' || !verdict.reclaimId) throw new Error('no reclaim was issued');
        await sql`update task_reclaim set lease_expires_at = now() where org_id = ${ORG} and root_job_id = ${root}`;
        expect(await store.claimReclaim('worker-2', LEASE_SECONDS)).toMatchObject({
            id: verdict.reclaimId,
            rootJobId: root,
        });
        expect(await store.ackReclaim(verdict.reclaimId, WORKER)).toBe('lost');
        expect(await reclaimedAt(root)).toBeNull();
    });

    it('a verdict finding a live-claimed reclaim of its root issues none of its own', async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        await sql`
            insert into task_reclaim (org_id, root_job_id, claimed_by, lease_expires_at)
            values (${ORG}, ${root}, 'worker-2', now() + interval '5 minutes')
        `;
        expect(await store.complete(followUp, lease.leaseToken, succeeded)).toEqual({
            result: 'ok',
            threadDone: true,
            reclaimId: null,
        });
        expect(await reclaimRows(root)).toEqual([{ id: expect.any(String), claimed_by: 'worker-2' }]);
    });

    it('a replayed verdict answers no reclaim once its order was withdrawn', async () => {
        // The answer was lost, the reclaim lease ran out, a reopen withdrew the row and the thread
        // moved on: the late replay must not order the tree away from under it.
        const { root, followUp, lease } = await doneThreadRunning();
        const first = await store.complete(followUp, lease.leaseToken, succeeded);
        expect(first).toMatchObject({ reclaimId: expect.any(String) });
        await sql`update task_reclaim set lease_expires_at = now() where org_id = ${ORG} and root_job_id = ${root}`;
        expect(await store.reopen(root)).toEqual({ result: 'ok' });

        expect(await store.complete(followUp, lease.leaseToken, succeeded)).toEqual({
            result: 'ok',
            threadDone: true,
            reclaimId: null,
        });
    });

    it('a verdict racing a reopen of its thread issues no reclaim once the reopen commits', async () => {
        // Reopen's half, held open under the per-root lock: the done stamp cleared, not committed.
        const { root, followUp, lease } = await doneThreadRunning();
        const reopening = await sql.reserve();
        try {
            await reopening`begin`;
            await reopening`select pg_advisory_xact_lock(hashtextextended(${root}::text, 0))`;
            await reopening`
                update job set done_at = null, done_by = null
                where org_id = ${ORG} and root_job_id = ${root} and done_at is not null
            `;
            const verdict = store.complete(followUp, lease.leaseToken, succeeded);
            await new Promise((resolve) => setTimeout(resolve, 300));
            await reopening`commit`;
            expect(await verdict).toMatchObject({ result: 'ok', reclaimId: null });
        } finally {
            reopening.release();
        }
        expect(await reclaimRows(root)).toHaveLength(0);
    });

    it('a verdict takes over an unclaimed reclaim of its root rather than queueing a second', async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        const [queued] = await sql<{ id: string }[]>`
            insert into task_reclaim (org_id, root_job_id) values (${ORG}, ${root}) returning id
        `;
        expect(await store.complete(followUp, lease.leaseToken, succeeded)).toEqual({
            result: 'ok',
            threadDone: true,
            reclaimId: queued!.id,
        });
        expect(await reclaimRows(root)).toEqual([{ id: queued!.id, claimed_by: WORKER }]);
    });
});
