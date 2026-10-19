/**
 * Staged conclusions (issue #821; `076_job_conclusions.sql`): the attempt's final envelope, staged
 * under its lease before the driver completes and tears the attempt down, and the board's commit
 * of one whose lease expired before the driver's complete landed. The commit is the verdict's own
 * transaction (`completeInTx`), so the driver's identical complete afterwards replays its receipt.
 */

import type { TransactionSql } from 'postgres';
import type { EvidencePolicy } from './evidence-policy.js';
import { fingerprintOf } from './job-store-receipts.js';
import { exists } from './job-store-rows.js';
import { stagedUnderLease } from './job-store-staged.js';
import type { JobStore, JobStoreContext } from './job-store-types.js';
import { type CompleteOutcome, type CompleteResult, completeInTx } from './job-store-worker.js';

/** The interruption a board commit records: the lease ran out between the stage and the verdict. */
export const STAGED_COMMIT_REASON = 'the lease expired after its verdict was staged: the board committed it';

export async function stageConclusion(
    ctx: JobStoreContext,
    attempt: { id: string; leaseToken: string },
    result: CompleteResult,
    leaseSeconds: number
): ReturnType<JobStore['stageConclusion']> {
    const { sql, orgId } = ctx;
    const { id, leaseToken } = attempt;
    const fingerprint = fingerprintOf(result);
    return sql.begin(async (tx) => {
        // The row lock orders the stage against the attempt's other settles and the board's commit.
        const [row] = await tx<{ claim_seq: string; policy: unknown; reviewers: unknown }[]>`
            select claim_seq, policy, reviewers from job
            where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken}
            for update
        `;
        if (!row) return { result: (await exists(tx, orgId, id)) ? 'lost' : 'missing' };
        await tx`
            insert into job_conclusion (org_id, job_id, lease_token, claim_seq, fingerprint, result, policy, reviewers)
            values (${orgId}, ${id}, ${leaseToken}, ${row.claim_seq}, ${fingerprint}, ${tx.json(result as never)},
                    ${row.policy === null ? null : tx.json(row.policy as never)},
                    ${row.reviewers === null ? null : tx.json(row.reviewers as never)})
            on conflict do nothing
        `;
        const [stored] = await tx<{ fingerprint: string }[]>`
            select fingerprint from job_conclusion
            where org_id = ${orgId} and job_id = ${id} and lease_token = ${leaseToken}
        `;
        if (stored?.fingerprint !== fingerprint) return { result: 'conflict' };
        // The lease the commit waits out runs from here — the clock, not the transaction's start, so a
        // stage that waited on the row past its lease never commits an already-expired one.
        await tx`
            update job set lease_expires_at = clock_timestamp() + make_interval(secs => ${leaseSeconds}::int)
            where org_id = ${orgId} and id = ${id}
        `;
        return { result: 'ok' };
    });
}

/** The Stop a commit stamps with the verdict, when a Stop is what commits it. */
interface CommitStop {
    stoppedBy: string | null;
}

/**
 * A Stop's commit of its own row, on the Stop's transaction and under the row's lock it holds: an
 * expired attempt that staged its conclusion is committed, the Stop stamped with it. Serialized with
 * the expiry itself, so no lease can run out between this read and the Stop's own statement.
 */
export async function commitStagedForStop(
    ctx: JobStoreContext,
    tx: TransactionSql,
    stop: { id: string; stoppedBy: string | null }
): Promise<void> {
    const [row] = await tx<{ lease_token: string }[]>`
        select lease_token from job
        where org_id = ${ctx.orgId} and id = ${stop.id} and status = 'running' and lease_expires_at <= now()
          and ${stagedUnderLease(tx, 'job')}
    `;
    if (!row) return;
    // A conclusion the board cannot commit rolls back alone and stays guarded: the Stop then finds
    // nothing it may settle, and answers the row's status as the conflict.
    await tx
        .savepoint((sp) => commitOne(ctx, sp, { id: stop.id, leaseToken: row.lease_token, stop }))
        .catch((e: Error) => commitFailed(stop.id, e));
}

/**
 * A staged conclusion whose commit threw: logged on the board and skipped, never surfaced to a
 * caller. It stays guarded (`stagedUnderLease`) — never retired, stopped or taken over — so the
 * envelope survives for an operator, and the rest of the org's claims proceed.
 */
function commitFailed(id: string, e: Error): void {
    console.error(`[jobs] the staged conclusion of job ${id} could not be committed: ${e.message}`);
}

/**
 * Commits every staged conclusion whose lease expired before its driver's complete landed, each in
 * its own transaction: an interruption naming the claim records the infrastructure loss, and the
 * committed status is the run's own, judged by the policy it staged under. A row the driver
 * concluded or renewed first is skipped, and one that cannot commit is logged and skipped.
 */
export async function commitStagedConclusions(ctx: JobStoreContext): Promise<void> {
    const { sql, orgId } = ctx;
    const due = await sql<{ id: string; lease_token: string }[]>`
        select j.id, j.lease_token from job j
        join job_conclusion c on c.org_id = j.org_id and c.job_id = j.id and c.lease_token = j.lease_token
        where j.org_id = ${orgId} and j.status = 'running' and j.lease_expires_at <= now()
        order by j.id
    `;
    for (const row of due) {
        // Its own transaction, so one that cannot commit rolls back alone and blocks no other row.
        await sql
            .begin((tx) => commitOne(ctx, tx, { id: row.id, leaseToken: row.lease_token }))
            .catch((e: Error) => commitFailed(row.id, e));
    }
}

async function commitOne(
    ctx: JobStoreContext,
    tx: TransactionSql,
    attempt: { id: string; leaseToken: string; stop?: CommitStop }
): Promise<CompleteOutcome | null> {
    const { orgId } = ctx;
    const { id, leaseToken, stop } = attempt;
    const entry = tx.json({ reason: STAGED_COMMIT_REASON, at: new Date().toISOString() });
    const stopping = stop !== undefined;
    const taken = await tx<{ id: string }[]>`
        update job set
            interruptions = interruptions || jsonb_build_array(${entry}::jsonb || jsonb_build_object('claimSeq', claim_seq)),
            cancel_requested_at = case when ${stopping} then coalesce(cancel_requested_at, now()) else cancel_requested_at end,
            stopped_by = case when ${stopping} then coalesce(stopped_by, ${stop?.stoppedBy ?? null}) else stopped_by end
        where org_id = ${orgId} and id = ${id}
          and status = 'running' and lease_token = ${leaseToken} and lease_expires_at <= now()
        returning id
    `;
    if (!taken[0]) return null;
    const [staged] = await tx<{ result: CompleteResult; policy: EvidencePolicy | null }[]>`
        select result, policy from job_conclusion
        where org_id = ${orgId} and job_id = ${id} and lease_token = ${leaseToken}
    `;
    return completeInTx(tx, ctx, { id, leaseToken, result: staged!.result, staged: { policy: staged!.policy } });
}
