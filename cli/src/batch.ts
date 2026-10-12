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
    objective: string;
    required: boolean;
    completion: { kind: string; condition?: string };
}

export interface BatchPlanView {
    title: string;
    targets: { key: string; repo: string; branch?: string }[];
    defaultTarget?: string;
    executor?: string;
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
    rootJobId: string | null;
}

export interface BatchRecord {
    id: string;
    status: string;
    version: number;
    startedBy: string | null;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    plan: BatchPlanView;
    tasks: BatchTaskState[];
    /** Not in the body: read off the board's `Idempotency-Replayed` header. */
    replayed?: boolean;
}

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
 * moving. The wait's verdict is read from these and from `waitReason`, nothing else.
 */
export const TASK_SUCCEEDED = 'succeeded';
export const TASK_FAILED = 'failed';
export const TASK_CANCELLED = 'cancelled';
const TASK_TERMINAL: readonly string[] = [TASK_SUCCEEDED, TASK_FAILED, TASK_CANCELLED];

export type BatchVerdict = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_attention';

/**
 * Where a started batch stands. A task with a `waitReason` needs a person (a human review gate, a
 * question) and outranks everything: nothing a wait does moves it. Otherwise the batch is settled
 * only when every task is, and then a failed task beats a cancelled one beats success.
 */
export function batchVerdict(batch: BatchRecord): BatchVerdict {
    if (batch.tasks.some((task) => task.waitReason !== null)) return 'needs_attention';
    if (!batch.tasks.every((task) => TASK_TERMINAL.includes(task.execution))) return 'running';
    if (batch.tasks.some((task) => task.execution === TASK_FAILED)) return 'failed';
    if (batch.tasks.some((task) => task.execution === TASK_CANCELLED)) return 'cancelled';
    return 'succeeded';
}

export interface BatchRoutes {
    createBatch(plan: unknown, idempotencyKey?: string): Promise<BatchDraftWritten>;
    listBatches(): Promise<BatchSummary[]>;
    getBatch(id: string): Promise<BatchRecord>;
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
