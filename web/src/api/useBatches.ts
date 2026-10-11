import { ERROR_CODES, JSON_HEADERS, type BatchPlan, type BatchPlanIssue } from '@factory-ai/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BATCH_STARTED, batchVerdict, isSettled, type BatchRecord, type BatchSummary } from '../batch-model.js';
import { refusalOf } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

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

/** One batch request. A 401 goes to the gate like every other read; a refusal carries its code and issues. */
async function send<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<BatchResult<T>> {
    try {
        const response = await fetch(path, { ...init, ...(signal ? { signal } : {}) });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false, error: 'Sign in again to continue', code: ERROR_CODES.UNAUTHENTICATED };
        }
        if (!response.ok) {
            const body = (await response
                .clone()
                .json()
                .catch(() => ({}))) as { issues?: BatchPlanIssue[] };
            const refusal = await refusalOf(response, 'The board refused the request');
            return { ok: false, ...refusal, ...(body.issues ? { issues: body.issues } : {}) };
        }
        return { ok: true, data: (await response.json()) as T };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

const batchPath = (id: string) => `/api/batches/${encodeURIComponent(id)}`;
const taskPath = (id: string, key: string) => `${batchPath(id)}/tasks/${encodeURIComponent(key)}`;
const post = (body: unknown = {}, key?: string): RequestInit => ({
    method: 'POST',
    headers: { ...JSON_HEADERS, ...(key ? { [IDEMPOTENCY_KEY_HEADER]: key } : {}) },
    body: JSON.stringify(body),
});

/** The batch writes: each answers the board's record (or a write receipt), never a guess at the next state. */
export const batchActions = {
    create: (plan: BatchPlan, key: string) =>
        send<{ id: string; version: number }>('/api/batches', post({ plan }, key)),
    replace: (id: string, version: number, plan: BatchPlan) =>
        send<{ id: string; version: number }>(batchPath(id), {
            method: 'PUT',
            headers: JSON_HEADERS,
            body: JSON.stringify({ version, plan }),
        }),
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
 * One read, repeated every `BATCH_POLL_MS` while `keepPolling` says so. A stale answer from a
 * previous `path` never lands: each effect owns an abort controller, and a changed path resets
 * the data so another batch's rows are never shown under this one's heading.
 */
function usePolled<T>(path: string | null, keepPolling: (data: T) => boolean): Polled<T> {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(path !== null);
    const [nonce, setNonce] = useState(0);
    const refresh = useCallback(() => setNonce((n) => n + 1), []);
    const keep = useRef(keepPolling);
    keep.current = keepPolling;

    useEffect(() => {
        setData(null);
        setError(null);
        setLoading(path !== null);
    }, [path]);

    useEffect(() => {
        if (path === null) return;
        const ack = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = async () => {
            const result = await send<T>(path, {}, ack.signal);
            if (ack.signal.aborted) return;
            setLoading(false);
            if (result.ok) {
                setData(result.data);
                setError(null);
                if (keep.current(result.data)) timer = setTimeout(() => void tick(), BATCH_POLL_MS);
            } else {
                setError(result.error);
                timer = setTimeout(() => void tick(), BATCH_POLL_MS);
            }
        };
        void tick();
        return () => {
            ack.abort();
            clearTimeout(timer);
        };
    }, [path, nonce]);

    return { data, error, loading, refresh };
}

/** The org's batches, newest first. Polled: a batch another member started is a row the list should grow. */
export function useBatchList(): Polled<BatchSummary[]> {
    const { data, ...rest } = usePolled<{ batches: BatchSummary[] }>('/api/batches', () => true);
    return { ...rest, data: data?.batches ?? null };
}

/** One batch. Polled until it settles; a draft is read once, since nothing moves in it. */
export function useBatch(id: string | null): Polled<BatchRecord> {
    return usePolled<BatchRecord>(id === null ? null : batchPath(id), (batch) => {
        return batch.status === BATCH_STARTED && !isSettled(batchVerdict(batch));
    });
}

/** The batches a task's thread backs a task of, for the task page's backlink. Read once per task. */
export function useBatchesOfTask(taskId: string | null): BatchSummary[] {
    const polled = usePolled<{ batches: BatchSummary[] }>(
        taskId === null ? null : `/api/batches?task=${encodeURIComponent(taskId)}`,
        () => false
    );
    return polled.data?.batches ?? [];
}
