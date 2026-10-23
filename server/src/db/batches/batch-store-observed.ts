import {
    ATTENTION_BUDGET,
    ATTENTION_CLOSED,
    attentionWaitReason,
    GATE_OPEN,
    OUTCOME_CLOSED,
    planRecovery,
    RECOVERY_REPAIR,
    TASK_RETRY,
    TASK_SUCCEEDED,
} from '@factory-ai/core';
import { actionableObservation, decide, failedAttentionReason, recoveriesUsed, type Tx } from './batch-store-repair.js';
import { DECISION_ADVANCE, DECISION_REPAIR } from './batch-store-types.js';

/**
 * Recovery from a task's observed PR after its run succeeded (docs/batches.md, issue #581): a
 * confirmed failing check or conflict queues one repair per observation revision, within the
 * task's repair budget; a PR closed without merging parks the task for a person. Runs in the
 * scheduler's pass, under the batch's row lock, and never in a fenced batch — the caller checks.
 */

/** The attention a succeeded task carries from its PR; the gate's own wait reason must not overwrite it. */
export const OBSERVED_ATTENTION: readonly string[] = [ATTENTION_CLOSED, ATTENTION_BUDGET];

interface ObservedTask {
    key: string;
    attention: string | null;
    wait_reason: string | null;
    head_id: string | null;
    attempt: number;
    revision: string;
    outcome: string | null;
    repairable: boolean;
    pr_url: string | null;
}

/** True when any task changed. */
export async function recoverObserved(at: Tx, budgets: { infraRetries: number; repairs: number }): Promise<boolean> {
    const { tx, orgId, id } = at;
    const tasks = await tx<ObservedTask[]>`
        select t.key, t.attention, t.wait_reason, o.attempt, o.revision::text as revision, o.outcome, o.repairable,
               o.pr_url,
               (select j.id from job j
                where j.org_id = t.org_id and j.root_job_id = t.root_job_id and j.review_of is null
                order by j.created_at desc, j.id desc limit 1) as head_id
        from batch_task t
        join batch_pr_observation o on o.org_id = t.org_id and o.batch_id = t.batch_id and o.task_key = t.key
        where t.org_id = ${orgId} and t.batch_id = ${id} and t.execution = ${TASK_SUCCEEDED}
          and t.gate = ${GATE_OPEN} and ${actionableObservation(tx)}
          and not exists (
              select 1 from batch_decision d
              where d.org_id = t.org_id and d.batch_id = t.batch_id and d.key = ${`${DECISION_ADVANCE}:`}::text || t.stage_key
          )
    `;
    let changed = false;
    for (const task of tasks) {
        if (task.outcome === OUTCOME_CLOSED) {
            changed = (await parkClosed(at, task)) || changed;
        } else if (task.attention === ATTENTION_CLOSED || clearsBudget(task)) {
            // Reopened, or green again after the budget ran out: the gate's own wait reason takes over.
            await tx`
                update batch_task set attention = null, wait_reason = null
                where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
            `;
            changed = true;
        }
        if (task.repairable) changed = (await queueRepair(at, { task, budgets })) || changed;
    }
    return changed;
}

/** A spent budget stops mattering once a fresh read finds nothing to repair. */
const clearsBudget = (task: ObservedTask): boolean =>
    task.attention === ATTENTION_BUDGET && !task.repairable && task.outcome !== null;

/** A PR closed without merging can neither pass the gate nor be repaired: a person reopens it or retries. */
async function parkClosed(at: Tx, task: ObservedTask): Promise<boolean> {
    const { tx, orgId, id } = at;
    const waitReason = attentionWaitReason(ATTENTION_CLOSED, { jobId: task.head_id ?? '', detail: task.pr_url ?? '' });
    if (task.attention === ATTENTION_CLOSED && task.wait_reason === waitReason) return false;
    await tx`
        update batch_task set attention = ${ATTENTION_CLOSED}, wait_reason = ${waitReason}
        where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
    `;
    return true;
}

/**
 * One decision per task, attempt and observation revision, so a replayed observation, a second
 * scheduler and a restart act once. The repair itself launches through the ordinary retry slot.
 */
async function queueRepair(
    at: Tx,
    run: { task: ObservedTask; budgets: { infraRetries: number; repairs: number } }
): Promise<boolean> {
    const { tx, orgId, id } = at;
    const { task, budgets } = run;
    const key = `${DECISION_REPAIR}:${task.key}:${task.attempt}:${task.revision}`;
    if (!(await decide(tx, at, { key, kind: DECISION_REPAIR, subject: task.key }))) return false;
    const plan = planRecovery({ failure: { kind: 'repairable' }, used: await recoveriesUsed(at, task.key), budgets });
    if (plan.action === RECOVERY_REPAIR) {
        await tx`
            update batch_task
            set execution = ${TASK_RETRY}, recovery = ${RECOVERY_REPAIR}, not_before = null, attention = null,
                wait_reason = null
            where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
        `;
        return true;
    }
    const reason = plan.action === 'attention' ? plan.reason : ATTENTION_BUDGET;
    await tx`
        update batch_task
        set attention = ${reason},
            wait_reason = ${failedAttentionReason(reason, { head_id: task.head_id, failure_kind: null, failure_cause: null })}
        where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
    `;
    return true;
}

/**
 * Withdraws an undispatched observed repair whose evidence no longer stands at launch: the task
 * goes back to its succeeded run and the decision is reclaimed, so a refresh that confirms the
 * same failure decides again. Nothing was dispatched, so nothing is charged.
 */
export async function withdrawRepair(at: Tx, task: { key: string; attempt: number }): Promise<void> {
    const { tx, orgId, id } = at;
    await tx`
        delete from batch_decision
        where org_id = ${orgId} and batch_id = ${id} and kind = ${DECISION_REPAIR} and subject = ${task.key}
          and key like ${`${DECISION_REPAIR}:${task.key}:${task.attempt}:%`}
    `;
    await tx`
        update batch_task
        set execution = ${TASK_SUCCEEDED}, recovery = null, not_before = null, attention = null, wait_reason = null
        where org_id = ${orgId} and batch_id = ${id} and key = ${task.key}
    `;
}
