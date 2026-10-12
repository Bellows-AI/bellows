import { batchRepairCommand } from '@factory-ai/core';
import type { TransactionSql } from 'postgres';
import { followUpInTx } from './job-store-actions.js';

/**
 * An agent repair (docs/batches.md): an ordinary follow-up of the thread head, so the task keeps
 * its thread, its session and the PR it already published. The command restates the verification
 * and demands a fresh run. Runs inside the scheduler's transaction, under the batch's row lock.
 */
export async function repairInTx(
    tx: TransactionSql,
    run: {
        orgId: string;
        task: { root_job_id: string | null; acceptance: string; verification: string };
        startedBy: string | null;
    }
) {
    const { orgId, task, startedBy } = run;
    const [head] = await tx<{ id: string; failure_kind: string | null }[]>`
        select id, failure_kind from job
        where org_id = ${orgId} and root_job_id = ${task.root_job_id} and review_of is null
        order by created_at desc, id desc limit 1
    `;
    if (!head) return 'missing' as const;
    return followUpInTx(tx, {
        orgId,
        parentId: head.id,
        command: batchRepairCommand(task, head.failure_kind),
        createdBy: startedBy,
    });
}
