import {
    ATTENTION_BUDGET,
    ATTENTION_QUESTION,
    ATTENTION_UNCLASSIFIED,
    type AttentionReason,
    attentionWaitReason,
    batchRepairCommand,
    type CheckEvidence,
    type FailedGate,
    type ObservationOutcome,
    RECOVERY_INFRA,
    RECOVERY_REPAIR,
    type RepairEvidence,
} from '@factory-ai/core';
import type { TransactionSql } from 'postgres';
import { followUpInTx } from './job-store-actions.js';
import type { GateReport } from './job-store-types.js';

/** The scheduler's transaction, bound to one locked batch. */
export type Tx = { tx: TransactionSql; orgId: string; id: string };

/** Records a decision once. False when it was already recorded — the caller does nothing then. */
export async function decide(
    tx: TransactionSql,
    at: { orgId: string; id: string },
    decision: { key: string; kind: string; subject: string | null }
): Promise<boolean> {
    const rows = await tx`
        insert into batch_decision (org_id, batch_id, key, kind, subject)
        values (${at.orgId}, ${at.id}, ${decision.key}, ${decision.kind}, ${decision.subject})
        on conflict do nothing
        returning key
    `;
    return rows.length > 0;
}

/** Automatic recoveries a task has used, counted from the durable attempt rows. */
export async function recoveriesUsed(at: Tx, taskKey: string): Promise<{ infra: number; repairs: number }> {
    const { tx, orgId, id } = at;
    const [row] = await tx<{ infra: number; repairs: number }[]>`
        select count(*) filter (where kind = ${RECOVERY_INFRA})::int as infra,
               count(*) filter (where kind = ${RECOVERY_REPAIR})::int as repairs
        from batch_attempt where org_id = ${orgId} and batch_id = ${id} and task_key = ${taskKey}
    `;
    return row!;
}

/**
 * An observation (alias `o`) a recovery may act on: no hint is pending on it, it describes the
 * task's latest attempt, the PR it read is still the one the thread is bound to, and no merge of
 * that PR has been recorded since. The decision
 * and the launch both read it through this one predicate, so a repair decided on it and launched
 * on it judges the same evidence.
 */
export const actionableObservation = (tx: TransactionSql) => tx`
    not o.stale
    and o.attempt = (select max(a.attempt) from batch_attempt a
                     where a.org_id = o.org_id and a.batch_id = o.batch_id and a.task_key = o.task_key)
    and exists (select 1 from batch_task bt
                join job_pr bp on bp.org_id = bt.org_id and bp.root_job_id = bt.root_job_id
                where bt.org_id = o.org_id and bt.batch_id = o.batch_id and bt.key = o.task_key
                  and bp.repo = o.repo and bp.pr_number = o.pr_number)
    and not exists (select 1 from pr_merge pm
                    where pm.org_id = o.org_id and pm.repo = o.repo and pm.pr_number = o.pr_number)
`;

/** The observed failure a repair of a succeeded run answers; null when it no longer stands. */
async function observedEvidence(
    tx: TransactionSql,
    at: { orgId: string; batchId: string; taskKey: string }
): Promise<RepairEvidence | null> {
    const [row] = await tx<{ outcome: ObservationOutcome; evidence: CheckEvidence[] }[]>`
        select o.outcome, o.evidence from batch_pr_observation o
        where o.org_id = ${at.orgId} and o.batch_id = ${at.batchId} and o.task_key = ${at.taskKey}
          and o.repairable and ${actionableObservation(tx)}
    `;
    return row ? { source: 'observed', outcome: row.outcome, evidence: row.evidence } : null;
}

/** The gates a failed run recorded as failed, in the shape a repair prompt lists (bounded in core). */
const failedGates = (gates: GateReport[] | null): FailedGate[] =>
    (gates ?? [])
        .filter((g) => g.status === 'failed')
        .map(({ name, exitCode, output }) => ({ name, exitCode, output }));

/**
 * An agent repair (docs/batches.md): an ordinary follow-up of the thread head, so the task keeps
 * its thread, its session and the PR it already published. The command restates the verification
 * and demands a fresh run. A head that failed is repaired for its own failure cause; a head that
 * succeeded is repaired for what was observed on its PR, re-read here — `superseded` when that
 * evidence went stale or away since the decision. Runs inside the scheduler's transaction, under
 * the batch's row lock.
 */
export async function repairInTx(
    tx: TransactionSql,
    run: {
        orgId: string;
        batchId: string;
        task: { key: string; root_job_id: string | null; acceptance: string; verification: string };
        startedBy: string | null;
    }
) {
    const { orgId, task, startedBy } = run;
    const [head] = await tx<{ id: string; status: string; failure_cause: string | null; gates: GateReport[] | null }[]>`
        select id, status, failure_cause, gates from job
        where org_id = ${orgId} and root_job_id = ${task.root_job_id} and review_of is null
        order by created_at desc, id desc limit 1
    `;
    if (!head) return 'missing' as const;
    const evidence: RepairEvidence | null =
        head.status === 'succeeded'
            ? await observedEvidence(tx, { orgId, batchId: run.batchId, taskKey: task.key })
            : { source: 'run', cause: head.failure_cause, gates: failedGates(head.gates) };
    if (evidence === null) return 'superseded' as const;
    return followUpInTx(tx, {
        orgId,
        parentId: head.id,
        command: batchRepairCommand(task, evidence),
        createdBy: startedBy,
    });
}

/**
 * The wait reason of a failed run that needs a person: the question it left, the budget it spent,
 * or the kind and cause it failed with when neither was recognized (issue #581).
 */
export function failedAttentionReason(
    reason: AttentionReason,
    head: { head_id: string | null; failure_kind: string | null; failure_cause: string | null }
): string {
    let detail: string | undefined;
    if (reason === ATTENTION_QUESTION) detail = 'a question of this run was never answered';
    if (reason === ATTENTION_BUDGET) {
        detail =
            head.failure_cause === 'conflict'
                ? 'a merge conflict is still unresolved and no repairs are left'
                : 'no automatic attempts left';
    }
    if (reason === ATTENTION_UNCLASSIFIED && head.failure_kind !== null) {
        detail = `${head.failure_kind} (cause ${head.failure_cause ?? 'not recorded'})`;
    }
    return attentionWaitReason(reason, { jobId: head.head_id!, detail });
}
