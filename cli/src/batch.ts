import { CONTENT_TYPE_HEADER, IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_REPLAYED_HEADER, JSON_CONTENT_TYPE } from './http.js';

/**
 * The batch routes of the board client (docs/batches.md) and the CLI's read of a batch's state.
 * The types are a display client's view of the board's records, copied — this package imports
 * nothing from core or server. A plan is carried whole and never rebuilt, so a multi-repository
 * draft and every task's target reference survive inspect → update untouched.
 */

export const BATCH_DRAFT = 'draft';
export const BATCH_STARTED = 'started';
/** The board's code for a plan or operation start cannot run yet (`ERROR_CODES.BATCH_UNSUPPORTED`). */
export const BATCH_UNSUPPORTED_CODE = 'BATCH_UNSUPPORTED';

export interface BatchTaskPlan {
    key: string;
    target?: string;
    executor?: string;
    /** Whose profile `executor` names (`user` or `org`); omitted means the batch's, else `user`. */
    executorScope?: string;
    objective: string;
    required: boolean;
    completion: { kind: string; condition?: string };
}

export interface BatchPlanView {
    title: string;
    targets: { key: string; repo: string; branch?: string }[];
    defaultTarget?: string;
    executor?: string;
    executorScope?: string;
    policy: string;
    concurrency: number;
    stages: { key: string; policy?: string; tasks: BatchTaskPlan[] }[];
}

/** A task's runtime state, as the board's read model carries it. */
export interface BatchTaskState {
    key: string;
    stage: string;
    execution: string;
    pr: string;
    gate: string;
    waitReason: string | null;
    /** When a person force-closed the task's thread while the batch ran, or null. */
    closedAt?: string | null;
    rootJobId: string | null;
}

/** An automerge stage's combined verification (core's `VERIFY_*` states), copied: it advances only on `passed`. */
export interface BatchStageVerification {
    stage: string;
    state: string;
    detail: string | null;
    headSha: string | null;
    checkedAt: string;
}

export const VERIFY_PASSED = 'passed';
export const VERIFY_FAILED = 'failed';

export interface BatchRecord {
    id: string;
    status: string;
    version: number;
    startedBy: string | null;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    /** The fences: once either is set the board starts nothing new for the batch. */
    cancelledAt: string | null;
    expiredAt: string | null;
    completedAt?: string | null;
    plan: BatchPlanView;
    tasks: BatchTaskState[];
    verification: BatchStageVerification[];
    /** Not in the body: read off the board's `Idempotency-Replayed` header. */
    replayed?: boolean;
}

/** The one supported next step for a task (core's `BatchNextAction`), copied. */
export interface BatchNextAction {
    action: string;
    method?: string;
    path?: string;
    url?: string;
}

/** What the board last observed on a task's PR; `stale` is a hint not yet re-read. */
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

export interface BatchReportTask {
    key: string;
    stage: string;
    execution: string;
    gate: string;
    attempts: number;
    infraRetries: number;
    repairs: number;
    manualRetries: number;
    remaining: { infraRetries: number; repairs: number };
    attention: string | null;
    waitReason: string | null;
    /** When a person force-closed the task's thread while the batch ran, and who; null otherwise. */
    closedAt: string | null;
    closedBy: string | null;
    pr: string | null;
    job: string | null;
    usage: { wallClockMs: number; agentTurns: number; tokens: number | null };
    observation: BatchReportObservation | null;
    next: BatchNextAction;
}

/** The board's morning report (`GET /api/batches/:id/report`), copied from the server's read model. */
export interface BatchReport {
    id: string;
    title: string;
    /** `running`, `parked`, `completed`, `cancelled` or `expired`. */
    state: string;
    startedAt: string;
    deadlineAt: string;
    expiredAt: string | null;
    cancelledAt: string | null;
    completedAt: string | null;
    budgets: { infraRetries: number; repairs: number; timeLimitMinutes: number };
    prs: { merged: { task: string; url: string; mergedAt: string }[]; open: { task: string; url: string }[] };
    verification: BatchStageVerification[];
    tasks: BatchReportTask[];
    latestObservationAt: string | null;
    /** What the board does not measure, named rather than estimated. */
    unavailable: string[];
}

export const REPORT_EXPIRED = 'expired';
export const REPORT_CANCELLED = 'cancelled';

export interface BatchSummary {
    id: string;
    title: string;
    status: string;
    version: number;
    taskCount: number;
    createdAt: string;
    startedAt: string | null;
}

export interface BatchDraftWritten {
    id: string;
    status: string;
    version: number;
    replayed?: boolean;
}

export interface BatchValidated {
    valid: boolean;
    version: number;
    plan: BatchPlanView;
}

/**
 * The execution states the board's dispatch (#579) settles a task in; a task not in one is still
 * moving. The wait's verdict is read from these, from `waitReason` and from the stages'
 * `verification`, nothing else.
 */
export const TASK_SUCCEEDED = 'succeeded';
export const TASK_FAILED = 'failed';
export const TASK_CANCELLED = 'cancelled';
const TASK_TERMINAL: readonly string[] = [TASK_SUCCEEDED, TASK_FAILED, TASK_CANCELLED];

export type BatchVerdict = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_attention';

/**
 * Where a started batch stands. A task with a `waitReason` needs a person (a human review gate, a
 * question), as does a stage whose combined verification failed, and those outrank everything:
 * nothing a wait does moves it. Otherwise the batch is settled only when every task is, and then a
 * failed task beats a cancelled one beats success — which also needs every stage verified.
 */
export function batchVerdict(batch: BatchRecord): BatchVerdict {
    if (batch.tasks.some((task) => task.waitReason !== null)) return 'needs_attention';
    if (batch.verification.some((stage) => stage.state === VERIFY_FAILED)) return 'needs_attention';
    if (!batch.tasks.every((task) => TASK_TERMINAL.includes(task.execution))) return 'running';
    if (batch.tasks.some((task) => task.execution === TASK_FAILED)) return 'failed';
    // A task a person force-closed in a batch that still completed was settled by that person.
    const settledByPerson = (task: BatchTaskState) => task.closedAt != null && batch.completedAt != null;
    if (batch.tasks.some((task) => task.execution === TASK_CANCELLED && !settledByPerson(task))) return 'cancelled';
    // The last automerge stage's tasks are all done while its verification is still being read.
    if (batch.verification.some((stage) => stage.state !== VERIFY_PASSED)) return 'running';
    return 'succeeded';
}

export interface BatchRoutes {
    createBatch(plan: unknown, idempotencyKey?: string): Promise<BatchDraftWritten>;
    listBatches(): Promise<BatchSummary[]>;
    getBatch(id: string): Promise<BatchRecord>;
    getBatchReport(id: string): Promise<BatchReport>;
    replaceBatch(id: string, version: number, plan: unknown): Promise<BatchDraftWritten>;
    validateBatch(id: string): Promise<BatchValidated>;
    startBatch(id: string, version: number, idempotencyKey?: string): Promise<BatchRecord>;
    cancelBatch(id: string): Promise<unknown>;
    retryBatchTask(id: string, task: string): Promise<unknown>;
    acceptBatchTask(id: string, task: string): Promise<unknown>;
}

/** One batch's route prefix, the id encoded for the reason `jobPath` is (board.ts). */
const batchPath = (id: string): string => `/api/batches/${encodeURIComponent(id)}`;
const taskPath = (id: string, task: string): string => `${batchPath(id)}/tasks/${encodeURIComponent(task)}`;

/** The batch routes over the client's `send` (one authenticated request) and its headers. */
export function batchRoutes(
    send: (path: string, init: RequestInit, onResponse?: (response: Response) => void) => Promise<unknown>,
    authHeaders: () => Record<string, string>
): BatchRoutes {
    const jsonInit = (method: string, body: unknown, key?: string): RequestInit => ({
        method,
        headers: {
            ...authHeaders(),
            ...(key === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: key }),
            [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE,
        },
        body: JSON.stringify(body),
    });
    const action = (path: string) => send(path, { method: 'POST', headers: authHeaders() });
    /** A keyed write's answer, marked when the board says the key had already done it. */
    const keyed = async <T extends object>(path: string, init: RequestInit): Promise<T & { replayed?: boolean }> => {
        let replayed = false;
        const payload = (await send(path, init, (response) => {
            replayed = response.headers.get(IDEMPOTENCY_REPLAYED_HEADER) === 'true';
        })) as T;
        return replayed ? { ...payload, replayed } : payload;
    };

    return {
        createBatch: (plan, key) => keyed('/api/batches', jsonInit('POST', { plan }, key)),
        async listBatches() {
            const payload = (await send('/api/batches', { headers: authHeaders() })) as { batches: BatchSummary[] };
            return payload.batches;
        },
        async getBatch(id) {
            return (await send(batchPath(id), { headers: authHeaders() })) as BatchRecord;
        },
        async getBatchReport(id) {
            return (await send(`${batchPath(id)}/report`, { headers: authHeaders() })) as BatchReport;
        },
        async replaceBatch(id, version, plan) {
            return (await send(batchPath(id), jsonInit('PUT', { version, plan }))) as BatchDraftWritten;
        },
        async validateBatch(id) {
            return (await send(`${batchPath(id)}/validate`, jsonInit('POST', {}))) as BatchValidated;
        },
        startBatch: (id, version, key) => keyed(`${batchPath(id)}/start`, jsonInit('POST', { version }, key)),
        cancelBatch: (id) => action(`${batchPath(id)}/cancel`),
        retryBatchTask: (id, task) => action(`${taskPath(id, task)}/retry`),
        acceptBatchTask: (id, task) => action(`${taskPath(id, task)}/accept`),
    };
}
