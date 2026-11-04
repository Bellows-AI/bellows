import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE } from '@factory-ai/core';
import { isLoopbackAddress, isSpecialUseAddress } from './special-use-address.js';

/**
 * The outbound fetch of a Client ID Metadata Document (docs/security.md). The client id is a URL the caller chose, so
 * the fetch is the board's one request to an address a stranger names: https only (http only for a loopback host under
 * the dev policy), every resolved address checked, the connection pinned to the address that was checked, no redirect,
 * a size cap, one deadline from lookup to last byte, a concurrency cap and a per-host token bucket.
 */
export type CimdFetchFailure =
    | 'policy'
    | 'address'
    | 'redirect'
    | 'status'
    | 'malformed'
    | 'too_large'
    | 'timeout'
    | 'aborted'
    | 'network'
    | 'busy'
    | 'rate_limited';

export class CimdFetchError extends Error {
    constructor(
        readonly code: CimdFetchFailure,
        message: string
    ) {
        super(message);
        this.name = 'CimdFetchError';
    }
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const DOT_SEGMENT = /\/\.\.?(\/|$|\?)/;

/** The URL of a client id, or a policy refusal. The id must be a canonical URL: https, a path, no userinfo or fragment. */
const parseClientIdUrl = (raw: string, allowLoopback: boolean): URL => {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new CimdFetchError('policy', 'The client id is not a URL.');
    }
    const insecureOk = allowLoopback && url.protocol === 'http:' && LOOPBACK_NAMES.has(url.hostname);
    if (url.protocol !== 'https:' && !insecureOk) throw new CimdFetchError('policy', 'The client id must be https.');
    if (url.username || url.password || url.hash || raw.includes('#')) {
        throw new CimdFetchError('policy', 'The client id carries userinfo or a fragment.');
    }
    if (url.pathname === '/' || DOT_SEGMENT.test(raw.slice(raw.indexOf('//') + 2))) {
        throw new CimdFetchError('policy', 'The client id needs a path without dot segments.');
    }
    return url;
};

export interface CimdFetcherOptions {
    /** The dev policy: `http` loopback client ids and loopback addresses are allowed (the board itself is on loopback). */
    allowLoopback: boolean;
    /** Every address of a name. Defaults to the system resolver; a test fakes it. */
    resolve?: ((hostname: string) => Promise<string[]>) | undefined;
    maxBytes?: number;
    timeoutMs?: number;
    maxConcurrent?: number;
    perHost?: { burst: number; perSecond: number };
    now?: () => number;
}

export type CimdFetcher = (clientIdUrl: string, signal?: AbortSignal) => Promise<unknown>;

const DEFAULT_MAX_BYTES = 16_384;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_PER_HOST = { burst: 5, perSecond: 0.1 };
const MS = 1000;
const BUCKET_PRUNE_AT = 1000;
const REDIRECT_FLOOR = 300;
const REDIRECT_CEILING = 400;
const HTTP_OK = 200;

const systemResolve = async (hostname: string): Promise<string[]> =>
    (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const bareHost = (url: URL): string => (url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname);

/** The address to connect to: a literal as given, or the first answer of a lookup whose every answer is allowed. */
const pinnedAddress = async (
    url: URL,
    resolve: (hostname: string) => Promise<string[]>,
    allowLoopback: boolean
): Promise<string> => {
    const host = bareHost(url);
    let answers: string[] = [host];
    if (!isIP(host)) {
        try {
            answers = await resolve(host);
        } catch (e) {
            throw new CimdFetchError('network', `Lookup failed: ${(e as Error).message}`);
        }
    }
    const refused = (address: string) => isSpecialUseAddress(address) && !(allowLoopback && isLoopbackAddress(address));
    const [first] = answers;
    if (first === undefined || answers.some(refused)) {
        throw new CimdFetchError('address', 'The client id resolves to an address that is not allowed.');
    }
    return first;
};

type Finish = (error?: Error, value?: unknown) => void;

/** The status and headers of the answer, as a refusal or null when the body may be read. */
const refuseResponse = (response: IncomingMessage, maxBytes: number): CimdFetchError | null => {
    const status = response.statusCode ?? 0;
    if (status >= REDIRECT_FLOOR && status < REDIRECT_CEILING) {
        return new CimdFetchError('redirect', 'The client metadata URL redirects.');
    }
    if (status !== HTTP_OK) return new CimdFetchError('status', `The client metadata URL answered ${status}.`);
    if (!String(response.headers[CONTENT_TYPE_HEADER] ?? '').includes('json')) {
        return new CimdFetchError('malformed', 'The client metadata is not JSON.');
    }
    if (Number(response.headers['content-length'] ?? 0) > maxBytes) {
        return new CimdFetchError('too_large', 'The client metadata is too large.');
    }
    return null;
};

const parseObject = (chunks: Buffer[]): Record<string, unknown> => {
    try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Falls through to the same refusal.
    }
    throw new CimdFetchError('malformed', 'The client metadata is not a JSON object.');
};

/** Every way the body stream can end settles `finish` exactly once: end, error, premature close, the size cap. */
const readBody = (response: IncomingMessage, maxBytes: number, finish: Finish): void => {
    const refusal = refuseResponse(response, maxBytes);
    if (refusal) {
        response.destroy();
        finish(refusal);
        return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
            finish(new CimdFetchError('too_large', 'The client metadata is too large.'));
            return response.destroy();
        }
        chunks.push(chunk);
    });
    response.on('end', () => {
        try {
            finish(undefined, parseObject(chunks));
        } catch (e) {
            finish(e as Error);
        }
    });
    response.on('error', (e) => finish(new CimdFetchError('network', e.message)));
    response.on('close', () => finish(new CimdFetchError('network', 'The connection closed before the end.')));
};

/** Resolves the address a request may use, in place of the system lookup the socket would otherwise do. */
const lookupOf =
    (address: string): LookupFunction =>
    (_host, lookupOptions, callback) => {
        const entry = { address, family: isIP(address) };
        if ((lookupOptions as { all?: boolean }).all) {
            (callback as unknown as (e: null, all: (typeof entry)[]) => void)(null, [entry]);
        } else callback(null, address, entry.family);
    };

const openRequest = (url: URL, address: string, onResponse: (response: IncomingMessage) => void): ClientRequest => {
    const secure = url.protocol === 'https:';
    const host = bareHost(url);
    const outgoing = (secure ? httpsRequest : httpRequest)({
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { accept: JSON_CONTENT_TYPE, host: url.host },
        lookup: lookupOf(address),
        agent: false,
        ...(secure && !isIP(host) ? { servername: host } : {}),
    });
    outgoing.on('response', onResponse);
    return outgoing;
};

interface Fetching {
    resolve: (hostname: string) => Promise<string[]>;
    allowLoopback: boolean;
    maxBytes: number;
    timeoutMs: number;
}

/** One deadline from lookup to last byte; the caller's signal cancels it. */
const fetchDocument = (url: URL, signal: AbortSignal | undefined, ctx: Fetching): Promise<unknown> =>
    new Promise((resolvePromise, rejectPromise) => {
        let done = false;
        let outgoing: ClientRequest | undefined;
        const finish: Finish = (error, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (!error) return resolvePromise(value);
            outgoing?.destroy();
            rejectPromise(error);
        };
        const onAbort = () => finish(new CimdFetchError('aborted', 'The fetch was cancelled.'));
        const timer = setTimeout(() => finish(new CimdFetchError('timeout', 'The fetch timed out.')), ctx.timeoutMs);
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });

        const connect = (address: string) => {
            if (done) return;
            outgoing = openRequest(url, address, (response) => readBody(response, ctx.maxBytes, finish));
            outgoing.on('error', (e) => finish(new CimdFetchError('network', e.message)));
            outgoing.end();
        };
        pinnedAddress(url, ctx.resolve, ctx.allowLoopback).then(connect, (e: Error) =>
            finish(e instanceof CimdFetchError ? e : new CimdFetchError('network', e.message))
        );
    });

/** A concurrency cap and a per-host token bucket; `admit` throws when full, and answers the slot's release. */
const createAdmission = ({
    maxConcurrent,
    perHost,
    now,
}: {
    maxConcurrent: number;
    perHost: { burst: number; perSecond: number };
    now: () => number;
}) => {
    const buckets = new Map<string, { tokens: number; at: number }>();
    let active = 0;
    const refilled = (bucket: { tokens: number; at: number }, at: number) =>
        Math.min(perHost.burst, bucket.tokens + ((at - bucket.at) / MS) * perHost.perSecond);

    /** Whether the host has a token; the bucket is written either way so the refill clock moves. */
    const takeToken = (host: string): boolean => {
        const at = now();
        if (buckets.size > BUCKET_PRUNE_AT) {
            for (const [key, bucket] of buckets) if (refilled(bucket, at) >= perHost.burst) buckets.delete(key);
        }
        const tokens = refilled(buckets.get(host) ?? { tokens: perHost.burst, at }, at);
        const spend = tokens >= 1 ? 1 : 0;
        buckets.set(host, { tokens: tokens - spend, at });
        return spend === 1;
    };

    return (host: string): (() => void) => {
        if (active >= maxConcurrent) throw new CimdFetchError('busy', 'Too many client metadata fetches in flight.');
        if (!takeToken(host)) throw new CimdFetchError('rate_limited', 'Too many fetches for this host.');
        active += 1;
        return () => {
            active -= 1;
        };
    };
};

export const createCimdFetcher = (options: CimdFetcherOptions): CimdFetcher => {
    const ctx: Fetching = {
        resolve: options.resolve ?? systemResolve,
        allowLoopback: options.allowLoopback,
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    const admit = createAdmission({
        maxConcurrent: options.maxConcurrent ?? DEFAULT_CONCURRENCY,
        perHost: options.perHost ?? DEFAULT_PER_HOST,
        now: options.now ?? Date.now,
    });
    return async (clientIdUrl, signal) => {
        const url = parseClientIdUrl(clientIdUrl, ctx.allowLoopback);
        const release = admit(url.hostname);
        try {
            return await fetchDocument(url, signal, ctx);
        } finally {
            release();
        }
    };
};
