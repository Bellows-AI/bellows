/**
 * What stops or parks a run: stop, suspend and the interruption a lost or blocked lease records.
 */

import type { Fragment, TransactionSql } from 'postgres';
import { stopReviewsOf, stopRows } from './job-store-rows.js';
import { releaseOpen } from './job-store-interruption-budget.js';
import { settleIfMergeClosed } from './job-store-merge.js';
import { fingerprintOf, missedSettle, recordReceipt, settleReplayOf, type SettleKey } from './job-store-receipts.js';
import { commitStagedForStop } from './job-store-conclusions.js';
import { stagedFingerprint } from './job-store-staged.js';
import type { JobStatus, JobStore, JobStoreContext, SuspendResult } from './job-store-types.js';
import { recordLaunchOutcome } from './job-store-provenance.js';

export type StopJobResult = Awaited<ReturnType<JobStore['stop']>>;

export async function stopJob(ctx: JobStoreContext, id: string, stoppedBy: string | null): Promise<StopJobResult> {
    const { sql, orgId, wallTick, prs } = ctx;
    // One statement decides the outcome by the status it sees. A QUEUED row never started,
    // so it is settled `stopped` here: the turn is over, and the session it keeps is what
    // the follow-up continues. A RUNNING
    // row whose lease is still live is stamped `cancel_requested_at` and left running:
    // the request travels on the heartbeat the worker already sends, and the settle that
    // honours it (suspend under the stamp) clears it. A RUNNING row whose lease has
    // ALREADY expired is settled `stopped` here instead: nobody holds the
    // lease, so a stamp would wait for a heartbeat nobody will send — and a previous
    // holder that is still beating loses the row on its next beat (`lost`, the kill
    // order) exactly as a reclaim delivers it. The settle lands like the suspend park
    // does: finished_at stamped, the last segment banked, the attempt handed back — a
    // stop is a park, not a failed try — and the session kept for the follow-up.
    // coalesce keeps the FIRST request, which is what makes /stop idempotent rather than
    // a rewrite of when it was asked. stopped_by coalesces beside it unconditionally —
    // every status this UPDATE touches is a stoppable one, so this caller acted, and the
    // first asker is the actor that survives. Under the row's lock, an expired attempt that staged its
    // conclusion is committed first, its Stop stamped with it: the verdict stands, and
    // the row the statement then finds terminal answers the conflict below with the committed status.
    const rows = await sql.begin(async (tx) => {
        await tx`select id from job where org_id = ${orgId} and id = ${id} for update`;
        await commitStagedForStop(ctx, tx, { id, stoppedBy });
        return stopRows(tx, { orgId, wallTick, stoppedBy, where: tx`id = ${id}` });
    });
    const row = rows[0];
    if (!row) {
        // Nothing settled or moving — a task that already ended has no turn to stop, and
        // the status rides the refusal so the route can say which.
        const [other] = await sql<{ status: JobStatus }[]>`
            select status from job where org_id = ${orgId} and id = ${id}
        `;
        return other ? { result: 'conflict', status: other.status } : 'missing';
    }
    // The caller's reviews go with it: a Stop reaches every separate run it started.
    await stopReviewsOf(sql, { orgId, wallTick, stoppedBy }, [id]);
    if (row.cancel_requested_at === null) {
        // A settled stop ends the thread's turn: its PR waits have nothing left to
        // fold for — the session a follow-up continues from starts its own wait cycle.
        if (prs) {
            await prs.cancelWaitsForRoot(row.root_job_id, 'task stopped');
        }
        // A merge-marked thread whose last moving member just stopped is closed by that stop:
        // done stamp, reclaim — the shared conditional settle, a no-op on any
        // thread the closure never marked.
        await settleIfMergeClosed(ctx, row.root_job_id);
    }
    return row.cancel_requested_at !== null
        ? { result: 'requested', cancelRequestedAt: row.cancel_requested_at.toISOString() }
        : { result: 'stopped' };
}

export async function suspendJob(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string
): ReturnType<JobStore['suspend']> {
    const { sql, orgId, wallTick } = ctx;
    // One update: the parking IS the user's stop landing (the stamp the heartbeat
    // delivered). The row settles `stopped` — terminal, `finished_at` stamped, the session
    // kept for the follow-up that continues the turn. The lease expires, exactly as insert
    // does it: the row is not claimable, so this changes nothing while it sits — and then
    // it is the difference between the next poll acting on the row and it waiting out the
    // lease the dying worker held. The command is in the transcript now
    // (command_delivered_at), the stamp clears — the stop has happened — and the attempt is
    // handed back: a park is not a failed try, so it must never exhaust max_attempts. The park and
    // its settle receipt commit together, so a replay after a lost answer gets it.
    const key: SettleKey = { orgId, jobId: id, leaseToken, operation: 'suspend', fingerprint: fingerprintOf(null) };
    return sql.begin(async (tx) => {
        if ((await stagedFingerprint(tx, key)) !== null) return { result: 'conflict' };
        const rows = await tx<{ id: string; status: JobStatus; root_job_id: string }[]>`
            update job set
                status           = 'stopped',
                finished_at      = now(),
                -- The park ends the segment the attempt was running: the container was doing
                -- real work up to now, and the time after this statement banks nothing.
                wall_clock_ms    = ${wallTick},
                lease_token      = null,
                -- Expired on the way in, exactly as insert does it.
                lease_expires_at = now(),
                -- The command is in the transcript now, and this is the moment that becomes
                -- true: the claim reads this column to keep a resumed follow-up from
                -- re-delivering it (see claim). coalesce, so parking twice stamps once.
                command_delivered_at = coalesce(command_delivered_at, now()),
                -- Parking IS the deferred stop landing (the flag was set by the user's /stop
                -- and delivered by the heartbeat): cleared now, or the settled row would keep
                -- answering a request that already happened.
                cancel_requested_at = null,
                -- Hands back the attempt the claim took.
                attempts         = greatest(attempts - 1, 0)
            where org_id = ${orgId} and id = ${id}
              and status = 'running' and lease_token = ${leaseToken}
            returning id, status, root_job_id
        `;
        if (rows[0]) {
            // The park settles a moving row; a merge-marked thread whose last moving member just
            // parked is closed by it — the shared conditional settle.
            await settleIfMergeClosed(ctx, rows[0].root_job_id, tx);
            const answer = { result: 'ok', status: rows[0].status } as const;
            await recordReceipt(tx, key, answer);
            return answer;
        }
        return missedSettle<SuspendResult>(tx, key);
    });
}

/**
 * How long a blocked hand-back defers the next claim: the claim could not start because a
 * leftover of an earlier claim is still terminating, so an immediate re-claim would only meet it again.
 */
export const BLOCKED_RETRY_SECONDS = 60;

/** The interruption the next claim records for an attempt whose lease expired. */
export const LEASE_EXPIRED_REASON = 'the lease expired: its driver went silent';

export async function interruptJob(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    {
        reason,
        release,
        claimSeq = null,
        refused = false,
        blocked = false,
        requirement = false,
        nodeLoss = false,
        orgSuspended = false,
    }: Parameters<JobStore['interrupt']>[2]
): ReturnType<JobStore['interrupt']> {
    const { sql, orgId, wallTick } = ctx;
    // One lease-guarded update, an agent ran: the segment banks to the
    // wall clock and `started_at` clears, so the next claim banks nothing twice. `release` false is
    // an adoption: an attempt this claim superseded was the one interrupted (`claimSeq` names it),
    // and this one keeps its lease. A Stop already stamped wins over a release, as over a suspend.
    // An attempt already recorded (handed over, or expired and recorded by the claim that took it
    // over, then adopted) is one disruption: refunded once.
    const entry = sql.json({
        reason,
        at: new Date().toISOString(),
        ...(blocked ? { blocked: true } : {}),
        ...(requirement ? { requirement: true } : {}),
        ...(nodeLoss ? { nodeLoss: true } : {}),
        ...(orgSuspended ? { orgSuspended: true } : {}),
        refunded: true,
    });
    // Blocked, requirement and org-suspended releases spend no budget, so both are accepted past a spent one; a node loss spends only
    // its own bound, accepted past a spent poison budget (see `releaseOpen`).
    const open = releaseOpen(sql, { release, blocked, requirement, nodeLoss, orgSuspended });
    const recorded = sql`interruptions @> jsonb_build_array(
        jsonb_build_object('claimSeq', coalesce(${claimSeq}::bigint, claim_seq))
    )`;
    // A release concludes the attempt, so it records a settle receipt in the same transaction (issue
    // #821); an adoption keeps the lease, and the `recorded` check above is its idempotence.
    const key: SettleKey = {
        orgId,
        jobId: id,
        leaseToken,
        operation: 'interrupt',
        fingerprint: fingerprintOf({
            reason,
            release,
            claimSeq,
            blocked,
            requirement,
            nodeLoss,
            ...(orgSuspended ? { orgSuspended } : {}),
        }),
    };
    return sql.begin(async (tx) => {
        // A staged conclusion is the attempt's outcome: nothing hands it back instead.
        if (release && (await stagedFingerprint(tx, key)) !== null) return { result: 'conflict' };
        await recordInterruptLaunch(tx, { orgId, id, leaseToken }, { release, refused, claimSeq, open }, recorded);
        const rows = await tx<{ status: JobStatus; root_job_id: string }[]>`
            update job set
                status           = case when not ${release} then status
                                        when cancel_requested_at is null then 'queued' else 'stopped' end,
                finished_at      = case when ${release} and cancel_requested_at is not null then now() else finished_at end,
                wall_clock_ms    = case when ${release} then ${wallTick} else wall_clock_ms end,
                started_at       = case when ${release} then null else started_at end,
                lease_token      = case when ${release} then null else lease_token end,
                lease_expires_at = case when ${release} then now() else lease_expires_at end,
                claim_deferred_until = case when ${release && blocked}
                    then now() + make_interval(secs => ${BLOCKED_RETRY_SECONDS}::int) else claim_deferred_until end,
                cancel_requested_at = case when ${release} then null else cancel_requested_at end,
                attempts         = greatest(attempts - 1, 0),
                interruptions    = interruptions || jsonb_build_array(
                    ${entry}::jsonb || jsonb_build_object('claimSeq', coalesce(${claimSeq}::bigint, claim_seq))
                )
            where org_id = ${orgId} and id = ${id}
              and status = 'running' and lease_token = ${leaseToken}
              and ${open}
              and not ${recorded}
            returning status, root_job_id
        `;
        const row = rows[0];
        if (row) {
            if (row.status === 'stopped') await settleIfMergeClosed(ctx, row.root_job_id, tx);
            await settleHandBack(tx, { orgId, id, handedBack: release && requirement });
            const answer = { result: 'ok', status: row.status } as const;
            if (release) await recordReceipt(tx, key, answer);
            return answer;
        }
        return missedInterrupt(tx, key, recorded);
    });
}

/**
 * The requirement hand-back happened: what the asking run owed is paid. An outcome told to the claim that was just
 * handed back was never acted on by its agent, so it is told again to the claim that continues the session.
 */
async function settleHandBack(
    tx: TransactionSql,
    { orgId, id, handedBack }: { orgId: string; id: string; handedBack: boolean }
): Promise<void> {
    if (!handedBack) return;
    await tx`
        update job_integration_requirement q
        set hand_back_pending = false,
            delivered_claim_seq = case when q.delivered_claim_seq = j.claim_seq then null else q.delivered_claim_seq end
        from job j
        where j.org_id = ${orgId} and j.id = ${id}
          and q.org_id = ${orgId} and q.source = 'runtime' and q.asked_job_id = ${id}
          and (q.hand_back_pending or q.delivered_claim_seq = j.claim_seq)
    `;
}

/**
 * The launch outcome an interruption proves, decided on the row the interruption's
 * update changes, locked here. A release is recorded only under the update's own conditions (a
 * spent budget or a replay records nothing); an adoption link is a fact of the adopting claim
 * whether or not the expiry already recorded the interruption, and set once.
 */
async function recordInterruptLaunch(
    tx: TransactionSql,
    at: { orgId: string; id: string; leaseToken: string },
    {
        release,
        refused,
        claimSeq,
        open,
    }: { release: boolean; refused: boolean; claimSeq: number | null; open: Fragment },
    recorded: Fragment
): Promise<void> {
    if (!refused && release) return;
    const { orgId, id, leaseToken } = at;
    const guard = release ? tx`and ${open} and not ${recorded}` : tx``;
    const [held] = await tx<{ claim_seq: string }[]>`
        select claim_seq from job
        where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken} ${guard}
        for update
    `;
    if (!held) return;
    const claim = { orgId, jobId: id, claimSeq: held.claim_seq };
    if (release) await recordLaunchOutcome(tx, claim, { refused: true });
    else if (claimSeq !== null) await recordLaunchOutcome(tx, claim, { adopts: claimSeq });
}

/**
 * An interrupt whose update missed: a released one replayed answers its receipt; an
 * adoption already recorded answers ok again, without a second refund; otherwise the lease is
 * lost, the job gone, or the budget spent.
 */
async function missedInterrupt(
    tx: TransactionSql,
    key: SettleKey,
    recorded: Fragment
): ReturnType<JobStore['interrupt']> {
    const replayed = await settleReplayOf<SuspendResult>(tx, key);
    if (replayed) return replayed;
    const [held] = await tx<{ held: boolean; recorded: boolean; status: JobStatus }[]>`
        select status = 'running' and lease_token = ${key.leaseToken} as held, ${recorded} as recorded, status
        from job where org_id = ${key.orgId} and id = ${key.jobId}
    `;
    if (!held) return { result: 'missing' };
    if (!held.held) return { result: 'lost' };
    return held.recorded ? { result: 'ok', status: held.status } : { result: 'exhausted' };
}
