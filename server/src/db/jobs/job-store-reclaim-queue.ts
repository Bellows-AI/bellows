/**
 * The worktree-reclaim queue's board half: queue a thread's reclaim when its last member is done, and the
 * verdict-time reclaim a completing worker holds. The worker half (claim, ack, renew) is `job-store-reclaims.ts`.
 */

import { waitAdvisoryXactLock } from '../pool.js';
import type { TransactionSql } from 'postgres';
import { doneFragment, terminalFragment } from './job-store-sql-fragments.js';
import { workspacePathFor } from './job-store-rows.js';

/**
 * `markDone`'s second half, shared by every closure that frees a thread's tree (done, remove's
 * refusal-free sibling, the merge closure's settle points): if this settle just made
 * the whole thread terminal, queue its worktree reclaim. The thread is one indexed read off the
 * root column (022), and the ROOT row carries the labels the reclaim is addressed by — the same
 * fields removeThread queues. Terminal only: a member still queued or running keeps the tree (its
 * own settle will reclaim); one member done is what makes the settle a THREAD's close and not one
 * turn's.
 */
export async function queueReclaimIfThreadDone(tx: TransactionSql, orgId: string, rootJobId: string): Promise<void> {
    const [thread] = await tx<{ total: number; terminal: number }[]>`
        select count(*)::int as total,
               count(*) filter (where ${terminalFragment(tx)})::int as terminal
        from job
        where org_id = ${orgId} and root_job_id = ${rootJobId}
    `;
    if (!thread || thread.total === 0 || thread.total !== thread.terminal) return;

    const { repo, workspacePath } = await reclaimTarget(tx, orgId, rootJobId);
    // Idempotent against a row already queued (an earlier done, or a concurrent one): one tree,
    // one reclaim. The claim-ack cycle removes the row; until then a duplicate insert would only
    // re-offer an already-removed tree, so the guard is tidiness, not correctness.
    await tx`
        insert into task_reclaim (org_id, root_job_id, repo, workspace_path)
        select ${orgId}, ${rootJobId}, ${repo}, ${workspacePath}
        where not exists (
            select 1 from task_reclaim
            where org_id = ${orgId} and root_job_id = ${rootJobId}
        )
    `;
}

/** The labels a thread's reclaim row is addressed by, read off its ROOT row. */
async function reclaimTarget(
    tx: TransactionSql,
    orgId: string,
    rootJobId: string
): Promise<{ repo: string | null; workspacePath: string | null }> {
    const [root] = await tx<{ repo: string | null; created_by: string | null }[]>`
        select repo, created_by from job
        where org_id = ${orgId} and id = ${rootJobId}
    `;
    return {
        repo: root?.repo ?? null,
        workspacePath: workspacePathFor(orgId, root?.created_by ?? null),
    };
}

/**
 * How long the completing worker holds the verdict-time reclaim before the queue offers it again.
 * The verdict carries no lease length of its own; a replayed verdict re-checks the
 * row (`liveVerdictReclaim`), so a retry outliving this lease never orders a withdrawn removal.
 */
export const VERDICT_RECLAIM_LEASE_SECONDS = 300;

/**
 * A threadDone verdict's worktree reclaim: a `task_reclaim` row owned by the
 * completing attempt — its lease token is the row's `claim_token` (075), already unique per claim
 * and the token the driver holds the checkout under — in the verdict's transaction, so the order
 * survives a driver that dies before the removal and the `worktree_reclaimed_at` marker follows
 * the ack, never the order. A row
 * already queued for the root (the merge closure's inline settle, an earlier done) is taken over
 * rather than duplicated, and any other unclaimed copy withdrawn: one tree, one work order. A row
 * another worker holds a LIVE claim on is mid-removal right now — its ack finishes it, and this
 * answers null. `skip locked`: a row a concurrent queue claim is taking reads as live. Under the
 * per-root lock reopen takes, re-reading the done stamp: a reopen that committed first wins, and
 * one that waits sees the claimed row and answers `reclaiming`.
 */
export async function issueVerdictReclaim(
    tx: TransactionSql,
    { orgId }: { orgId: string },
    rootJobId: string,
    { worker, leaseToken }: { worker: string | null; leaseToken: string }
): Promise<string | null> {
    await waitAdvisoryXactLock(tx, rootJobId);
    const done = await tx`
        select 1 from job where org_id = ${orgId} and root_job_id = ${rootJobId} and ${doneFragment(tx)} limit 1
    `;
    if (done.length === 0) return null;
    const lease = tx`now() + make_interval(secs => ${VERDICT_RECLAIM_LEASE_SECONDS}::int)`;
    const [taken] = await tx<{ id: string }[]>`
        update task_reclaim set claimed_by = ${worker}, claim_token = ${leaseToken}, lease_expires_at = ${lease}
        where id = (
            select id from task_reclaim
            where org_id = ${orgId} and root_job_id = ${rootJobId}
              and (claim_token is null or lease_expires_at <= now())
            order by created_at, id
            limit 1
            for update skip locked
        )
        returning id
    `;
    if (taken) {
        await tx`
            delete from task_reclaim
            where org_id = ${orgId} and root_job_id = ${rootJobId} and id <> ${taken.id}
              and claim_token is null
        `;
        return taken.id;
    }
    const live = await tx`select 1 from task_reclaim where org_id = ${orgId} and root_job_id = ${rootJobId}`;
    if (live.length > 0) return null;
    const { repo, workspacePath } = await reclaimTarget(tx, orgId, rootJobId);
    const [inserted] = await tx<{ id: string }[]>`
        insert into task_reclaim (org_id, root_job_id, repo, workspace_path, claimed_by, claim_token, lease_expires_at)
        values (${orgId}, ${rootJobId}, ${repo}, ${workspacePath}, ${worker}, ${leaseToken}, ${lease})
        returning id
    `;
    return inserted!.id;
}

/**
 * Whether a verdict's reclaim order is still the completing attempt's to carry out: the row is
 * queued, still owned by that attempt's lease token, and its lease is live. An acked, lapsed or
 * re-acquired row answers false.
 */
export async function liveVerdictReclaim(
    tx: TransactionSql,
    orgId: string,
    leaseToken: string,
    reclaimId: string
): Promise<boolean> {
    const rows = await tx`
        select 1 from task_reclaim
        where org_id = ${orgId} and id = ${reclaimId}
          and claim_token = ${leaseToken} and lease_expires_at > now()
    `;
    return rows.length > 0;
}
