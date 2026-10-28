import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createCommerceStore, type CommerceStore } from '../src/db/commerce-store.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

/** BEL-146: the per-org usage outbox over `job_execution`, and the member read of the pushed plan. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER = testOrg();
const LEASE_MS = 300_000;
const MINUTE_MS = 60_000;
const db = useTestDb({ orgs: [ORG, OTHER] });

let sql: Sql;
let store: CommerceStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createCommerceStore({ sql, orgId: ORG });
});

interface ClaimFixture {
    org?: string;
    job?: string;
    seq?: number;
    origin?: 'claim' | 'backfill';
    open?: boolean;
    minutes?: number;
    launch?: string;
    removed?: boolean;
    requesting?: string | null;
}

/** A `job_execution` row; closed by default, with a `minutes`-long window. */
const claim = async (f: ClaimFixture = {}): Promise<{ job: string; seq: number }> => {
    const job = f.job ?? randomUUID();
    const seq = f.seq ?? 1;
    const org = f.org ?? ORG;
    const origin = f.origin ?? 'claim';
    const start = new Date('2026-08-01T00:00:00Z');
    const end = new Date(start.getTime() + (f.minutes ?? 7) * MINUTE_MS);
    await sql`
        insert into job_execution (org_id, job_id, claim_seq, root_job_id, requesting_job_id, launch, origin,
                                   removed_at, created_at, ended_at)
        values (${org}, ${job}, ${seq}, ${job}, ${f.requesting ?? null}, ${f.launch ?? 'observed'}, ${origin},
                ${f.removed ? new Date() : null},
                ${origin === 'backfill' ? null : start}, ${f.open || origin === 'backfill' ? null : end})
    `;
    return { job, seq };
};

const outbox = (org = ORG) =>
    sql<
        {
            job_id: string;
            claim_seq: string;
            reported_at: Date | null;
            failures: number;
            error_code: string | null;
            next_attempt_at: Date;
        }[]
    >`
        select job_id, claim_seq, reported_at, failures, error_code, next_attempt_at
        from commerce_usage_report where org_id = ${org} order by job_id, claim_seq`;

const lapse = (job: string) =>
    sql`update commerce_usage_report set claimed_until = now() - interval '1 second' where job_id = ${job}`;

describe.skipIf(!enabled)('commerce store — database', () => {
    it('enqueues each closed claim once', async () => {
        await claim();
        await claim();
        await store.enqueueUsage();
        await store.enqueueUsage();
        expect(await outbox()).toHaveLength(2);
    });

    it('never enqueues an open claim or a backfill row', async () => {
        await claim({ open: true });
        await claim({ origin: 'backfill' });
        await store.enqueueUsage();
        expect(await outbox()).toHaveLength(0);
    });

    it("enqueues a removed job's claims", async () => {
        const { job } = await claim({ removed: true });
        await store.enqueueUsage();
        expect((await outbox()).map((r) => r.job_id)).toEqual([job]);
    });

    it('the leased record carries the job_execution window', async () => {
        const requesting = randomUUID();
        const { job } = await claim({ minutes: 7, launch: 'refused', requesting });
        await store.enqueueUsage();
        const lease = await store.leaseDueUsage(10, LEASE_MS);
        expect(lease?.records).toEqual([
            {
                jobId: job,
                rootJobId: job,
                claimSeq: 1,
                requestingJobId: requesting,
                launch: 'refused',
                adoptsClaimSeq: null,
                startedAt: '2026-08-01T00:00:00.000Z',
                endedAt: '2026-08-01T00:07:00.000Z',
                durationMs: 7 * MINUTE_MS,
            },
        ]);
    });

    it('answers no lease when nothing is due', async () => {
        await store.enqueueUsage();
        expect(await store.leaseDueUsage(10, LEASE_MS)).toBeNull();
    });

    it('two replicas never lease the same row', async () => {
        for (let i = 0; i < 6; i++) await claim();
        await store.enqueueUsage();
        const other = createCommerceStore({ sql, orgId: ORG });
        const [a, b] = await Promise.all([store.leaseDueUsage(6, LEASE_MS), other.leaseDueUsage(6, LEASE_MS)]);
        const keys = [...(a?.records ?? []), ...(b?.records ?? [])].map((r) => r.jobId);
        expect(keys).toHaveLength(6);
        expect(new Set(keys).size).toBe(6);
    });

    it('a lapsed lease is re-leased and the old token settles nothing', async () => {
        const { job, seq } = await claim();
        await store.enqueueUsage();
        const first = await store.leaseDueUsage(10, LEASE_MS);
        expect(first?.records).toHaveLength(1);
        await lapse(job);

        const second = await store.leaseDueUsage(10, LEASE_MS);
        expect(second?.records).toHaveLength(1);
        expect(second?.token).not.toBe(first?.token);

        await store.settleUsage(first?.token as string, [{ jobId: job, claimSeq: seq }]);
        expect((await outbox())[0]?.reported_at).toBeNull();

        await store.settleUsage(second?.token as string, [{ jobId: job, claimSeq: seq }]);
        expect((await outbox())[0]?.reported_at).not.toBeNull();
    });

    it('a lease still standing is not leased again', async () => {
        await claim();
        await store.enqueueUsage();
        expect(await store.leaseDueUsage(10, LEASE_MS)).not.toBeNull();
        expect(await store.leaseDueUsage(10, LEASE_MS)).toBeNull();
    });

    it('settles only acknowledged keys; the rest back off', async () => {
        const a = await claim();
        const b = await claim();
        await store.enqueueUsage();
        const lease = await store.leaseDueUsage(10, LEASE_MS);
        const before = Date.now();
        await store.settleUsage(lease?.token as string, [{ jobId: a.job, claimSeq: a.seq }], 'not_acknowledged');

        const rows = await outbox();
        const acked = rows.find((r) => r.job_id === a.job);
        const failed = rows.find((r) => r.job_id === b.job);
        expect(acked?.reported_at).not.toBeNull();
        expect(acked?.failures).toBe(0);
        expect(failed?.reported_at).toBeNull();
        expect(failed?.failures).toBe(1);
        expect(failed?.error_code).toBe('not_acknowledged');
        expect(failed?.next_attempt_at.getTime()).toBeGreaterThan(before);
        // Backed off and unclaimed: not due now, so the next pass does not hammer it.
        expect(await store.leaseDueUsage(10, LEASE_MS)).toBeNull();
    });

    it('a row that failed a thousand times still settles, capped at the longest backoff', async () => {
        const a = await claim();
        const b = await claim();
        await store.enqueueUsage();
        await sql`update commerce_usage_report set failures = 1010 where job_id = ${b.job}`;
        const lease = await store.leaseDueUsage(10, LEASE_MS);
        const before = Date.now();
        await store.settleUsage(lease?.token as string, [{ jobId: a.job, claimSeq: a.seq }], 'not_acknowledged');

        const rows = await outbox();
        // The ack in the same call is not lost to an arithmetic error on the other row.
        expect(rows.find((r) => r.job_id === a.job)?.reported_at).not.toBeNull();
        const failed = rows.find((r) => r.job_id === b.job);
        expect(failed?.failures).toBe(1011);
        const waitMs = (failed?.next_attempt_at.getTime() ?? 0) - before;
        expect(waitMs).toBeGreaterThan(3_000_000);
        expect(waitMs).toBeLessThanOrEqual(3_600_000 + 5_000);
    });

    it('an acknowledged row is never leased again', async () => {
        const a = await claim();
        await store.enqueueUsage();
        const lease = await store.leaseDueUsage(10, LEASE_MS);
        await store.settleUsage(lease?.token as string, [{ jobId: a.job, claimSeq: a.seq }]);
        await store.enqueueUsage();
        expect(await store.leaseDueUsage(10, LEASE_MS)).toBeNull();
        expect(await outbox()).toHaveLength(1);
    });

    it('reads plan null before any push, and counts the unreported claims', async () => {
        const a = await claim();
        await claim();
        await store.enqueueUsage();
        expect(await store.read()).toEqual({ plan: null, unreportedClaims: 2 });
        const lease = await store.leaseDueUsage(10, LEASE_MS);
        await store.settleUsage(lease?.token as string, [{ jobId: a.job, claimSeq: a.seq }]);
        expect((await store.read()).unreportedClaims).toBe(1);
    });

    it('reads the pushed plan', async () => {
        await sql`
            insert into org_plan (org_id, plan, included_minutes, used_minutes, period_start, period_end, version)
            values (${ORG}, 'pro', 3000, 120, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 4)`;
        const { plan } = await store.read();
        expect(plan).toMatchObject({
            plan: 'pro',
            includedMinutes: 3000,
            usedMinutes: 120,
            periodStart: '2026-08-01T00:00:00.000Z',
            periodEnd: '2026-09-01T00:00:00.000Z',
            version: 4,
        });
        expect(typeof plan?.updatedAt).toBe('string');
    });

    it("every read is org-scoped: another org's claims and plan never appear", async () => {
        await claim({ org: OTHER });
        await sql`insert into org_plan (org_id, plan, version) values (${OTHER}, 'enterprise', 9)`;
        await store.enqueueUsage();
        expect(await outbox()).toHaveLength(0);
        expect(await store.leaseDueUsage(10, LEASE_MS)).toBeNull();
        expect(await store.read()).toEqual({ plan: null, unreportedClaims: 0 });
    });
});
