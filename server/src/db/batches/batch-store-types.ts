import type { BatchNextAction, BatchPlan, ResolvedBatchPlan, UsageBlock } from '@factory-ai/core';

export const BATCH_DRAFT = 'draft';
/** The stored freeze flag (`batch_status_ck`, 059): a row is `draft` or `started`, never an end state. */
export const BATCH_ROW_STARTED = 'started';
export type BatchRowStatus = typeof BATCH_DRAFT | typeof BATCH_ROW_STARTED;

/** The lifecycle the API answers as `status`, derived on read by `lifecycleOf`. */
export const BATCH_RUNNING = 'running';
export const BATCH_COMPLETED = 'completed';
export const BATCH_CANCELLED = 'cancelled';
export const BATCH_EXPIRED = 'expired';
export type BatchStatus =
    | typeof BATCH_DRAFT
    | typeof BATCH_RUNNING
    | typeof BATCH_COMPLETED
    | typeof BATCH_CANCELLED
    | typeof BATCH_EXPIRED;

/** Cancelled outranks expired, which outranks completed: the report's `stateOf` ranks them the same way. */
export function lifecycleOf(batch: {
    status: BatchRowStatus;
    cancelledAt: unknown;
    expiredAt: unknown;
    completedAt: unknown;
}): BatchStatus {
    if (batch.status === BATCH_DRAFT) return BATCH_DRAFT;
    if (batch.cancelledAt) return BATCH_CANCELLED;
    if (batch.expiredAt) return BATCH_EXPIRED;
    if (batch.completedAt) return BATCH_COMPLETED;
    return BATCH_RUNNING;
}

/** Newest first; the list is a board overview, not a report. */
export const BATCH_LIST_LIMIT = 100;

/** `batch_decision.kind` (060): each decision is unique by its key, so repeating one writes nothing. */
export const DECISION_LAUNCH = 'launch';
export const DECISION_ADVANCE = 'advance';
export const DECISION_COMPLETE = 'complete';
export const DECISION_CANCEL = 'cancel';
export const DECISION_EXPIRE = 'expire';
/** A repair decided from an observed PR (065): `repair:<task>:<attempt>:<observation revision>`. */
export const DECISION_REPAIR = 'repair';

/** `batch_acceptance.kind` (061): what made a task's gate pass. */
export const ACCEPTANCE_ACCEPTED = 'accepted';
export const ACCEPTANCE_PR_MERGED = 'pr_merged';

export const BATCH_CREATE = 'batch-create';
export const BATCH_START = 'batch-start';
export type BatchOperation = typeof BATCH_CREATE | typeof BATCH_START;

export interface BatchIdempotency {
    operation: BatchOperation;
    key: string;
    fingerprint: string;
}

/** The per-task state fields: execution and attempt are the scheduler's, gate passes on a merged PR or a recorded acceptance, pr is the recorded PR's URL. */
export interface BatchTaskState {
    key: string;
    stage: string;
    execution: string;
    pr: string;
    gate: string;
    waitReason: string | null;
    /** Why the task needs a person (core's ATTENTION_REASONS), or null. */
    attention: string | null;
    /** When a person force-closed the task's thread while the batch ran, or null. */
    closedAt: string | null;
    rootJobId: string | null;
    /** Launches of the task's thread so far: 0 until dispatched, then one per retry. */
    attempt: number;
}

export interface BatchSummary {
    id: string;
    title: string;
    status: BatchStatus;
    version: number;
    taskCount: number;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    cancelledAt: string | null;
    completedAt: string | null;
    /** When the pass that found the deadline passed fenced the batch, or null. */
    expiredAt: string | null;
}

export interface BatchRecord extends Omit<BatchSummary, 'title' | 'taskCount'> {
    startedBy: string | null;
    /** When the frozen time limit ends; null for a draft. */
    deadlineAt: string | null;
    /** The first stage not yet advanced past; null for a draft and once every stage has advanced. */
    activeStage: string | null;
    /** As written while a draft; the resolved plan once started. */
    plan: BatchPlan;
    tasks: BatchTaskState[];
    /** Each automerge stage's combined verification (064): a stage advances only on `passed`; `failed` needs a person. */
    verification: BatchStageVerification[];
}

/** One automerge stage's combined verification row, as the record and the report both show it. */
export interface BatchStageVerification {
    stage: string;
    state: string;
    detail: string | null;
    headSha: string | null;
    checkedAt: string;
}

/** What a scheduling pass left: the long-poll's inputs. */
export interface BatchProgress {
    complete: boolean;
    cancelled: boolean;
    expired: boolean;
    /** Tasks holding a concurrency slot. */
    active: number;
    /** Retries and repairs queued, not yet launched, and open PRs the board is still merging. */
    waiting: number;
}

export type BatchAcceptRefusal =
    | { result: 'missing' }
    | { result: 'not_started' }
    | { result: 'cancelled' }
    | { result: 'no_task' }
    /** The task's stage already advanced: the accepted outcome is history. */
    | { result: 'settled' }
    /** The plan's completion for the task is a merged PR, not a person's acceptance. */
    | { result: 'not_acceptable' }
    /** No finished successful run to accept: the task is pending, moving or failed. */
    | { result: 'not_ready' };

export type BatchRetryRefusal =
    | { result: 'missing' }
    | { result: 'not_started' }
    | { result: 'cancelled' }
    | { result: 'expired' }
    | { result: 'no_task' }
    | { result: 'not_retryable' };

export type BatchCancelRefusal = { result: 'missing' } | { result: 'not_started' } | { result: 'finished' };

/** Why a draft write or freeze did not happen. `version` is the draft's current one when stale. */
export type BatchWriteRefusal = { result: 'missing' } | { result: 'started' } | { result: 'stale'; version: number };

export interface BatchStartInput {
    id: string;
    /** The draft version the resolved plan was derived from. */
    version: number;
    plan: ResolvedBatchPlan;
    startedBy: string | null;
    idempotency?: BatchIdempotency | undefined;
}

/** What the board last observed on a task's PR (063), as the report shows it; `stale` is a hint not yet re-read. */
export interface BatchReportObservation {
    outcome: string | null;
    checks: string | null;
    mergeability: string | null;
    review: string | null;
    headSha: string | null;
    targetSha: string | null;
    stale: boolean;
    observedAt: string | null;
    error: { code: string; detail: string | null } | null;
}

/** Why a task's token usage could not be read: its root was removed after the start, or telemetry is not readable. */
export type BatchUsageUnavailable = 'task-removed' | 'telemetry';

/** One task of the morning report: its outcome, what recovery spent, its links and the next supported step. */
export interface BatchReportTask {
    key: string;
    stage: string;
    required: boolean;
    execution: string;
    gate: string;
    attempts: number;
    infraRetries: number;
    repairs: number;
    /** A person's retries: counted apart, they spend no automatic budget. */
    manualRetries: number;
    /** Automatic recoveries left of the frozen budgets. */
    remaining: { infraRetries: number; repairs: number };
    attention: string | null;
    waitReason: string | null;
    /** When a person force-closed the task's thread while the batch ran, and who; null otherwise. */
    closedAt: string | null;
    closedBy: string | null;
    pr: string | null;
    /** The task's thread, as the board's job path. */
    job: string | null;
    /**
     * Wall clock and turns are measured from the job rows. `tokenUsage` is the task's all-time canonical
     * usage at `usageSnapshotAt` (core `taskUsageOf`); `tokenUsageUnavailable` says why it is `unavailable`.
     */
    usage: {
        wallClockMs: number;
        agentTurns: number;
        tokenUsage: UsageBlock;
        tokenUsageUnavailable: BatchUsageUnavailable | null;
    };
    observation: BatchReportObservation | null;
    next: BatchNextAction;
}

export type BatchReportState = 'running' | 'parked' | 'completed' | 'cancelled' | 'expired';

/** The durable report (docs/batches.md): assembled from rows on every read, so it survives a restart. */
export interface BatchReport {
    id: string;
    title: string;
    state: BatchReportState;
    startedAt: string;
    deadlineAt: string;
    expiredAt: string | null;
    cancelledAt: string | null;
    completedAt: string | null;
    budgets: { infraRetries: number; repairs: number; timeLimitMinutes: number };
    prs: { merged: { task: string; url: string; mergedAt: string }[]; open: { task: string; url: string }[] };
    verification: BatchStageVerification[];
    tasks: BatchReportTask[];
    /** The newest PR observation of any task; null when none was read yet. */
    latestObservationAt: string | null;
    /** The one repeatable-read snapshot the membership and the usage were read in. */
    usageSnapshotAt: string;
    totals: {
        accepted: number;
        failed: number;
        needsAttention: number;
        infraRetries: number;
        repairs: number;
        wallClockMs: number;
        agentTurns: number;
        /** All-time usage of the member tasks, one reducer block over their union; never a sum of the task blocks. */
        tokenUsage: UsageBlock;
        /** Members whose usage could not be read (removed after the start): above 0 the total is partial. */
        usageUnavailableTasks: number;
    };
}

export interface BatchStore {
    create(
        plan: BatchPlan,
        createdBy: string | null,
        idempotency?: BatchIdempotency
    ): Promise<{ id: string; version: number; replayed?: boolean }>;
    get(id: string): Promise<BatchRecord | null>;
    /** `rootJobId` narrows to the batches with a task backed by that thread: the task page's backlink. */
    list(rootJobId?: string): Promise<BatchSummary[]>;
    /** Replaces the whole draft, bumping its version; conditional on the version the caller last read. */
    replace(
        id: string,
        version: number,
        plan: BatchPlan
    ): Promise<{ result: 'ok'; version: number } | BatchWriteRefusal>;
    /** The batch a key already started, without writing — the route's replay check before its launch checks. */
    replayOfStart(createdBy: string | null, idempotency: BatchIdempotency): Promise<string | null>;
    /** Freezes the resolved plan, conditional on the draft's version. Queues nothing; dispatch is `reconcile`. */
    start(input: BatchStartInput): Promise<{ result: 'ok'; replayed?: boolean } | BatchWriteRefusal>;
    /**
     * One scheduling pass over a started batch (docs/batches.md): sync each task from its thread,
     * launch what the active stage and the concurrency limit allow, advance a settled stage, finish
     * the batch. Safe to repeat and to race — the decisions are unique and the batch row is locked.
     * Null when the batch is missing or still a draft.
     */
    reconcile(id: string): Promise<BatchProgress | null>;
    /** `reconcile` over every started batch of this org with work to schedule, stop or a thread to close. */
    reconcileOpen(): Promise<void>;
    /**
     * Fences the batch against scheduling, retries and advancement, then settles its active tasks
     * through the job store's stop. Idempotent; the settle repeats on every later pass until nothing moves.
     */
    cancel(id: string, cancelledBy: string | null): Promise<{ result: 'ok'; replayed: boolean } | BatchCancelRefusal>;
    /** Queues a failed, stopped or gate-refused task for another attempt in its own thread. */
    retry(id: string, taskKey: string): Promise<{ result: 'ok' } | BatchRetryRefusal>;
    /** The morning report of a started batch; null when this org has no such batch or it is a draft. */
    report(id: string): Promise<BatchReport | null>;
    /** Records a person's acceptance of a finished `accepted`-completion task, passing its gate. */
    accept(id: string, taskKey: string, acceptedBy: string | null): Promise<{ result: 'ok' } | BatchAcceptRefusal>;
    /**
     * A person's force-close of the batch task a thread backs: cancels the task (an accepted one
     * keeps its outcome), stops the thread and marks it done once it settles. Null when no task
     * backs the thread.
     */
    closeTask(jobId: string, closedBy: string | null): Promise<BatchTaskClosed | null>;
}

/**
 * A force-close's answer: the task, whether it was `cancelled` or `kept` its outcome (already
 * accepted, or its batch ended first), its PR left open, and the thread's done stamp — null while
 * its run settles.
 */
export interface BatchTaskClosed {
    batchId: string;
    task: string;
    outcome: 'cancelled' | 'kept';
    pr: string | null;
    doneAt: string | null;
}
