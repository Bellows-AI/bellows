import type { Sql } from 'postgres';

/** A live attempt the board may hand a GitHub token to: its org and the repository it is narrowed to. */
export type GithubAttempt = { ok: true; orgId: string; repo: string | null } | { ok: false };

export type GithubCredentialOfLease = (jobId: string, leaseToken: string) => Promise<GithubAttempt>;

/**
 * The runner credential endpoint's check (docs/connections.md), org-less like `createOrgOfLease`
 * (the pair names the org) and, like `createConnectionOfLease`, WITHOUT a tail grace: the attempt
 * must be unfinished, unexpired and not asked to stop, and a reclaim or retry rotates the lease
 * token, so a superseded attempt's pair resolves nothing. A reviewer row (`review_of`) never gets
 * one. The task binding is the thread ROOT's: its author must still be a member of the org and the
 * attempt must work the root's repository, which is what the token is narrowed to. The route runs
 * this before the mint and again after it, so an attempt that ended during the exchange gets nothing.
 */
export function createGithubCredentialOfLease({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown> | undefined;
}): GithubCredentialOfLease {
    return async (jobId, leaseToken) => {
        if (ready) await ready;
        const rows = await sql<{ org_id: string; repo: string | null }[]>`
            select j.org_id, j.repo
            from job j
            join job root on root.org_id = j.org_id and root.id = j.root_job_id
            where j.id = ${jobId} and j.lease_token = ${leaseToken}
              and j.status = 'running' and j.finished_at is null
              and j.lease_expires_at > now() and j.cancel_requested_at is null
              and j.review_of is null
              and j.repo is not distinct from root.repo
              and exists (
                  select 1 from org_membership m
                  where m.org_id = j.org_id and m.user_id = root.created_by
              )
        `;
        const row = rows[0];
        return row ? { ok: true, orgId: row.org_id, repo: row.repo } : { ok: false };
    };
}
