import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE } from '../http.js';
import type {
    IntegrationDefinition,
    IntegrationOperation,
    IntegrationResource,
    OperationRequest,
    Pagination,
} from './definition.js';
import type { IntegrationOutcome, UnavailableReason } from './outcomes.js';

/** What a call is allowed to know about its connection: no secret reference, no stored credential. */
export interface ConnectionHandle {
    connectionId: string;
    provider: string;
    resource: IntegrationResource;
    authority: { scopes: readonly string[] };
}

/** The only credential the portable layer ever sees: a short-lived access token and what it may do. */
export interface Credential {
    accessToken: string;
    /** Epoch milliseconds, or null when the token does not expire. */
    expiresAt: number | null;
    authority: { scopes: readonly string[] };
}

export type CredentialResult = { ok: true; credential: Credential } | { ok: false; outcome: IntegrationOutcome };

export interface CredentialSource {
    acquire(signal: AbortSignal): Promise<CredentialResult>;
}

/** The slice of `fetch` the runner uses; core has no DOM lib, so the types are local. */
export interface BodyReader {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
}

export interface FetchResponseLike {
    status: number;
    headers: { get(name: string): string | null };
    body: { getReader(): BodyReader } | null;
}

export interface FetchInit {
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect: 'manual';
    signal: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export interface OperationContext {
    handle: ConnectionHandle;
    credentials: CredentialSource;
    fetch: FetchLike;
    signal?: AbortSignal;
    /** One deadline for credential acquisition and every page. */
    deadlineMs: number;
    maxBodyBytes?: number;
}

export type OperationResult<R = unknown> = { ok: true; value: R } | { ok: false; outcome: IntegrationOutcome };

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const MS_PER_SECOND = 1000;
const STATUS = {
    ok: 200,
    redirect: 300,
    badRequest: 400,
    unauthorized: 401,
    forbidden: 403,
    tooMany: 429,
    server: 500,
} as const;

type Fail = { ok: false; outcome: IntegrationOutcome };
const refuse = (outcome: IntegrationOutcome): Fail => ({ ok: false, outcome });
const unavailable = (reason: UnavailableReason): Fail => refuse({ outcome: 'unavailable', reason, retryable: true });

/** The destination check: the request goes to the definition's origin under its prefix, or nowhere. */
const destination = (def: IntegrationDefinition, handle: ConnectionHandle, path: string): URL | null => {
    try {
        if (!/^\/(?!\/)/.test(path) || path.includes('\\')) return null;
        for (const segment of (path.split('?')[0] ?? '').split('/')) {
            const decoded = decodeURIComponent(segment);
            if (decoded === '.' || decoded === '..') return null;
        }
        const base = new URL(def.api.origin(handle.resource));
        if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
        const url = new URL(path, base);
        const prefix = def.api.pathPrefix.replace(/\/$/, '');
        const inside = url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
        return url.origin === base.origin && inside ? url : null;
    } catch {
        return null;
    }
};

const missingFrom = (required: readonly string[], have: readonly string[]): string[] =>
    required.filter((scope) => !have.includes(scope));

const retryAfterMs = (value: string | null): number | undefined =>
    value !== null && /^\d+$/.test(value.trim()) ? Number(value.trim()) * MS_PER_SECOND : undefined;

class BodyTooLarge extends Error {}

/** Reads at most `cap` bytes; settles on end, error and abort, and cancels the stream when it gives up. */
const readBody = async (res: FetchResponseLike, cap: number, aborted: Promise<never>): Promise<string> => {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const next = await Promise.race([reader.read(), aborted]);
            if (next.done) break;
            if (!next.value) continue;
            total += next.value.byteLength;
            if (total > cap) throw new BodyTooLarge();
            chunks.push(next.value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.byteLength;
    }
    return new TextDecoder().decode(all);
};

const parseJson = (text: string): unknown => (text.trim() === '' ? null : JSON.parse(text));

/** Everything one `runOperation` call shares between its steps. */
interface Run {
    def: IntegrationDefinition;
    op: IntegrationOperation<never>;
    ctx: OperationContext;
    signal: AbortSignal;
    deadline: AbortSignal;
    aborted: Promise<never>;
    cap: number;
}

const stopReason = (run: Run): UnavailableReason =>
    run.deadline.aborted ? 'timeout' : run.signal.aborted ? 'aborted' : 'transport';

// After dispatch a write may have happened: the honest answer is "unknown", not "unavailable".
const afterDispatch = (run: Run, reason: UnavailableReason): Fail =>
    run.op.effect === 'write' ? refuse({ outcome: 'outcome_unknown', operation: run.op.name }) : unavailable(reason);

const acquire = async (run: Run): Promise<Credential | Fail> => {
    try {
        const got = await Promise.race([run.ctx.credentials.acquire(run.signal), run.aborted]);
        return got.ok ? got.credential : refuse(got.outcome);
    } catch {
        return unavailable(run.signal.aborted ? stopReason(run) : 'secret-unavailable');
    }
};

const dropBody = async (res: FetchResponseLike): Promise<void> => {
    await res.body
        ?.getReader()
        .cancel()
        .catch(() => undefined);
};

const forbidden = async (run: Run, res: FetchResponseLike, credential: Credential): Promise<Fail> => {
    let json: unknown = null;
    try {
        json = parseJson(await readBody(res, run.cap, run.aborted));
    } catch {
        json = null;
    }
    const lacking = missingFrom(run.op.requiredScopes, credential.authority.scopes);
    if (run.def.isScopeError?.(res.status, json) === true && lacking.length > 0) {
        return refuse({
            outcome: 'integration_required',
            reason: 'insufficient_scopes',
            provider: run.def.id,
            missingScopes: lacking,
        });
    }
    return refuse({ outcome: 'forbidden', reason: 'provider-denied' });
};

/** A non-2xx answer as its closed outcome; null for a 2xx. */
const refusalFor = async (run: Run, res: FetchResponseLike, credential: Credential): Promise<Fail | null> => {
    const { status } = res;
    if (status >= STATUS.ok && status < STATUS.redirect) return null;
    if (status === STATUS.forbidden) return forbidden(run, res, credential);
    await dropBody(res);
    if (status === STATUS.tooMany) {
        const wait = retryAfterMs(res.headers.get('retry-after'));
        return refuse(
            wait === undefined ? { outcome: 'rate_limited' } : { outcome: 'rate_limited', retryAfterMs: wait }
        );
    }
    if (status === STATUS.unauthorized) return unavailable('credential-rejected');
    if (status >= STATUS.server) return afterDispatch(run, 'upstream-error');
    return unavailable(
        status < STATUS.badRequest && status >= STATUS.redirect ? 'redirect-refused' : 'unexpected-status'
    );
};

const readJson = async (run: Run, res: FetchResponseLike): Promise<{ json: unknown } | Fail> => {
    try {
        return { json: parseJson(await readBody(res, run.cap, run.aborted)) };
    } catch (error) {
        if (error instanceof BodyTooLarge) return afterDispatch(run, 'response-too-large');
        if (error instanceof SyntaxError) return afterDispatch(run, 'malformed-response');
        return afterDispatch(run, stopReason(run));
    }
};

const initFor = (run: Run, credential: Credential, request: OperationRequest): FetchInit => {
    const headers: Record<string, string> = {
        authorization: `Bearer ${credential.accessToken}`,
        accept: JSON_CONTENT_TYPE,
    };
    const init: FetchInit = { method: request.method, headers, redirect: 'manual', signal: run.signal };
    if (request.body !== undefined) {
        headers[CONTENT_TYPE_HEADER] = JSON_CONTENT_TYPE;
        init.body = JSON.stringify(request.body);
    }
    return init;
};

/** One request: the checked destination, the dispatch, and the answer as JSON or a closed outcome. */
const fetchPage = async (
    run: Run,
    credential: Credential,
    request: OperationRequest
): Promise<{ json: unknown } | Fail> => {
    const url = destination(run.def, run.ctx.handle, request.path);
    if (!url) return refuse({ outcome: 'forbidden', reason: 'destination-refused' });
    let res: FetchResponseLike;
    try {
        res = await Promise.race([run.ctx.fetch(url.toString(), initFor(run, credential, request)), run.aborted]);
    } catch {
        return afterDispatch(run, stopReason(run));
    }
    return (await refusalFor(run, res, credential)) ?? readJson(run, res);
};

/** Fold one page into the collected items; the next page's path, or null when collection is done. */
const collect = (pagination: Pagination, collected: unknown[], json: unknown, page: number): string | null => {
    collected.push(...pagination.items(json).slice(0, pagination.maxItems - collected.length));
    return collected.length >= pagination.maxItems || page >= pagination.maxPages ? null : pagination.next(json);
};

const execute = async <R>(run: Run, credential: Credential, input: never): Promise<OperationResult<R>> => {
    const request = run.op.request(input);
    const pagination = run.op.paginate;
    const collected: unknown[] = [];
    let path: string | null = request.path;
    for (let page = 1; path !== null; page += 1) {
        // A body rides the first request only; later pages are plain reads of the provider's next link.
        const got = await fetchPage(run, credential, page === 1 ? request : { method: request.method, path });
        if ('ok' in got) return got;
        if (!pagination) return { ok: true, value: got.json as R };
        try {
            path = collect(pagination, collected, got.json, page);
        } catch {
            return afterDispatch(run, 'malformed-response');
        }
    }
    return { ok: true, value: collected as R };
};

/**
 * Run one operation against the provider: credential once, destination checked on every page, no
 * redirect followed, bounded body and pages, one deadline. Whatever goes wrong is a closed outcome;
 * no provider text and no token ever reaches the result.
 */
export const runOperation = async <I, R = unknown>(
    def: IntegrationDefinition,
    op: IntegrationOperation<I>,
    ctx: OperationContext,
    input: I
): Promise<OperationResult<R>> => {
    const missing = missingFrom(op.requiredScopes, ctx.handle.authority.scopes);
    if (missing.length > 0) {
        return refuse({
            outcome: 'integration_required',
            reason: 'insufficient_scopes',
            provider: def.id,
            missingScopes: missing,
        });
    }
    const deadline = AbortSignal.timeout(ctx.deadlineMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('aborted'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => undefined);
    const run: Run = {
        def,
        op: op as IntegrationOperation<never>,
        ctx,
        signal,
        deadline,
        aborted,
        cap: ctx.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    };
    try {
        const credential = await acquire(run);
        return 'accessToken' in credential ? await execute<R>(run, credential, input as never) : credential;
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
};
