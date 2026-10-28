import { type FaultVerdict, ProviderFault } from './secret-payloads.js';

/**
 * The one HTTP exchange every external secret provider uses (docs/secrets.md). It bounds the request by the
 * caller's remaining budget and abort signal, reads the body under a byte cap, and turns every transport
 * failure and every status the adapter cannot interpret into a `ProviderFault` whose message carries nothing
 * the provider said. Whether a failure happened before or after the request left decides `retry` against
 * `ambiguous`: a write that may have landed is never retried blind.
 *
 * Every response body is consumed or cancelled exactly once, on every path out.
 */

const DEFAULT_REQUEST_MS = 5000;
const BYTES_PER_KIB = 1024;
const DEFAULT_MAX_BODY_KIB = 256;
const DEFAULT_MAX_BODY_BYTES = DEFAULT_MAX_BODY_KIB * BYTES_PER_KIB;
/**
 * Below this budget a request is not started: the deadline would land mid-flight and turn a request that never
 * left (a refused connection) into an unknown outcome. The caller's loop sleeps out the rest and reports
 * the provider unavailable.
 */
const MIN_DISPATCH_MS = 25;
const HTTP_OK = 200;
const HTTP_REDIRECT = 300;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

/** Errors raised before a request is dispatched: nothing reached the provider. */
const BEFORE_DISPATCH = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
]);

export interface ProviderResponse {
    status: number;
    body: Uint8Array;
}

export interface ProviderHttpOptions {
    fetch?: typeof fetch | undefined;
    /** Longest one request may take, whatever budget the call has left. */
    requestMs?: number | undefined;
    /** Largest body read; a bigger one is cancelled and fails the request. */
    maxBodyBytes?: number | undefined;
}

export interface ProviderHttp {
    /**
     * Sends one request. Resolves for a 2xx answer, and for a 4xx other than 401/403/429, whose body the
     * adapter reads to tell what the provider refused. Rejects with a `ProviderFault` for everything else.
     */
    send(
        url: string | URL,
        init: RequestInit,
        budgetMs: number,
        signal: AbortSignal | undefined
    ): Promise<ProviderResponse>;
}

const causeCode = (error: unknown): unknown => {
    const cause = (error as { cause?: unknown } | null)?.cause ?? error;
    return (cause as { code?: unknown } | null)?.code;
};

async function cancel(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
}

/** The whole body, or a fault; the stream is cancelled when the cap is exceeded or reading fails. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) {
        return new Uint8Array(0);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            total += value.byteLength;
            if (total > cap) {
                await reader.cancel().catch(() => undefined);
                // The request was dispatched and its answer cannot be read: a write may have landed.
                throw new ProviderFault('ambiguous');
            }
            chunks.push(value);
        }
    } catch (error) {
        if (error instanceof ProviderFault) {
            throw error;
        }
        await reader.cancel().catch(() => undefined);
        // The answer started and then the stream broke: the request was dispatched.
        throw new ProviderFault('ambiguous');
    }
    return Buffer.concat(chunks);
}

/** What a status the adapter cannot interpret means, or null when the adapter should read the answer. */
function refusalOf(status: number): FaultVerdict | null {
    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
        return 'misconfigured';
    }
    if (status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR) {
        return 'retry';
    }
    // A status nobody documents for these providers says nothing about whether a write landed.
    return status < HTTP_OK || (status >= HTTP_REDIRECT && status < HTTP_BAD_REQUEST) ? 'ambiguous' : null;
}

/** The fault for a request that threw: ours or the caller's abort was in flight, or the transport failed. */
function transportFault(error: unknown, aborted: boolean): ProviderFault {
    if (aborted) {
        return new ProviderFault('ambiguous');
    }
    const code = causeCode(error);
    return new ProviderFault(typeof code === 'string' && BEFORE_DISPATCH.has(code) ? 'retry' : 'ambiguous');
}

async function dispatch(doFetch: typeof fetch, url: string | URL, init: RequestInit & { signal: AbortSignal }) {
    try {
        return await doFetch(url, init);
    } catch (error) {
        throw transportFault(error, init.signal.aborted);
    }
}

export function createProviderHttp(options: ProviderHttpOptions = {}): ProviderHttp {
    const doFetch = options.fetch ?? fetch;
    const requestMs = options.requestMs ?? DEFAULT_REQUEST_MS;
    const cap = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    return {
        async send(url, init, budgetMs, signal) {
            if (signal?.aborted || budgetMs < MIN_DISPATCH_MS) {
                throw new ProviderFault('retry');
            }
            const bound = AbortSignal.timeout(Math.min(requestMs, budgetMs));
            const combined = signal ? AbortSignal.any([signal, bound]) : bound;
            const response = await dispatch(doFetch, url, { ...init, signal: combined });
            const refusal = refusalOf(response.status);
            if (refusal) {
                await cancel(response);
                throw new ProviderFault(refusal);
            }
            return { status: response.status, body: await readCapped(response, cap) };
        },
    };
}
