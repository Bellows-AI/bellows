import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';

/**
 * One org's commerce state (094; docs/commerce.md): the outbox of closed claims owed to the commerce
 * service, and the member read of the plan it pushed. The minutes are read from `job_execution` when a row
 * is leased, never stored again; the outbox records only delivery. A leased row carries a token and a
 * deadline, and a settle applies only while its token still stands, so a replica whose lease lapsed
 * changes nothing.
 */

const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 3_600_000;
const MS_PER_SECOND = 1000;
/** Doubling past this exponent is already beyond the cap; clamping before `power` keeps the arithmetic finite. */
const MAX_BACKOFF_EXPONENT = 20;
/** The counter is an integer column; it stops counting long before it could wrap. */
const MAX_FAILURES = 1_000_000;

export interface UsageKey {
    jobId: string;
    claimSeq: number;
}

/** What the commerce service is told about one closed claim: raw facts, no billing decision. */
export interface UsageRecord extends UsageKey {
    rootJobId: string;
    requestingJobId: string | null;
    launch: string;
    adoptsClaimSeq: number | null;
    startedAt: string;
    endedAt: string;
    durationMs: number;
}

export interface UsageLease {
    token: string;
    records: UsageRecord[];
}

export interface PlanView {
    plan: string;
    includedMinutes: number | null;
    usedMinutes: number | null;
    periodStart: string | null;
    periodEnd: string | null;
    version: number;
    updatedAt: string;
}

export interface CommerceStore {
    /** Queues every closed claim of the org not yet queued; idempotent. */
    enqueueUsage(): Promise<void>;
    /** Leases up to `limit` due rows, with their records read in the same transaction; null when none are due. */
    leaseDueUsage(limit: number, leaseMs: number): Promise<UsageLease | null>;
    /**
     * Marks the acknowledged keys reported and backs off the rest of the lease, only where `token` still
     * holds the row.
     */
    settleUsage(token: string, acked: readonly UsageKey[], errorCode?: string): Promise<void>;
    read(): Promise<{ plan: PlanView | null; unreportedClaims: number }>;
}

export interface CommerceStoreDeps {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
    now?: (() => Date) | undefined;
}

interface RecordRow {
    job_id: string;
    root_job_id: string;
    claim_seq: string;
    requesting_job_id: string | null;
    launch: string;
    adopts_claim_seq: string | null;
    started_at: Date;
    ended_at: Date;
    duration_ms: string;
}

interface PlanRow {
    plan: string;
    included_minutes: string | null;
    used_minutes: string | null;
    period_start: Date | null;
    period_end: Date | null;
    version: string;
    updated_at: Date;
}

const numberOrNull = (value: string | null): number | null => (value === null ? null : Number(value));
const isoOrNull = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function createCommerceStore({ sql, orgId, ready, now = () => new Date() }: CommerceStoreDeps): CommerceStore {
    return {
        async enqueueUsage() {
            await ready;
            await sql`
                insert into commerce_usage_report (org_id, job_id, claim_seq)
                select org_id, job_id, claim_seq from job_execution
                where org_id = ${orgId} and origin = 'claim' and created_at is not null and ended_at is not null
                on conflict do nothing
            `;
        },

        async leaseDueUsage(limit, leaseMs) {
            await ready;
            const at = now();
            const token = randomUUID();
            const until = new Date(at.getTime() + leaseMs);
            return sql.begin(async (tx) => {
                const leased = await tx`
                    with due as (
                        select job_id, claim_seq from commerce_usage_report
                        where org_id = ${orgId} and reported_at is null and next_attempt_at <= ${at}
                          and (claimed_until is null or claimed_until <= ${at})
                        order by next_attempt_at, job_id, claim_seq
                        limit ${limit}
                        for update skip locked
                    )
                    update commerce_usage_report r set claim_token = ${token}::uuid, claimed_until = ${until}
                    from due
                    where r.org_id = ${orgId} and r.job_id = due.job_id and r.claim_seq = due.claim_seq
                    returning 1
                `;
                if (leased.length === 0) return null;
                const rows = await tx<RecordRow[]>`
                    select e.job_id, e.root_job_id, e.claim_seq, e.requesting_job_id, e.launch, e.adopts_claim_seq,
                           e.created_at as started_at, e.ended_at,
                           (extract(epoch from (e.ended_at - e.created_at)) * ${MS_PER_SECOND})::bigint as duration_ms
                    from commerce_usage_report r
                    join job_execution e on e.org_id = r.org_id and e.job_id = r.job_id and e.claim_seq = r.claim_seq
                    where r.org_id = ${orgId} and r.claim_token = ${token}::uuid
                    order by r.next_attempt_at, e.job_id, e.claim_seq
                `;
                return {
                    token,
                    records: rows.map((row) => ({
                        jobId: row.job_id,
                        rootJobId: row.root_job_id,
                        claimSeq: Number(row.claim_seq),
                        requestingJobId: row.requesting_job_id,
                        launch: row.launch,
                        adoptsClaimSeq: numberOrNull(row.adopts_claim_seq),
                        startedAt: row.started_at.toISOString(),
                        endedAt: row.ended_at.toISOString(),
                        durationMs: Number(row.duration_ms),
                    })),
                };
            });
        },

        async settleUsage(token, acked, errorCode = 'not_acknowledged') {
            await ready;
            const at = now();
            await sql.begin(async (tx) => {
                if (acked.length > 0) {
                    await tx`
                        update commerce_usage_report r
                        set reported_at = ${at}, claim_token = null, claimed_until = null, error_code = null
                        from unnest(${acked.map((k) => k.jobId)}::uuid[], ${acked.map((k) => k.claimSeq)}::bigint[])
                            as a(job_id, claim_seq)
                        where r.org_id = ${orgId} and r.claim_token = ${token}::uuid
                          and r.job_id = a.job_id and r.claim_seq = a.claim_seq
                    `;
                }
                await tx`
                    update commerce_usage_report
                    set failures = least(failures + 1, ${MAX_FAILURES}),
                        next_attempt_at = ${at}::timestamptz
                            + least(${RETRY_CAP_MS}::double precision, ${RETRY_BASE_MS}::double precision * power(2, least(failures, ${MAX_BACKOFF_EXPONENT})))
                              * interval '1 millisecond',
                        error_code = ${errorCode}, claim_token = null, claimed_until = null
                    where org_id = ${orgId} and claim_token = ${token}::uuid and reported_at is null
                `;
            });
        },

        async read() {
            await ready;
            const [plan] = await sql<PlanRow[]>`
                select plan, included_minutes, used_minutes, period_start, period_end, version, updated_at
                from org_plan where org_id = ${orgId}
            `;
            const [counted] = await sql<{ unreported: string }[]>`
                select count(*) as unreported from commerce_usage_report
                where org_id = ${orgId} and reported_at is null
            `;
            return {
                plan: plan
                    ? {
                          plan: plan.plan,
                          includedMinutes: numberOrNull(plan.included_minutes),
                          usedMinutes: numberOrNull(plan.used_minutes),
                          periodStart: isoOrNull(plan.period_start),
                          periodEnd: isoOrNull(plan.period_end),
                          version: Number(plan.version),
                          updatedAt: plan.updated_at.toISOString(),
                      }
                    : null,
                unreportedClaims: Number(counted?.unreported ?? 0),
            };
        },
    };
}
