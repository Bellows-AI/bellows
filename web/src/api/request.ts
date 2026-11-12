import { JSON_HEADERS } from '@factory-ai/core';
import { refusalFrom, type RefusalBody } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './unauthenticated.js';

/** What one request came to. It never throws: a failure is an `ok: false` arm with the sentence to show. */
export type RequestResult<T> =
    | { ok: true; status: number; value: T; unauthenticated?: never; aborted?: never }
    | {
          ok: false;
          error: string;
          code?: string;
          /** The refusal's parsed body, for a caller that reads fields beyond `error` and `code`. */
          body?: RefusalBody;
          /** The HTTP status when the board answered; absent for a network failure or an abort. */
          status?: number;
          /** The session is gone: the gate has been told once, so a caller renders nothing for it. */
          unauthenticated?: true;
          /** The caller's own signal fired: the answer is not wanted, leave state alone. */
          aborted?: true;
      };

export interface RequestOptions<T> extends Omit<RequestInit, 'body' | 'headers'> {
    headers?: Record<string, string>;
    /** JSON-encoded unless it is a `Blob`, which goes up raw under the caller's own `headers`. */
    body?: unknown;
    /** The caller's fallback wording for a refusal that named nothing (the status is appended). */
    verb?: string;
    /** Runtime shape check of the success body; a body that fails it is an error, never a cast. */
    guard?: (body: unknown, status: number) => body is T;
    /** The sentence for a success body that is not JSON or fails `guard`; defaults to naming the URL. */
    malformed?: string;
    /** Read the success body as a `Blob` (a download) instead of JSON. */
    blob?: boolean;
    /**
     * A 401 is an ordinary refusal, not news for the gate. Only the gate's own probe (`/api/auth/me`)
     * sets it: its 401 would re-trigger the probe it came from.
     */
    ungated?: boolean;
    /** The success answers no body (a bare 2xx). */
    empty?: boolean;
}

/** A JSON write's body and content type, the type yielding to the caller's own header. */
const jsonBody = (body: unknown, headers: Record<string, string> | undefined) => ({
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
});

const MALFORMED = Symbol('malformed body');
const SESSION_EXPIRED = 'Your session expired';

/** What `fetch` is given: the method, signal and headers as the caller set them, plus the JSON body (a `Blob` goes up raw). */
function sentInit(init: RequestOptions<unknown>): RequestInit {
    const { method, signal, headers, body } = init;
    return {
        ...(method ? { method } : {}),
        ...(signal ? { signal } : {}),
        ...(headers ? { headers } : {}),
        ...(body === undefined ? {} : body instanceof Blob ? { body } : jsonBody(body, headers)),
    };
}

/** A 2xx response's body, or the sentence that says it is not what the caller asked for. */
async function readSuccess<T>(
    response: Response,
    url: string,
    init: Pick<RequestOptions<T>, 'guard' | 'empty' | 'blob' | 'malformed'>
): Promise<RequestResult<T>> {
    const { status } = response;
    if (init.empty) return { ok: true, status, value: undefined as T };
    const parsed: unknown = init.blob ? await response.blob() : await response.json().catch(() => MALFORMED);
    if (parsed === MALFORMED || (init.guard && !init.guard(parsed, status))) {
        return { ok: false, status, error: init.malformed ?? `Unexpected response from ${url}` };
    }
    return { ok: true, status, value: parsed as T };
}

/**
 * The shell under `request`: send (JSON-encoding `body`), hand a 401 to the gate, read a
 * refusal, parse the answer, turn a throw into a message. A success body that is not JSON, or that
 * fails `guard`, is an error rather than a cast `T` that crashes a render later.
 */
async function settle<T>(url: string, init: RequestOptions<T>): Promise<RequestResult<T>> {
    try {
        const sent = sentInit(init);
        // A bare read is a bare `fetch(url)`: nothing to say, nothing sent.
        const response = await (Object.keys(sent).length > 0 ? fetch(url, sent) : fetch(url));
        const { status } = response;
        if (status === HTTP_STATUS_UNAUTHORIZED && !init.ungated) {
            reportUnauthenticated();
            return { ok: false, error: SESSION_EXPIRED, status, unauthenticated: true };
        }
        if (!response.ok) {
            const refused = (await response.json().catch(() => ({}))) as RefusalBody;
            return { ok: false, status, ...refusalFrom(refused, status, init.verb), body: refused };
        }
        return await readSuccess(response, url, init);
    } catch (e) {
        if (init.signal?.aborted) return { ok: false, error: (e as Error).message, aborted: true };
        return { ok: false, error: (e as Error).message };
    }
}

/**
 * The ONE request shell of `web/src/api`: see {@link settle}. An abort that lands while the body is
 * still being read fails the body read, which `settle` reports as a malformed answer; the caller's
 * own signal says it was a cancellation, so a failure under an aborted signal is always `aborted`.
 */
export async function request<T = unknown>(url: string, init: RequestOptions<T> = {}): Promise<RequestResult<T>> {
    const result = await settle(url, init);
    if (!result.ok && init.signal?.aborted) return { ok: false, error: 'The request was cancelled', aborted: true };
    return result;
}
