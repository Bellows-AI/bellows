import {
    AUTOMERGE,
    GATE_OPEN,
    GATE_PASSED,
    judgeTaskGate,
    MERGE_CHANGED,
    MERGE_DISPATCHING,
    MERGE_LAPSED,
    MERGE_REFUSED,
    MERGE_UNCERTAIN,
    OUTCOME_CHECKS_MISSING,
    OUTCOME_REVIEW_REQUIRED,
    READ_BINDING,
    READ_FORBIDDEN,
    READ_NOT_FOUND,
    TASK_NO_PR,
    TASK_SUCCEEDED,
} from '@factory-ai/core';
import type { TransactionSql } from 'postgres';
import { OBSERVED_ATTENTION } from './batch-store-observed.js';
import { ACCEPTANCE_PR_MERGED, DECISION_ADVANCE } from './batch-store-types.js';

/**
 * The human PR gate (docs/batches.md): judged from durable evidence on every reconcile pass, under
 * the batch's row lock, so a merge that arrives before the run's verdict, a duplicate delivery and
 * a restart all reach the same answer. A task's recorded PR (`job_pr`) and its observed merge
 * (`pr_merge`) are joined on repo AND number; the number alone identifies nothing.
 */

interface GateRow {
    key: string;
    completion_kind: string;
    completion_condition: string | null;
    target_branch: string;
    pr: string;
    repo: string | null;
    pr_number: number | null;
    pr_url: string | null;
    base_branch: string | null;
    merged_at: Date | null;
    attempt: number;
    attempt_started_at: Date;
    wait_reason: string | null;
    attention: string | null;
    policy: string;
    merge_state: string | null;
    merge_detail: string | null;
    outcome: string | null;
    error_code: string | null;
}

/** The board's own word on its merge request, as the task's wait reason carries it; null once it says nothing. */
function mergeNoteOf(state: string | null, detail: string | null): string | null {
    switch (state) {
        case MERGE_REFUSED:
            return `merge refused: ${detail ?? 'no reason given'}`;
        case MERGE_CHANGED:
            return `merge held, the PR changed: ${detail ?? ''}`;
        case MERGE_LAPSED:
            return `merge not accepted by GitHub, will retry: ${detail ?? ''}`;
        case MERGE_UNCERTAIN:
            return 'a merge request has an unknown outcome; reconciling with GitHub';
        case MERGE_DISPATCHING:
            return 'merging';
        default:
            return null;
    }
}

/** Why the board cannot merge an observed PR by itself (`awaitsBoardMerge`); outranks an earlier merge request's note. */
function observedNoteOf(outcome: string | null, error: string | null): string | null {
    if (error === READ_NOT_FOUND || error === READ_FORBIDDEN || error === READ_BINDING) {
        return `the PR cannot be read (${error}); the board cannot merge it`;
    }
    switch (outcome) {
        case OUTCOME_REVIEW_REQUIRED:
            return 'the PR needs an approving review from a person before the board can merge it';
        case OUTCOME_CHECKS_MISSING:
            return "the PR's required checks never reported; the board cannot merge it until they do";
        default:
            return null;
    }
}

/** True only when a task's row changed: a pass that rewrites nothing must end the reconcile loop. */
export async function judgeGates(tx: TransactionSql, orgId: string, id: string): Promise<boolean> {
    const rows = await tx<GateRow[]>`
        select t.key, t.completion_kind, t.completion_condition, tg.branch as target_branch, t.pr, t.wait_reason, t.attention,
               p.repo, p.pr_number, p.pr_url, p.base_branch, m.merged_at,
               a.attempt, a.created_at as attempt_started_at, s.policy, mg.state as merge_state,
               mg.detail as merge_detail, o.outcome, o.error_code
        from batch_task t
        join batch_stage s on s.org_id = t.org_id and s.batch_id = t.batch_id and s.key = t.stage_key
        join batch_target tg on tg.org_id = t.org_id and tg.batch_id = t.batch_id and tg.key = t.target_key
        join lateral (
            select attempt, created_at from batch_attempt
            where org_id = t.org_id and batch_id = t.batch_id and task_key = t.key
            order by attempt desc limit 1
        ) a on true
        left join lateral (
            select state, detail from batch_merge
            where org_id = t.org_id and batch_id = t.batch_id and task_key = t.key and attempt = a.attempt
            order by id desc limit 1
        ) mg on true
        left join batch_pr_observation o on o.org_id = t.org_id and o.batch_id = t.batch_id and o.task_key = t.key
        left join job_pr p on p.org_id = t.org_id and p.root_job_id = t.root_job_id
        left join pr_merge m on m.org_id = p.org_id and m.repo = p.repo and m.pr_number = p.pr_number
        where t.org_id = ${orgId} and t.batch_id = ${id} and t.execution = ${TASK_SUCCEEDED}
          and t.gate = ${GATE_OPEN}
          and not exists (
              select 1 from batch_decision d
              where d.org_id = t.org_id and d.batch_id = t.batch_id and d.key = ${`${DECISION_ADVANCE}:`}::text || t.stage_key
          )
    `;
    let changed = false;
    for (const row of rows) {
        const hasPr = row.repo !== null && row.pr_number !== null && row.pr_url !== null && row.base_branch !== null;
        const judgement = judgeTaskGate({
            completionKind: row.completion_kind,
            condition: row.completion_condition,
            targetBranch: row.target_branch,
            pr: hasPr ? { url: row.pr_url!, baseBranch: row.base_branch! } : null,
            mergedAt: row.merged_at?.getTime() ?? null,
            attempt: row.attempt,
            attemptStartedAt: row.attempt_started_at.getTime(),
            automerge: row.policy === AUTOMERGE,
            mergeNote: observedNoteOf(row.outcome, row.error_code) ?? mergeNoteOf(row.merge_state, row.merge_detail),
        });
        if (judgement.pass) {
            await tx`
                insert into batch_acceptance (org_id, batch_id, task_key, attempt, kind, repo, pr_number, pr_url)
                values (${orgId}, ${id}, ${row.key}, ${row.attempt}, ${ACCEPTANCE_PR_MERGED}, ${row.repo},
                        ${row.pr_number}, ${row.pr_url})
                on conflict do nothing
            `;
            await tx`
                update batch_task set gate = ${GATE_PASSED}, pr = ${row.pr_url}, wait_reason = null, attention = null
                where org_id = ${orgId} and batch_id = ${id} and key = ${row.key}
            `;
            changed = true;
            continue;
        }
        const pr = row.pr_url ?? TASK_NO_PR;
        // A person's reason from the observed PR (closed, budget spent) outranks "waiting to merge".
        const waitReason = OBSERVED_ATTENTION.includes(row.attention ?? '') ? row.wait_reason : judgement.waitReason;
        if (pr === row.pr && waitReason === row.wait_reason) continue;
        await tx`
            update batch_task set pr = ${pr}, wait_reason = ${waitReason}
            where org_id = ${orgId} and batch_id = ${id} and key = ${row.key}
        `;
        changed = true;
    }
    return changed;
}
