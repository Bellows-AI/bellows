import { holdsSlot, isAccepted, TASK_CANCELLED, TASK_NO_PR } from '@factory-ai/core';
import { lockBatch, reconcileBatch, type ScheduleDeps } from './batch-store-schedule.js';
import type { BatchTaskClosed } from './batch-store-types.js';

/** Why a force-closed required task holds its stage, and the one way past it. */
const CLOSED_REQUIRED =
    'closed by a person while the batch ran; its stage cannot advance without it — cancel the batch to end it';

/**
 * A person's force-close of a live batch's thread (docs/batches.md): the task is cancelled under
 * the batch lock — never retried or repaired, a required one holding its stage, an optional one
 * letting it advance — then reconcile stops the thread through the job store's stop and closes it
 * through its Done. A moving task keeps its execution, and so its concurrency slot, until its run
 * settles; the pass that folds the settle in cancels it. An accepted task and a batch that already
 * ended keep their outcome (`kept`); only the thread closes. Null when no batch task backs the
 * thread. `doneAt` is null while a stopped run is still settling: a later pass closes it.
 */
export async function closeBatchTask(
    deps: ScheduleDeps,
    jobId: string,
    closedBy: string | null
): Promise<BatchTaskClosed | null> {
    const { sql, orgId } = deps;
    const [owner] = await sql<{ batch_id: string; key: string; root_job_id: string }[]>`
        select t.batch_id, t.key, t.root_job_id
        from job j
        join batch_task t on t.org_id = j.org_id and t.root_job_id = j.root_job_id
        where j.org_id = ${orgId} and j.id = ${jobId}
    `;
    if (!owner) return null;
    const id = owner.batch_id;
    const outcome = await sql.begin(async (tx): Promise<'cancelled' | 'kept'> => {
        const batch = await lockBatch(tx, orgId, id);
        if (!batch || batch.completed_at !== null || batch.cancelled_at !== null || batch.expired_at !== null) {
            return 'kept';
        }
        const [task] = await tx<{ required: boolean; execution: string; gate: string; closed_at: Date | null }[]>`
            select required, execution, gate, closed_at from batch_task
            where org_id = ${orgId} and batch_id = ${id} and key = ${owner.key}
        `;
        if (!task) return 'kept';
        if (isAccepted(task)) {
            await tx`
                update batch_task
                set closed_at = coalesce(closed_at, now()), closed_by = coalesce(closed_by, ${closedBy})
                where org_id = ${orgId} and batch_id = ${id} and key = ${owner.key}
            `;
            return 'kept';
        }
        if (task.closed_at !== null) return 'cancelled';
        // A moving run holds its slot until its stop lands; anything else is cancelled now.
        const execution = holdsSlot(task.execution) ? task.execution : TASK_CANCELLED;
        await tx`
            update batch_task
            set execution = ${execution}, closed_at = now(), closed_by = ${closedBy}, attention = null,
                recovery = null, not_before = null, wait_reason = ${task.required ? CLOSED_REQUIRED : null}
            where org_id = ${orgId} and batch_id = ${id} and key = ${owner.key}
        `;
        return 'cancelled';
    });
    await reconcileBatch(deps, id);
    const [row] = await sql<{ pr: string; done_at: Date | null }[]>`
        select t.pr,
               (select j.done_at from job j
                where j.org_id = t.org_id and j.root_job_id = t.root_job_id and j.review_of is null
                order by j.created_at desc, j.id desc limit 1) as done_at
        from batch_task t
        where t.org_id = ${orgId} and t.batch_id = ${id} and t.key = ${owner.key}
    `;
    return {
        batchId: id,
        task: owner.key,
        outcome,
        pr: !row || row.pr === TASK_NO_PR ? null : row.pr,
        doneAt: row?.done_at ? row.done_at.toISOString() : null,
    };
}
