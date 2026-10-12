import type { BatchNextAction, BatchPlan, ResolvedBatchPlan } from '@factory-ai/core';

export const BATCH_DRAFT = 'draft';
export const BATCH_STARTED = 'started';
export type BatchStatus = typeof BATCH_DRAFT | typeof BATCH_STARTED;

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
}

export interface BatchRecord extends Omit<BatchSummary, 'title' | 'taskCount'> {
    startedBy: string | null;
    /** When the frozen time limit ends; null for a draft. */
    deadlineAt: string | null;
    /** When the pass that found the deadline passed fenced the batch, or null. */
    expiredAt: string | null;
    /** The first stage not yet advanced past; null for a draft and once every stage has advanced. */
    activeStage: string | null;
    /** As written while a draft; the resolved plan once started. */
    plan: BatchPlan;
    tasks: BatchTaskState[];
}

/** What a scheduling pass left: the long-poll's inputs. */
export interface BatchProgress {
    complete: boolean;
    cancelled: boolean;
    expired: boolean;
    /** Tasks holding a concurrency slot. */
    active: number;
    /** Retries and repairs queued, not yet launched. */
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

/** Usage the board does not measure: reported as unavailable, never estimated. */
export const REPORT_UNAVAILABLE = ['tokens', 'cost'] as const;

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
    pr: string | null;
    /** The task's thread, as the board's job path. */
    job: string | null;
    /** Measured only; token counts are not recorded per run, so `tokens` is always null. */
    usage: { wallClockMs: number; agentTurns: number; tokens: null };
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
    /** Each automerge stage's combined verification (064): a stage advances only on `passed`; `failed` needs a person. */
    verification: { stage: string; state: string; detail: string | null; headSha: string | null; checkedAt: string }[];
    tasks: BatchReportTask[];
    /** The newest PR observation of any task; null when none was read yet. */
    latestObservationAt: string | null;
    unavailable: readonly (typeof REPORT_UNAVAILABLE)[number][];
    totals: {
        accepted: number;
        failed: number;
        needsAttention: number;
        infraRetries: number;
        repairs: number;
        wallClockMs: number;
        agentTurns: number;
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
    /** `reconcile` over every started, unfinished batch of this org. */
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
}
