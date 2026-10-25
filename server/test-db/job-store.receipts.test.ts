import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

/**
 * Issue #821: a settle's answer is durable. An attempt's conclusion — complete, suspend or
 * a released interrupt — records a receipt in the settle's own transaction, so the identical
 * request replayed after its response was lost answers the original result instead of `lost`, and
 * a different request under the concluded lease is still refused. A threadDone verdict queues its
 * worktree reclaim owned by the completing attempt's lease token, and the reclaimed marker follows
 * the ack.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'worker-1';
const LEASE_SECONDS = 300;
/** Another acquisition's ownership token. */
const OTHER_TOKEN = randomUUID();
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
    sql<{ id: string; claimed_by: string | null; claim_token: string | null }[]>`
        select id, claimed_by, claim_token from task_reclaim where org_id = ${ORG} and root_job_id = ${root}
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

    // Issue #845: a verdict settles the claim's launch as unknown when nothing proved it, and a
    // replay of that verdict neither rewrites it nor records a second execution.
    it('settles an unproven launch as unknown once, and a replayed complete leaves it alone', async () => {
        const id = await queue();
        const c = await claim();
        const launch = () =>
            sql<
                { launch: string; updated_at: Date }[]
            >`select launch, updated_at from job_execution where job_id = ${id}`;
        await store.complete(id, c.leaseToken, succeeded);
        const [settled] = await launch();
        expect(settled?.launch).toBe('unknown');

        await store.complete(id, c.leaseToken, succeeded);
        expect(await launch()).toEqual([settled]);
    });

    // Issue #845/#847: a normal run reports its session as observed, and its complete then ends the
    // claim `observed` with the end stamped, not unknown.
    it('settles a claim whose session was reported as observed as observed, with its end stamped', async () => {
        const id = await queue();
        const c = await claim();
        await store.session(id, c.leaseToken, randomUUID(), { observed: true });
        await store.complete(id, c.leaseToken, succeeded);
        const [row] = await sql<
            { launch: string; ended_at: Date | null }[]
        >`select launch, ended_at from job_execution where job_id = ${id}`;
        expect(row?.launch).toBe('observed');
        expect(row?.ended_at).not.toBeNull();
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

    it('a released-interrupt replay of a superseded attempt answers its own receipt and leaves the newer attempt running', async () => {
        const id = await queue();
        const old = await claim();
        const interruption = { reason: 'drained', release: true } as const;
        const first = await store.interrupt(id, old.leaseToken, interruption);
        await sql`update job set lease_expires_at = now() where id = ${id}`;
        const fresh = await claim('worker-2');
        const attempts = (await store.get(id))!.attempts;

        expect(await store.interrupt(id, old.leaseToken, interruption)).toEqual(first);
        expect(await store.get(id)).toMatchObject({ status: 'running', attempts });
        expect(fresh.leaseToken).not.toBe(old.leaseToken);
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
    it("queues the reclaim owned by the completing attempt's lease token and leaves the marker unset", async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        const verdict = await store.complete(followUp, lease.leaseToken, succeeded);
        if (verdict.result !== 'ok') throw new Error(verdict.result);
        expect(verdict.threadDone).toBe(true);
        expect(await reclaimRows(root)).toEqual([
            { id: verdict.reclaimId, claimed_by: WORKER, claim_token: lease.leaseToken },
        ]);
        expect(await reclaimedAt(root)).toBeNull();
    });

    it('stamps the marker on the ack of the verdict reclaim', async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        const verdict = await store.complete(followUp, lease.leaseToken, succeeded);
        if (verdict.result !== 'ok' || !verdict.reclaimId) throw new Error('no reclaim was issued');
        expect(await store.ackReclaim(verdict.reclaimId, lease.leaseToken)).toBe('ok');
        expect(await reclaimedAt(root)).not.toBeNull();
        expect(await reclaimRows(root)).toHaveLength(0);
    });

    it('a reopen during the verdict reclaim answers reclaiming, and reclaimed only after the ack', async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        const verdict = await store.complete(followUp, lease.leaseToken, succeeded);
        if (verdict.result !== 'ok' || !verdict.reclaimId) throw new Error('no reclaim was issued');
        expect(await store.reopen(root)).toBe('reclaiming');
        await store.ackReclaim(verdict.reclaimId, lease.leaseToken);
        expect(await store.reopen(root)).toBe('reclaimed');
    });

    it("a queue re-acquisition of an expired verdict reclaim fences the attempt's ack and renew", async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        const verdict = await store.complete(followUp, lease.leaseToken, succeeded);
        if (verdict.result !== 'ok' || !verdict.reclaimId) throw new Error('no reclaim was issued');
        await sql`update task_reclaim set lease_expires_at = now() where org_id = ${ORG} and root_job_id = ${root}`;
        const requeued = await store.claimReclaim(WORKER, LEASE_SECONDS);
        expect(requeued).toMatchObject({ id: verdict.reclaimId, rootJobId: root });
        expect(requeued?.token).not.toBe(lease.leaseToken);

        // The same worker name, a different acquisition: the name proves nothing, the token does.
        expect(await store.renewReclaim(verdict.reclaimId, lease.leaseToken, LEASE_SECONDS)).toEqual({
            result: 'lost',
        });
        expect(await store.ackReclaim(verdict.reclaimId, lease.leaseToken)).toBe('lost');
        expect(await reclaimedAt(root)).toBeNull();
        expect(await store.ackReclaim(verdict.reclaimId, requeued!.token)).toBe('ok');
        expect(await reclaimedAt(root)).not.toBeNull();
    });

    it('a replayed threadDone verdict answers no reclaim once another acquisition owns the row', async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        const first = await store.complete(followUp, lease.leaseToken, succeeded);
        expect(first).toMatchObject({ reclaimId: expect.any(String) });
        await sql`update task_reclaim set lease_expires_at = now() where org_id = ${ORG} and root_job_id = ${root}`;
        expect(await store.claimReclaim(WORKER, LEASE_SECONDS)).not.toBeNull();

        expect(await store.complete(followUp, lease.leaseToken, succeeded)).toEqual({
            result: 'ok',
            threadDone: true,
            reclaimId: null,
        });
    });

    it('a verdict finding a live-claimed reclaim of its root issues none of its own', async () => {
        const { root, followUp, lease } = await doneThreadRunning();
        await sql`
            insert into task_reclaim (org_id, root_job_id, claimed_by, claim_token, lease_expires_at)
            values (${ORG}, ${root}, 'worker-2', ${OTHER_TOKEN}, now() + interval '5 minutes')
        `;
        expect(await store.complete(followUp, lease.leaseToken, succeeded)).toEqual({
            result: 'ok',
            threadDone: true,
            reclaimId: null,
        });
        expect(await reclaimRows(root)).toEqual([
            { id: expect.any(String), claimed_by: 'worker-2', claim_token: OTHER_TOKEN },
        ]);
    });

    it('a replayed verdict answers no reclaim once its order lapsed, and the lapsed order still holds reopen off', async () => {
        // The answer was lost and the reclaim lease ran out: the late replay must not order a
        // removal its lease no longer covers, and the row an acquisition took is never withdrawn.
        const { root, followUp, lease } = await doneThreadRunning();
        const first = await store.complete(followUp, lease.leaseToken, succeeded);
        expect(first).toMatchObject({ reclaimId: expect.any(String) });
        await sql`update task_reclaim set lease_expires_at = now() where org_id = ${ORG} and root_job_id = ${root}`;
        expect(await store.reopen(root)).toBe('reclaiming');
        expect(await reclaimRows(root)).toHaveLength(1);

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
        expect(await reclaimRows(root)).toEqual([
            { id: queued!.id, claimed_by: WORKER, claim_token: lease.leaseToken },
        ]);
    });

    it('a verdict taking over an unclaimed reclaim never withdraws an expired acquisition of its root', async () => {
        // The acquired row's group may still be deleting: only its ack removes it.
        const { root, followUp, lease } = await doneThreadRunning();
        const [queued] = await sql<{ id: string }[]>`
            insert into task_reclaim (org_id, root_job_id, created_at)
            values (${ORG}, ${root}, now() - interval '1 minute') returning id
        `;
        const [acquired] = await sql<{ id: string }[]>`
            insert into task_reclaim (org_id, root_job_id, claimed_by, claim_token, lease_expires_at)
            values (${ORG}, ${root}, 'worker-2', ${OTHER_TOKEN}, now() - interval '1 minute')
            returning id
        `;
        expect(await store.complete(followUp, lease.leaseToken, succeeded)).toMatchObject({ reclaimId: queued!.id });
        expect(await reclaimRows(root)).toEqual(
            expect.arrayContaining([{ id: acquired!.id, claimed_by: 'worker-2', claim_token: OTHER_TOKEN }])
        );
        expect(await store.ackReclaim(acquired!.id, OTHER_TOKEN)).toBe('ok');
    });
});
