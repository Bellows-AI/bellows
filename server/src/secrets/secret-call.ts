/**
 * One absolute deadline per public store call, and what a database error means for the statement that raised
 * it (docs/secrets.md). A server SQLSTATE means the statement did not apply: transient classes retry, the
 * rest is a definitive `unavailable`. A connection lost after dispatch, or the deadline expiring mid-write, is
 * ambiguous and never retried by a write. A payload store's `ProviderFault` carries its own verdict; a
 * `misconfigured` one is a single try. Anything else is a bug and rethrows.
 */

import { ProviderFault } from './secret-payloads.js';

export class DeadlineError extends Error {}

export type Verdict = 'retry' | 'definitive' | 'ambiguous' | 'misconfigured' | 'rethrow';

const BEFORE_DISPATCH = new Set(['CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND']);
const AFTER_DISPATCH = new Set([
    'CONNECTION_CLOSED',
    'CONNECTION_DESTROYED',
    'CONNECTION_ENDED',
    'ECONNRESET',
    'EPIPE',
]);
const SQLSTATE = /^[0-9A-Z]{5}$/;
const TRANSIENT_CLASSES = ['08', '40', '53'];
const SERVER_NOT_READY = '57P03';

const codeOf = (error: unknown): unknown =>
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

function classifyCode(code: string): Verdict {
    if (BEFORE_DISPATCH.has(code)) {
        return 'retry';
    }
    if (AFTER_DISPATCH.has(code)) {
        return 'ambiguous';
    }
    if (!SQLSTATE.test(code)) {
        return 'rethrow';
    }
    const transient = TRANSIENT_CLASSES.some((prefix) => code.startsWith(prefix)) || code === SERVER_NOT_READY;
    return transient ? 'retry' : 'definitive';
}

export function classify(error: unknown): Verdict {
    if (error instanceof DeadlineError) {
        return 'ambiguous';
    }
    if (error instanceof ProviderFault) {
        return error.verdict;
    }
    const code = codeOf(error);
    return typeof code === 'string' ? classifyCode(code) : 'rethrow';
}

export interface Call {
    deadlineAt: number;
    signal: AbortSignal | undefined;
}

export const newCall = (signal: AbortSignal | undefined, ms: number): Call => ({
    deadlineAt: Date.now() + ms,
    signal,
});
export const remaining = (call: Call) => call.deadlineAt - Date.now();

export type Attempt<T> =
    | { kind: 'ok'; value: T }
    | { kind: 'unavailable' }
    | { kind: 'ambiguous' }
    | { kind: 'misconfigured' }
    | { kind: 'aborted' };

/**
 * `read` and `idempotent` retry an ambiguous failure too; `write` stops at it (the caller marks the operation
 * unknown); `once` makes a single try and maps any failure to unavailable.
 */
export type Mode = 'read' | 'idempotent' | 'write' | 'once';

/** Never starts `promise`; only bounds how long the caller waits, and keeps a late rejection from surfacing. */
export function race<T>(promise: Promise<T>, ms: number): Promise<T> {
    promise.catch(() => {});
    if (ms <= 0) {
        return Promise.reject(new DeadlineError());
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineError()), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Sleeps up to `ms` or the end of the call; false when the signal aborted. */
function sleep(call: Call, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
        if (call.signal?.aborted) {
            resolve(false);
            return;
        }
        const done = (value: boolean) => {
            clearTimeout(timer);
            call.signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const onAbort = () => done(false);
        const timer = setTimeout(() => done(true), Math.max(0, Math.min(ms, remaining(call))));
        call.signal?.addEventListener('abort', onAbort, { once: true });
    });
}

const BACKOFF_BASE_MS = 25;
const BACKOFF_CAP_MS = 250;

/** What to do after a failed try: stop with a result, or retry after the backoff. */
function afterFailure(error: unknown, mode: Mode): 'retry' | 'unavailable' | 'ambiguous' | 'misconfigured' {
    const verdict = classify(error);
    if (verdict === 'rethrow') {
        throw error;
    }
    if (verdict === 'misconfigured') {
        return 'misconfigured';
    }
    if (mode === 'once' || verdict === 'definitive' || error instanceof DeadlineError) {
        return verdict === 'ambiguous' && mode === 'write' ? 'ambiguous' : 'unavailable';
    }
    return verdict === 'ambiguous' && mode === 'write' ? 'ambiguous' : 'retry';
}

export async function attempt<T>(call: Call, run: (budgetMs: number) => Promise<T>, mode: Mode): Promise<Attempt<T>> {
    for (let tries = 0; ; tries += 1) {
        const left = remaining(call);
        if (left <= 0) {
            return { kind: 'unavailable' };
        }
        try {
            return { kind: 'ok', value: await race(run(left), left) };
        } catch (error) {
            const next = afterFailure(error, mode);
            if (next !== 'retry') {
                return { kind: next };
            }
            if (!(await sleep(call, Math.min(BACKOFF_BASE_MS * 2 ** tries, BACKOFF_CAP_MS)))) {
                return { kind: 'aborted' };
            }
        }
    }
}

/** Waits for the schema; false when it is not there within the call or its promise rejected. */
export async function whenReady(ready: Promise<unknown> | undefined, call: Call): Promise<boolean> {
    if (!ready) {
        return true;
    }
    try {
        await race(ready, remaining(call));
        return true;
    } catch {
        return false;
    }
}
