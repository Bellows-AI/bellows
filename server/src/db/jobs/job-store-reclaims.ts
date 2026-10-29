// The worktree-reclaim queue's worker half (issue #41): claim, ack and renew, each under the
// acquisition's own token (issue #821).
import { lockThreadInTx, lockThreadRootInTx } from '../connection-bindings.js';
import type { JobStore, JobStoreContext, ReclaimClaim, ReclaimRenewal } from './job-store-types.js';

/** The worktree-reclaim queue. */
export interface JobReclaimStore {
    /** The driver's poll of the worktree-reclaim queue. The oldest claimable row, or null —
     * claimable by the expiry a previous claim GRANTED it, never by the polling worker's own
     * leaseSeconds. */
    claimReclaim(worker: string, leaseSeconds: number): Promise<ReclaimClaim | null>;

    /**
     * Removes the reclaim row once the driver has actually taken the tree, under the acquisition's
     * own token only, and records the ack's receipt: the identical ack replayed answers `ok`, any
     * other token `lost`, a row never queued `missing`.
     */
    ackReclaim(id: string, token: string): Promise<'ok' | 'lost' | 'missing'>;

    /**
     * Extends the row's lease to `leaseSeconds` from now while `token` still owns it — even past
     * its expiry, since a row still carrying the token was never re-acquired.
     */
    renewReclaim(id: string, token: string, leaseSeconds: number): Promise<ReclaimRenewal>;
}

export async function claimReclaimRow(
    ctx: JobStoreContext,
    worker: string,
    leaseSeconds: number
): ReturnType<JobStore['claimReclaim']> {
    const { sql, orgId } = ctx;
    // The job claim's select-lock-claim shape, one statement: the candidate list reads the
    // lease predicate under row locks, and the update re-asserts nothing because there is
    // nothing else to assert — a row that passed the predicate is the whole claim. `for
    // update skip locked` keeps two drivers from claiming the same tree: the loser's
    // candidate list finds nothing and answers null, exactly as an idle job poll does.
    // The expiry read here is the one GRANTED to the current holder — stamped on the row
    // by the claim that took it — and never re-measured from the polling worker's own
    // leaseSeconds, or a worker granted 300s would lose its row to the first 10s poll ten
    // seconds in. The CTE exposes only claim_id, so the RETURNING columns read the target
    // table unambiguously. Every acquisition mints its own claim_token (075): the row id names
    // the work order, the token which acquisition holds it.
    const rows = await sql<
        {
            id: string;
            claim_token: string;
            root_job_id: string;
            repo: string | null;
            workspace_path: string | null;
            lease_expires_at: Date;
        }[]
    >`
        with candidate as (
            select id as claim_id from task_reclaim
            where org_id = ${orgId}
              and (claim_token is null or lease_expires_at <= now())
            order by created_at, id
            limit 1
            for update skip locked
        )
        update task_reclaim
        set claimed_by = ${worker},
            claim_token = gen_random_uuid(),
            lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::int)
        from candidate
        where task_reclaim.id = candidate.claim_id
        returning id, claim_token, root_job_id, repo, workspace_path, lease_expires_at
    `;
    const row = rows[0];
    if (!row) return null;
    return {
        id: row.id,
        token: row.claim_token,
        rootJobId: row.root_job_id,
        repo: row.repo,
        workspacePath: row.workspace_path,
        leaseExpiresAt: row.lease_expires_at.toISOString(),
    };
}

export async function ackReclaimRow(
    ctx: JobStoreContext,
    id: string,
    token: string
): ReturnType<JobStore['ackReclaim']> {
    const { sql, orgId } = ctx;
    // The acquisition's own token is the whole proof (075): a driver whose lease ran out and was
    // re-offered holds an older token, and its ack is refused rather than deleting a row another
    // acquisition is mid-reclaim on. Under the per-root lock reopen and remove take, so an ack and
    // a reopen serialize: whichever commits second sees the other. The delete stamps the durable
    // `worktree_reclaimed_at` marker on the thread root (045) — 0 rows for a thread remove deleted
    // whole; coalesce keeps the first writer's instant — and records the ack's receipt, so the
    // identical ack replayed after its response was lost answers ok, never missing.
    return sql.begin(async (tx) => {
        const [queued] = await tx<{ root_job_id: string }[]>`
            select root_job_id from task_reclaim where org_id = ${orgId} and id = ${id}
        `;
        if (queued) {
            // Root row then thread lock; a root remove already deleted leaves the advisory lock alone (the
            // update below is then a 0-row no-op).
            if (!(await lockThreadRootInTx(tx, orgId, queued.root_job_id))) {
                await lockThreadInTx(tx, queued.root_job_id);
            }
            const [deleted] = await tx<{ root_job_id: string }[]>`
                delete from task_reclaim
                where org_id = ${orgId} and id = ${id} and claim_token = ${token}
                returning root_job_id
            `;
            if (deleted) {
                await tx`
                    update job set worktree_reclaimed_at = coalesce(worktree_reclaimed_at, now())
                    where org_id = ${orgId} and id = ${deleted.root_job_id}
                `;
                await tx`
                    insert into task_reclaim_ack (org_id, reclaim_id, claim_token)
                    values (${orgId}, ${id}, ${token})
                `;
                return 'ok';
            }
        }
        const present = await tx`select 1 from task_reclaim where org_id = ${orgId} and id = ${id}`;
        if (present.length > 0) return 'lost';
        // Compared as uuids in SQL, never as strings: a token is the same token in any case.
        const [receipt] = await tx<{ same: boolean }[]>`
            select claim_token = ${token}::uuid as same from task_reclaim_ack
            where org_id = ${orgId} and reclaim_id = ${id}
        `;
        if (!receipt) return 'missing';
        return receipt.same ? 'ok' : 'lost';
    });
}

export async function renewReclaimRow(
    ctx: JobStoreContext,
    id: string,
    token: string,
    leaseSeconds: number
): ReturnType<JobStore['renewReclaim']> {
    const { sql, orgId } = ctx;
    // Even past the expiry: a row still carrying this token was never re-acquired, and reopen never
    // withdraws an acquired row, so the deletion this renew covers is still the row's only one.
    const [renewed] = await sql<{ lease_expires_at: Date }[]>`
        update task_reclaim
        set lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::int)
        where org_id = ${orgId} and id = ${id} and claim_token = ${token}
        returning lease_expires_at
    `;
    if (renewed) return { result: 'ok', leaseExpiresAt: renewed.lease_expires_at.toISOString() };
    const present = await sql`select 1 from task_reclaim where org_id = ${orgId} and id = ${id}`;
    return present.length > 0 ? { result: 'lost' } : { result: 'missing' };
}
