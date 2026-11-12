import { ERROR_CODES, type BatchPlan, type BatchPlanIssue } from '@factory-ai/core';
import { BATCH_RUNNING, type BatchRecord, type BatchReportView, type BatchSummary } from '../batch-model.js';
import { request, type RequestOptions } from './request.js';
import { usePoll } from './usePoll.js';

/**
 * The batch routes as the SPA calls them (docs/batches.md): the board is the only scheduler, so
 * every write here is one request and every read is a poll — no browser-side state machine, no
 * completion rule of its own. Human credentials only, which is the session cookie.
 */

/** A started batch is re-read this often while it is not settled; a list at the same pace. */
export const BATCH_POLL_MS = 3000;
/** The board's idempotency header: a retried create or start after a dropped reply answers once. */
const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * A fresh idempotency key: 128 random bits as hex, within the board's 8–128 character pattern.
 * `getRandomValues`, not `randomUUID` — the latter exists only in a secure context, and a board
 * served over plain http on a LAN name has none.
 */
const KEY_BYTES = 16;
const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

export function newIdempotencyKey(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
    return Array.from(bytes, (byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, '0')).join('');
}

export interface BatchFailure {
    ok: false;
    error: string;
    code?: string;
    /** A `BAD_BATCH` refusal's path-addressed issues, when the board named them. */
    issues?: BatchPlanIssue[];
}

export type BatchResult<T> = { ok: true; data: T } | BatchFailure;

/** What a batch request takes: the method, the JSON body and any extra header (the idempotency key). */
type BatchSend = Pick<RequestOptions<unknown>, 'method' | 'body' | 'headers'>;

/** One batch request. A 401 goes to the gate like every other read; a refusal carries its code and issues. */
async function send<T>(path: string, init: BatchSend = {}): Promise<BatchResult<T>> {
    const result = await request<T>(path, { verb: 'The board refused the request', ...init });
    if (result.ok) return { ok: true, data: result.value };
    const issues = result.body?.issues as BatchPlanIssue[] | undefined;
    return {
        ok: false,
        error: result.unauthenticated ? 'Sign in again to continue' : result.error,
        ...(result.unauthenticated ? { code: ERROR_CODES.UNAUTHENTICATED } : result.code ? { code: result.code } : {}),
        ...(issues ? { issues } : {}),
    };
}

const batchPath = (id: string) => `/api/batches/${encodeURIComponent(id)}`;
const taskPath = (id: string, key: string) => `${batchPath(id)}/tasks/${encodeURIComponent(key)}`;
const post = (body: unknown = {}, key?: string): BatchSend => ({
    method: 'POST',
    body,
    ...(key ? { headers: { [IDEMPOTENCY_KEY_HEADER]: key } } : {}),
});

/** The batch writes: each answers the board's record (or a write receipt), never a guess at the next state. */
export const batchActions = {
    create: (plan: BatchPlan, key: string) =>
        send<{ id: string; version: number }>('/api/batches', post({ plan }, key)),
    replace: (id: string, version: number, plan: BatchPlan) =>
        send<{ id: string; version: number }>(batchPath(id), { method: 'PUT', body: { version, plan } }),
    validate: (id: string) => send<{ valid: boolean; version: number }>(`${batchPath(id)}/validate`, post()),
    start: (id: string, version: number, key: string) =>
        send<BatchRecord>(`${batchPath(id)}/start`, post({ version }, key)),
    cancel: (id: string) => send<BatchRecord>(`${batchPath(id)}/cancel`, post()),
    retry: (id: string, taskKey: string) => send<BatchRecord>(`${taskPath(id, taskKey)}/retry`, post()),
    accept: (id: string, taskKey: string) => send<BatchRecord>(`${taskPath(id, taskKey)}/accept`, post()),
};

export interface Polled<T> {
    data: T | null;
    error: string | null;
    /** True until the first answer lands. */
    loading: boolean;
    refresh: () => void;
}

/**
 * One read, repeated every `BATCH_POLL_MS` while `keepPolling` says so (an error always re-arms). A stale
 * answer from a previous `path` never lands, and a changed path resets the data so another batch's rows
 * are never shown under this one's heading: both are `usePoll`'s.
 */
function usePolled<T>(path: string | null, keepPolling: (data: T) => boolean): Polled<T> {
    const polled = usePoll<T>(path, {
        next: (outcome) => (outcome.kind === 'ok' && !keepPolling(outcome.value) ? null : BATCH_POLL_MS),
    });
    return { data: polled.data, error: polled.error, loading: polled.loading, refresh: polled.refresh };
}

/** The org's batches, newest first. Polled: a batch another member started is a row the list should grow. */
export function useBatchList(): Polled<BatchSummary[]> {
    const { data, ...rest } = usePolled<{ batches: BatchSummary[] }>('/api/batches', () => true);
    return { ...rest, data: data?.batches ?? null };
}

/** One batch. Polled until it settles; a draft is read once, since nothing moves in it. */
export function useBatch(id: string | null): Polled<BatchRecord> {
    return usePolled<BatchRecord>(id === null ? null : batchPath(id), (batch) => batch.status === BATCH_RUNNING);
}

/** A live report state: the board still schedules, so a task's `next` can still change. */
const REPORT_LIVE: readonly string[] = ['running', 'parked'];

/** A started batch's report, for each task's `next` (whose move it is). Polled while the board still schedules. */
export function useBatchReport(id: string): Polled<BatchReportView> {
    return usePolled<BatchReportView>(`${batchPath(id)}/report`, (report) => REPORT_LIVE.includes(report.state));
}

/** The batches a task's thread backs a task of, for the task page's backlink. Read once per task. */
export function useBatchesOfTask(taskId: string | null): BatchSummary[] {
    const polled = usePolled<{ batches: BatchSummary[] }>(
        taskId === null ? null : `/api/batches?task=${encodeURIComponent(taskId)}`,
        () => false
    );
    return polled.data?.batches ?? [];
}
