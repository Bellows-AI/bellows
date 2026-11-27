import type { MergeDeps } from './batch-store-merge.js';

/** A wait note is a sentence for the task's row; longer is clipped. */
const MERGE_WAIT_LIMIT = 300;

/**
 * Records why the merger cannot merge a task's observed PR yet, or clears it with null. True when the stored note
 * changed, so the caller reconciles the batch (which writes the task's wait reason) only when there is something new.
 */
export async function setMergeWait(
    deps: MergeDeps,
    who: { batchId: string; taskKey: string },
    wait: string | null
): Promise<boolean> {
    const note = wait === null ? null : wait.slice(0, MERGE_WAIT_LIMIT);
    const rows = await deps.sql`
        update batch_pr_observation set merge_wait = ${note}
        where org_id = ${deps.orgId} and batch_id = ${who.batchId} and task_key = ${who.taskKey}
          and merge_wait is distinct from ${note}
        returning task_key
    `;
    return rows.length > 0;
}
