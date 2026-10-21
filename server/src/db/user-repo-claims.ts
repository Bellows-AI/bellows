import type { Sql } from 'postgres';
import type { UserRepoStore } from './user-repo-store.js';

/**
 * The token-fenced half of the user repo store (issue #830): the lease a clone is held under and
 * the stamp a purge is held under. Every write here names the token it acts for, so a holder that
 * lost its row can neither publish, move, record nor delete anything.
 */

/** How long a claim's lease lasts between renewals. The heartbeat renews well inside it. */
export const CLONE_LEASE_MS = 60_000;

/** `lock_timeout` for the fenced transactions: a lock that is not granted fails the write rather than hanging it. */
const FENCE_LOCK_TIMEOUT = '5s';
const MS_PER_SECOND = 1000;

export interface ClaimsContext {
    readonly sql: Sql;
    readonly orgId: string;
    readonly gate: () => Promise<void>;
    /** A stored failure message is capped at this many characters. */
    readonly errorLimit: number;
}

type PurgeClaims = Pick<UserRepoStore, 'deletePurged' | 'markPurgeFailed' | 'claimStalePurges' | 'holdPurge'>;
type CloneClaims = Pick<
    UserRepoStore,
    'claimPending' | 'renewLeases' | 'markReady' | 'markFailed' | 'requeueExpired' | 'heldTokens'
>;

export function createPurgeClaims({ sql, orgId, gate, errorLimit }: ClaimsContext): PurgeClaims {
    return {
        async deletePurged(userId, repo, token) {
            await gate();
            const rows = await sql`
                delete from user_repo
                where org_id = ${orgId} and user_id = ${userId}
                  and repo_owner = ${repo.owner} and repo_name = ${repo.name}
                  and deselected_at is not null and status = 'purging' and purge_token = ${token}
                returning 1
            `;
            return rows.length > 0;
        },

        async markPurgeFailed(userId, repo, token, error) {
            await gate();
            const rows = await sql`
                update user_repo set status = 'failed', error = ${error.slice(0, errorLimit)}
                where org_id = ${orgId} and user_id = ${userId}
                  and repo_owner = ${repo.owner} and repo_name = ${repo.name}
                  and status = 'purging' and purge_token = ${token}
                returning 1
            `;
            return rows.length > 0;
        },

        async claimStalePurges(staleMs) {
            await gate();
            const stale = sql`make_interval(secs => ${staleMs / MS_PER_SECOND})`;
            const rows = await sql<{ user_id: string; repo_owner: string; repo_name: string; purge_token: string }[]>`
                update user_repo
                set purge_token = gen_random_uuid(), purge_started_at = now()
                where org_id = ${orgId} and status = 'purging' and purge_started_at < now() - ${stale}
                returning user_id, repo_owner, repo_name, purge_token
            `;
            return rows.map((row) => ({
                userId: row.user_id,
                owner: row.repo_owner,
                name: row.repo_name,
                token: row.purge_token,
            }));
        },

        async holdPurge(userId, repo, token, move) {
            await gate();
            const result = await sql.begin(async (tx) => {
                await tx`select set_config('lock_timeout', ${FENCE_LOCK_TIMEOUT}, true)`;
                const held = await tx`
                    select 1 from user_repo
                    where org_id = ${orgId} and user_id = ${userId}
                      and repo_owner = ${repo.owner} and repo_name = ${repo.name}
                      and status = 'purging' and purge_token = ${token}
                    for update
                `;
                return held.length ? move() : null;
            });
            return result as Awaited<ReturnType<typeof move>> | null;
        },
    };
}

export function createCloneClaims({ sql, orgId, gate, errorLimit }: ClaimsContext): CloneClaims {
    return {
        async claimPending(limit, leaseMs = CLONE_LEASE_MS) {
            await gate();
            if (limit <= 0) return [];
            const rows = await sql<{ user_id: string; repo_owner: string; repo_name: string; claim_token: string }[]>`
                with claimed as (
                    select org_id, user_id, repo_owner, repo_name
                    from user_repo
                    where org_id = ${orgId} and status = 'queued' and deselected_at is null
                    order by selected_at asc
                    limit ${limit}
                    for update skip locked
                )
                update user_repo r
                set status = 'cloning', started_at = now(), attempts = r.attempts + 1, error = null,
                    claim_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => ${leaseMs / MS_PER_SECOND})
                from claimed c
                where r.org_id = c.org_id and r.user_id = c.user_id
                  and r.repo_owner = c.repo_owner and r.repo_name = c.repo_name
                returning r.user_id, r.repo_owner, r.repo_name, r.claim_token
            `;
            return rows.map((row) => ({
                userId: row.user_id,
                owner: row.repo_owner,
                name: row.repo_name,
                claimToken: row.claim_token,
            }));
        },

        async renewLeases(tokens, leaseMs = CLONE_LEASE_MS) {
            await gate();
            if (!tokens.length) return [];
            const rows = await sql<{ claim_token: string }[]>`
                update user_repo set lease_expires_at = now() + make_interval(secs => ${leaseMs / MS_PER_SECOND})
                where org_id = ${orgId} and status = 'cloning' and claim_token = any(${tokens as string[]}::uuid[])
                returning claim_token
            `;
            return rows.map((row) => row.claim_token);
        },

        async markReady(job, publish) {
            await gate();
            return sql.begin(async (tx) => {
                await tx`select set_config('lock_timeout', ${FENCE_LOCK_TIMEOUT}, true)`;
                // Ownership is re-read under the row lock, immediately before the rename: the claim
                // is never trusted from when it was taken.
                const held = await tx`
                    select 1 from user_repo
                    where org_id = ${orgId} and user_id = ${job.userId}
                      and repo_owner = ${job.owner} and repo_name = ${job.name}
                      and status = 'cloning' and claim_token = ${job.claimToken}
                    for update
                `;
                if (!held.length) return false;
                publish?.();
                await tx`
                    update user_repo
                    set status = 'ready', ready_at = now(), error = null, claim_token = null, lease_expires_at = null
                    where org_id = ${orgId} and user_id = ${job.userId}
                      and repo_owner = ${job.owner} and repo_name = ${job.name}
                `;
                return true;
            });
        },

        async markFailed(job, error) {
            await gate();
            const rows = await sql`
                update user_repo
                set status = 'failed', error = ${error.slice(0, errorLimit)}, claim_token = null, lease_expires_at = null
                where org_id = ${orgId} and user_id = ${job.userId}
                  and repo_owner = ${job.owner} and repo_name = ${job.name}
                  and status = 'cloning' and claim_token = ${job.claimToken}
                returning 1
            `;
            return rows.length > 0;
        },

        async requeueExpired() {
            await gate();
            const rows = await sql<{ user_id: string; repo_name: string; claim_token: string }[]>`
                with expired as (
                    select user_id, repo_owner, repo_name, claim_token
                    from user_repo
                    where org_id = ${orgId} and status = 'cloning' and lease_expires_at < now()
                    for update skip locked
                )
                update user_repo r
                set status = 'queued', error = null, claim_token = null, lease_expires_at = null
                from expired e
                where r.org_id = ${orgId} and r.user_id = e.user_id
                  and r.repo_owner = e.repo_owner and r.repo_name = e.repo_name
                returning r.user_id, r.repo_name, e.claim_token
            `;
            return rows.map((row) => ({ userId: row.user_id, name: row.repo_name, staleToken: row.claim_token }));
        },

        async heldTokens() {
            await gate();
            const rows = await sql<{ claim_token: string | null; purge_token: string | null }[]>`
                select claim_token, case when status = 'purging' then purge_token end as purge_token
                from user_repo
                where org_id = ${orgId} and (claim_token is not null or status = 'purging')
            `;
            return rows.flatMap((row) => [row.claim_token, row.purge_token]).filter((t): t is string => t !== null);
        },
    };
}
