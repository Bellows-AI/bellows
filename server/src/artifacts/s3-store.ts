import { CONTENT_TYPE_HEADER } from '@factory-ai/core';
import { LIST_LIMIT, type ObjectStore, type PutResult } from './object-store.js';
import type { CredentialProvider } from './s3-credentials.js';
import { sha256Hex, signRequest } from './sigv4.js';

export interface S3Options {
    bucket: string;
    region: string;
    /** Empty: AWS itself. Set for an S3-compatible store (RustFS in compose). */
    endpoint: string;
    forcePathStyle: boolean;
    /** Empty: SSE-S3. Set: SSE-KMS with this key. */
    kmsKeyId: string;
    credentials: CredentialProvider;
    fetch?: typeof fetch;
    now?: () => Date;
}

export interface S3Store extends ObjectStore {
    /** Creates the bucket when it does not exist; the dev stores start empty. */
    ensureBucket(): Promise<'exists' | 'created'>;
}

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_PRECONDITION_FAILED = 412;
const ERROR_DETAIL_CHARS = 300;
const US_EAST_1 = 'us-east-1';
const EMPTY_PAYLOAD_HASH = sha256Hex('');

export class S3Error extends Error {
    constructor(
        readonly operation: string,
        readonly status: number,
        detail: string
    ) {
        super(`S3 ${operation} answered ${status}${detail ? `: ${detail}` : ''}`);
    }
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (text: string): string =>
    text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name] ?? '');

const LISTING = /^\s*(?:<\?xml[^>]*\?>\s*)?<ListBucketResult(?:\s[^>]*)?>([\s\S]*)<\/ListBucketResult>\s*$/;

/**
 * Occurrences of a raw tag token: `<Name` followed by anything that ends the name, so `<Contents/>`, `<Contents >` and
 * `<Contents x="1">` all count, while `<KeyCount` is not a `<Key`.
 */
const occurrences = (text: string, token: string): number =>
    (text.match(new RegExp(`${token}(?![\\w.:-])`, 'g')) ?? []).length;

/**
 * The keys of a complete ListObjectsV2 page, or null for anything else. Fail closed, not a parser: the whole document
 * must be there; `KeyCount` and `IsTruncated` each appear once, strictly formed; and every raw `<Contents` opener,
 * every `</Contents>` closer, every raw `<Key` and every strictly formed `<Contents><Key>k</Key>…</Contents>` entry
 * with a non-empty key all number exactly `KeyCount`. A grouped prefix (never asked for) or a truncated page with no
 * key is doubt too. Null is never an empty answer.
 */
function keysOfListing(body: string): string[] | null {
    const inner = LISTING.exec(body)?.[1];
    if (inner === undefined) return null;
    const count = /^[\s\S]*?<KeyCount>(\d+)<\/KeyCount>/.exec(inner)?.[1];
    const truncated = /<IsTruncated>(true|false)<\/IsTruncated>/.exec(inner)?.[1];
    if (count === undefined || truncated === undefined) return null;
    if (occurrences(inner, '<KeyCount') !== 1 || occurrences(inner, '<IsTruncated') !== 1) return null;
    if (occurrences(inner, '<CommonPrefixes') !== 0) return null;
    const expected = Number(count);
    const entries = [...inner.matchAll(/<Contents><Key>([^<]+)<\/Key>(?:(?!<Contents|<Key)[\s\S])*?<\/Contents>/g)];
    const tallies = [
        occurrences(inner, '<Contents'),
        occurrences(inner, '</Contents>'),
        occurrences(inner, '<Key'),
        entries.length,
    ];
    if (tallies.some((tally) => tally !== expected)) return null;
    if (truncated === 'true' && expected === 0) return null;
    return entries.map((match) => unescapeXml(match[1] ?? ''));
}

/**
 * A minimal S3 client: the four object calls the artifact index needs, a prefix list for an org's purge, plus the
 * bucket bootstrap. No SDK — the keys are ASCII ids and integers, and the request is signed by
 * `sigv4.ts` over a handful of headers.
 */
export function createS3Store(options: S3Options): S3Store {
    const { bucket, region, endpoint, forcePathStyle, kmsKeyId } = options;
    const doFetch = options.fetch ?? fetch;
    const now = options.now ?? (() => new Date());

    // SSE-S3 by default, KMS when a key is set. An S3-compatible endpoint gets no SSE-S3 header: RustFS
    // refuses it without a master key of its own, and it is a dev store, not where data is kept.
    const encryption: Record<string, string> = kmsKeyId
        ? { 'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': kmsKeyId }
        : endpoint
          ? {}
          : { 'x-amz-server-side-encryption': 'AES256' };

    function urlOf(key: string): URL {
        const awsHost = `s3.${region}.amazonaws.com`;
        if (endpoint) {
            const base = new URL(endpoint);
            if (forcePathStyle) return new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}/${bucket}/${key}`);
            return new URL(`${base.protocol}//${bucket}.${base.host}/${key}`);
        }
        return forcePathStyle
            ? new URL(`https://${awsHost}/${bucket}/${key}`)
            : new URL(`https://${bucket}.${awsHost}/${key}`);
    }

    async function send(
        method: string,
        url: URL,
        {
            headers = {},
            body,
            signal,
        }: { headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal | undefined } = {}
    ): Promise<Response> {
        const signed = signRequest({
            method,
            url,
            headers,
            payloadHash: body ? sha256Hex(body) : EMPTY_PAYLOAD_HASH,
            region,
            service: 's3',
            credentials: await options.credentials(),
            now: now(),
        });
        const init: RequestInit = { method, headers: signed };
        if (signal) init.signal = signal;
        if (body) init.body = body as NonNullable<RequestInit['body']>;
        return doFetch(url, init);
    }

    async function fail(operation: string, response: Response): Promise<never> {
        throw new S3Error(operation, response.status, (await response.text()).slice(0, ERROR_DETAIL_CHARS));
    }

    return {
        async put(key, body, call): Promise<PutResult> {
            const response = await send('PUT', urlOf(key), {
                headers: { 'if-none-match': '*', [CONTENT_TYPE_HEADER]: 'application/octet-stream', ...encryption },
                body,
                signal: call?.signal,
            });
            if (response.status === HTTP_PRECONDITION_FAILED) {
                await response.arrayBuffer();
                return 'exists';
            }
            if (response.status !== HTTP_OK) return fail('PUT', response);
            await response.arrayBuffer();
            return 'created';
        },
        async get(key) {
            const response = await send('GET', urlOf(key));
            if (response.status === HTTP_NOT_FOUND) {
                await response.arrayBuffer();
                return null;
            }
            if (response.status !== HTTP_OK) return fail('GET', response);
            return new Uint8Array(await response.arrayBuffer());
        },
        async head(key, call) {
            const response = await send('HEAD', urlOf(key), { signal: call?.signal });
            if (response.status === HTTP_NOT_FOUND) return null;
            if (response.status !== HTTP_OK) return fail('HEAD', response);
            return { size: Number(response.headers.get('content-length')) };
        },
        async delete(key) {
            const response = await send('DELETE', urlOf(key));
            // S3 answers 204 whether or not the key existed; some compatible stores answer 404.
            if (response.ok || response.status === HTTP_NOT_FOUND) {
                await response.arrayBuffer();
                return;
            }
            return fail('DELETE', response);
        },
        async list(prefix, call) {
            const url = urlOf('');
            url.searchParams.set('list-type', '2');
            url.searchParams.set('prefix', prefix);
            url.searchParams.set('max-keys', String(call?.limit ?? LIST_LIMIT));
            const response = await send('GET', url, { signal: call?.signal });
            if (response.status !== HTTP_OK) return fail('LIST', response);
            const keys = keysOfListing(await response.text());
            if (!keys) throw new S3Error('LIST', response.status, 'not a complete listing');
            return keys;
        },
        async ensureBucket() {
            const head = await send('HEAD', urlOf(''));
            if (head.status === HTTP_OK) return 'exists';
            if (head.status !== HTTP_NOT_FOUND) return fail('HEAD bucket', head);
            const body =
                region === US_EAST_1
                    ? undefined
                    : new TextEncoder().encode(
                          `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`
                      );
            const created = await send('PUT', urlOf(''), body ? { body } : {});
            // Two replicas booting together: the loser's create answers 409 for a bucket that is now there.
            if (created.status === HTTP_CONFLICT) return 'exists';
            if (created.status !== HTTP_OK) return fail('PUT bucket', created);
            await created.arrayBuffer();
            return 'created';
        },
    };
}
