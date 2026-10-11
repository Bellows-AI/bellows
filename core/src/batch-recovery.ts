/**
 * The batch scheduler's recovery decisions (docs/batches.md): why a task's run failed, whether the
 * board retries or repairs it on its own, and what a person must do when it does not. No I/O — the
 * board's transactions count the attempts already spent, ask here, and write the answer under the
 * batch's row lock. A budget is counted from the durable attempt rows, so a restart cannot reset it.
 */

/** `batch_attempt.kind` of a retry the board queued itself: a transient infrastructure failure. */
export const RECOVERY_INFRA = 'infra_retry';
/** `batch_attempt.kind` of a follow-up asking the agent to fix a failed check, stale branch or conflict. */
export const RECOVERY_REPAIR = 'repair';
export type RecoveryKind = typeof RECOVERY_INFRA | typeof RECOVERY_REPAIR;

/** Why a task needs a person (`batch_task.attention`). */
export const ATTENTION_CONFIGURATION = 'configuration';
export const ATTENTION_BLOCKED = 'blocked';
export const ATTENTION_QUESTION = 'question';
export const ATTENTION_BUDGET = 'budget';
export const ATTENTION_REFUSED = 'refused';
export const ATTENTION_UNCLASSIFIED = 'unclassified';
export const ATTENTION_REASONS = [
    ATTENTION_CONFIGURATION,
    ATTENTION_BLOCKED,
    ATTENTION_QUESTION,
    ATTENTION_BUDGET,
    ATTENTION_REFUSED,
    ATTENTION_UNCLASSIFIED,
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** Backoff before an automatic infrastructure retry: doubles from the base, capped. */
export const BATCH_RETRY_BACKOFF_BASE_MS = 60_000;
export const BATCH_RETRY_BACKOFF_MAX_MS = 900_000;

export type FailureClass = { kind: 'infra' } | { kind: 'repairable' } | { kind: 'attention'; reason: AttentionReason };

/** The infrastructure failure kinds: the run did not get to judge the work. */
const INFRA_KINDS: readonly string[] = ['timeout', 'cache_lost', 'services', 'runner_error'];
/** The kinds an agent can fix in its own checkout: a failed gate, an unlanded publish, a failed helper. */
const REPAIRABLE_KINDS: readonly string[] = ['gate', 'publish', 'helper'];
const CONFIGURATION_KINDS: readonly string[] = ['config', 'policy'];

/**
 * Classifies a failed run from its job status and `failure_kind`. An unanswered question outranks
 * every kind: the agent is waiting on a person, and retrying would invent the answer.
 */
export function classifyTaskFailure(failure: {
    status: string;
    failureKind: string | null;
    unansweredQuestion: boolean;
}): FailureClass {
    if (failure.unansweredQuestion) return { kind: 'attention', reason: ATTENTION_QUESTION };
    if (failure.status === 'dead') return { kind: 'infra' };
    const kind = failure.failureKind;
    if (kind === null) return { kind: 'attention', reason: ATTENTION_UNCLASSIFIED };
    if (INFRA_KINDS.includes(kind)) return { kind: 'infra' };
    if (REPAIRABLE_KINDS.includes(kind)) return { kind: 'repairable' };
    if (CONFIGURATION_KINDS.includes(kind)) return { kind: 'attention', reason: ATTENTION_CONFIGURATION };
    if (kind === 'blocked') return { kind: 'attention', reason: ATTENTION_BLOCKED };
    return { kind: 'attention', reason: ATTENTION_UNCLASSIFIED };
}

/** The wait before the nth automatic infrastructure retry (n counts from 1). */
export const recoveryBackoffMs = (n: number): number =>
    Math.min(BATCH_RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, n - 1), BATCH_RETRY_BACKOFF_MAX_MS);

export type RecoveryPlan =
    | { action: 'infra_retry'; delayMs: number }
    | { action: 'repair' }
    | { action: 'attention'; reason: AttentionReason };

/** What to do with a failed task: retry or repair while its budget lasts, otherwise ask a person. */
export function planRecovery(input: {
    failure: FailureClass;
    used: { infra: number; repairs: number };
    budgets: { infraRetries: number; repairs: number };
}): RecoveryPlan {
    const { failure, used, budgets } = input;
    if (failure.kind === 'attention') return { action: 'attention', reason: failure.reason };
    if (failure.kind === 'infra') {
        if (used.infra >= budgets.infraRetries) return { action: 'attention', reason: ATTENTION_BUDGET };
        return { action: RECOVERY_INFRA, delayMs: recoveryBackoffMs(used.infra + 1) };
    }
    if (used.repairs >= budgets.repairs) return { action: 'attention', reason: ATTENTION_BUDGET };
    return { action: RECOVERY_REPAIR };
}

/**
 * The follow-up that asks the agent to repair its own earlier attempt. The verification is
 * restated and must be re-run: an earlier pass does not count for the new head.
 */
export function batchRepairCommand(
    task: { acceptance: string; verification: string },
    failureKind: string | null
): string {
    const problem =
        failureKind === 'publish'
            ? 'Your last attempt could not publish: the branch is stale or conflicts with its base. Update the branch to its base, resolve any conflicts and publish again.'
            : 'Your last attempt failed its checks. Find out why, fix it and publish again.';
    return [
        problem,
        `Acceptance:\n${task.acceptance}`,
        `Verification (run it again now; an earlier result does not count):\n${task.verification}`,
    ].join('\n\n');
}

/** The wait reason a task needing attention carries: the exact reason and the job to look at. */
export function attentionWaitReason(reason: AttentionReason, subject: { jobId: string; detail?: string }): string {
    const at = `job ${subject.jobId}`;
    switch (reason) {
        case ATTENTION_QUESTION:
            return `needs an answer: ${subject.detail ?? 'an unanswered question'} (${at})`;
        case ATTENTION_CONFIGURATION:
            return `failed on configuration or permission, which a retry cannot fix (${at})`;
        case ATTENTION_BLOCKED:
            return `the agent reported itself blocked (${at})`;
        case ATTENTION_BUDGET:
            return `recovery budget exhausted: ${subject.detail ?? 'no automatic attempts left'} (${at})`;
        case ATTENTION_REFUSED:
            return `${subject.detail ?? 'the board refused the next attempt'} (${at})`;
        case ATTENTION_UNCLASSIFIED:
            return `failed with no recorded reason (${at})`;
    }
}

export type BatchNextAction =
    | { action: 'none' }
    | { action: 'wait' }
    | { action: 'answer'; method: 'POST'; path: string }
    | { action: 'accept'; method: 'POST'; path: string }
    | { action: 'retry'; method: 'POST'; path: string }
    | { action: 'merge'; url: string }
    | { action: 'new_batch'; method: 'POST'; path: string };

const batchPath = (batchId: string) => `/api/batches/${batchId}`;

/** The one supported next step for a task, built once so the report and the CLI cannot drift. */
export function batchNextAction(input: {
    batchId: string;
    batchState: 'running' | 'parked' | 'completed' | 'cancelled' | 'expired';
    task: {
        key: string;
        execution: string;
        gate: string;
        attention: string | null;
        /** The job that asked the question: the answer route addresses it, not the thread's root. */
        questionJobId: string | null;
        questionId: string | null;
        completionKind: string;
        prUrl: string | null;
    };
}): BatchNextAction {
    const { batchId, batchState, task } = input;
    const retry: BatchNextAction = {
        action: 'retry',
        method: 'POST',
        path: `${batchPath(batchId)}/tasks/${task.key}/retry`,
    };
    const finished = task.execution === 'succeeded' ? finishedAction(batchId, task) : null;
    if (task.gate === 'passed') return { action: 'none' };
    if (batchState === 'cancelled' || batchState === 'expired') {
        // Accepting a finished run and merging its PR are still honored; new work is not.
        return finished ?? { action: 'new_batch', method: 'POST', path: '/api/batches' };
    }
    // Only a running job can still receive an answer; a run that died asking is retried instead.
    if (
        task.attention === ATTENTION_QUESTION &&
        task.execution === 'running' &&
        task.questionJobId &&
        task.questionId
    ) {
        return {
            action: 'answer',
            method: 'POST',
            path: `/api/jobs/${task.questionJobId}/questions/${task.questionId}/answer`,
        };
    }
    if (task.execution === 'failed' || task.execution === 'stopped') return retry;
    if (task.execution === 'succeeded') return finished ?? retry;
    return { action: 'wait' };
}

/** What a person does with a finished run: accept it, or merge the PR it opened. Null when neither applies. */
function finishedAction(
    batchId: string,
    task: { key: string; completionKind: string; prUrl: string | null }
): BatchNextAction | null {
    if (task.completionKind === 'accepted') {
        return { action: 'accept', method: 'POST', path: `${batchPath(batchId)}/tasks/${task.key}/accept` };
    }
    return task.prUrl ? { action: 'merge', url: task.prUrl } : null;
}
