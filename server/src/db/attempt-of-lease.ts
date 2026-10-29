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

export type AttemptCheck = LiveAttempt | { ok: false };

export type AttemptOfLease = (jobId: string, leaseToken: string) => Promise<AttemptCheck>;

interface Row {
    org_id: string;
    root_job_id: string;
    repo: string | null;
    root_repo: string | null;
    execution_user_id: string;
    claim_seq: string | number;
}

/**
 * The one check behind every runner credential route (docs/connections.md). It is org-less like
 * `createOrgOfLease` (the pair names the org) and WITHOUT a tail grace: the attempt must be unfinished,
 * unexpired and not asked to stop, and a reclaim or retry rotates the lease token, so a superseded
 * attempt's pair resolves nothing. A reviewer row (`review_of`) never gets a credential. The binding is the
 * thread ROOT's: its stable execution user must still be a member of the org. A refusal is a successful query
 * with no row; a throw is the caller's to answer as unavailable, never as a refusal.
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
            select j.org_id, j.root_job_id, j.repo, root.repo as root_repo, root.execution_user_id, j.claim_seq
            from job j
            join job root on root.org_id = j.org_id and root.id = j.root_job_id
            where j.id = ${jobId} and j.lease_token = ${leaseToken}
              and j.status = 'running' and j.finished_at is null
              and j.lease_expires_at > now() and j.cancel_requested_at is null
              and j.review_of is null
              and root.execution_user_id is not null
              and exists (
                  select 1 from org_membership m
                  where m.org_id = j.org_id and m.user_id = root.execution_user_id
              )
        `;
        const row = rows[0];
        if (!row) return { ok: false };
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
    };
}
