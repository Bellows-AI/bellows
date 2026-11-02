import type { Sql } from 'postgres';

/**
 * A live attempt a runner credential may be handed to: the org its pair names, the thread root whose bindings
 * it spends, the repository it works against the root's, and the stable execution principal (094) it acts as.
 */
export interface LiveAttempt {
    ok: true;
    orgId: string;
    jobId: string;
    rootJobId: string;
    /** The attempt's repository; null for a command-only task. */
    repo: string | null;
    /** The thread root's repository: what a GitHub token is narrowed to must be the attempt's own. */
    rootRepo: string | null;
    executionUserId: string;
    claimSeq: number;
}

/** A refusal: `pending` is a task that still runs under another pair (retry with the current one), else terminal. */
export type AttemptCheck = LiveAttempt | { ok: false; pending: boolean };

export type AttemptOfLease = (jobId: string, leaseToken: string) => Promise<AttemptCheck>;

interface Row {
    org_id: string;
    root_job_id: string;
    repo: string | null;
    root_repo: string | null;
    execution_user_id: string | null;
    claim_seq: string | number;
    current: unknown;
    prior: unknown;
    live: unknown;
    standing: unknown;
}

/** A flag the query must have answered true or false: anything else is an unconfirmed read, never a verdict. */
function flag(value: unknown): boolean {
    if (typeof value !== 'boolean') throw new Error('attempt check answered a non-boolean flag');
    return value;
}

/**
 * The one check behind every runner credential route (docs/connections.md). It is org-less like
 * `createOrgOfLease` (the pair names the org) and WITHOUT a tail grace: the attempt must be unfinished,
 * unexpired and not asked to stop. A reclaim rotates the lease token and keeps the one before it
 * (`prior_lease_token`): that pair, or the current one once its lease lapsed, on a task that still stands,
 * is `pending` (a takeover window, retry), and every other refusal is terminal, so a pair the task never held
 * learns nothing about it. A reviewer row (`review_of`) never gets a credential. The binding is the thread
 * ROOT's: its stable execution user must still be a member of the org. A refusal is a successful query; a
 * throw, or a row whose flags are not booleans, is the caller's to answer as unavailable, never as a refusal.
 */
export function createAttemptOfLease({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown> | undefined;
}): AttemptOfLease {
    return async (jobId, leaseToken) => {
        if (ready) await ready;
        const rows = await sql<Row[]>`
            select j.org_id, j.root_job_id, j.repo, root.repo as root_repo, root.execution_user_id, j.claim_seq,
                   coalesce(j.lease_token = ${leaseToken}, false) as current,
                   coalesce(j.prior_lease_token = ${leaseToken}, false) as prior,
                   coalesce(j.lease_expires_at > now(), false) as live,
                   (coalesce(j.status = 'running', false) and j.finished_at is null
                    and j.cancel_requested_at is null and j.review_of is null
                    and root.execution_user_id is not null
                    and exists (
                        select 1 from org_membership m
                        where m.org_id = j.org_id and m.user_id = root.execution_user_id
                    )) as standing
            from job j
            join job root on root.org_id = j.org_id and root.id = j.root_job_id
            where j.id = ${jobId}
        `;
        const row = rows[0];
        if (!row) return { ok: false, pending: false };
        const [current, prior, live, standing] = [
            flag(row.current),
            flag(row.prior),
            flag(row.live),
            flag(row.standing),
        ];
        if (current && live && standing && row.execution_user_id !== null) {
            return {
                ok: true,
                orgId: row.org_id,
                jobId,
                rootJobId: row.root_job_id,
                repo: row.repo,
                rootRepo: row.root_repo,
                executionUserId: row.execution_user_id,
                claimSeq: Number(row.claim_seq),
            };
        }
        return { ok: false, pending: standing && ((current && !live) || prior) };
    };
}

export type PairCheck = { ok: true; orgId: string } | { ok: false; pending: boolean };

export type PairMatches = (jobId: string, leaseToken: string) => Promise<PairCheck>;

interface PairRow {
    org_id: string;
    current: unknown;
    prior: unknown;
    standing: unknown;
}

/**
 * Whether the pair names an attempt row, and which org, with NO liveness: the revoke route's and the operation
 * move's check. A Stop (`cancel_requested_at`) or a settle must not stop a runner revoking the token it holds; a
 * reclaim rotates the lease token, so a superseded pair matches nothing, but the pair one claim back on a task
 * that still stands is `pending` (the move retries with the current pair). A reviewer row never matches. A
 * throw is the caller's to answer as unavailable.
 */
export function createPairMatches({ sql, ready }: { sql: Sql; ready?: Promise<unknown> | undefined }): PairMatches {
    return async (jobId, leaseToken) => {
        if (ready) await ready;
        const rows = await sql<PairRow[]>`
            select j.org_id,
                   coalesce(j.lease_token = ${leaseToken}, false) as current,
                   coalesce(j.prior_lease_token = ${leaseToken}, false) as prior,
                   (coalesce(j.status = 'running', false) and j.finished_at is null
                    and j.cancel_requested_at is null) as standing
            from job j
            where j.id = ${jobId} and j.review_of is null
        `;
        const row = rows[0];
        if (!row) return { ok: false, pending: false };
        if (flag(row.current)) return { ok: true, orgId: row.org_id };
        return { ok: false, pending: flag(row.standing) && flag(row.prior) };
    };
}
