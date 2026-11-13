import { CONTENT_TYPE_HEADER } from '@factory-ai/core';
import type { GcsTokenProvider } from './gcs-credentials.js';
import { LIST_LIMIT, type ObjectStore, type PutResult } from './object-store.js';

export interface GcsOptions {
    bucket: string;
    /** Empty: Google-managed encryption. Set: the full Cloud KMS key resource name. */
    kmsKey: string;
    token: GcsTokenProvider;
    /** Tests only: the API origin. */
    endpoint?: string;
    fetch?: typeof fetch;
}

const DEFAULT_ENDPOINT = 'https://storage.googleapis.com';
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_PRECONDITION_FAILED = 412;
const ERROR_DETAIL_CHARS = 300;

export class GcsError extends Error {
    constructor(
        readonly operation: string,
        readonly status: number,
        detail: string
    ) {
        super(`GCS ${operation} answered ${status}${detail ? `: ${detail}` : ''}`);
    }
}

/**
 * The names of a complete `objects.list` page, or null for anything else: an object of kind `storage#objects` whose
 * `items`, when present, are all named. A next page with no item cannot show the prefix empty. Null is never empty.
 */
function namesOfListing(body: unknown): string[] | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const { kind, items, nextPageToken } = body as { kind?: unknown; items?: unknown; nextPageToken?: unknown };
    if (kind !== 'storage#objects' || (items !== undefined && !Array.isArray(items))) return null;
    const names = ((items ?? []) as unknown[]).map((item) =>
        typeof item === 'object' && item !== null ? (item as { name?: unknown }).name : undefined
    );
    if (names.some((name) => typeof name !== 'string')) return null;
    if (nextPageToken !== undefined && names.length === 0) return null;
    return names as string[];
}

/**
 * A minimal Cloud Storage JSON API client: the four object calls the artifact index needs and a prefix
 * list for an org's purge, nothing else. It never creates or inspects the bucket (Terraform owns it; `roles/storage.objectUser` has
 * no bucket rights). Credentials are the caller's `GcsTokenProvider`; a 401 refetches the token
 * once and retries once, under the same abort signal.
 */
export function createGcsStore(options: GcsOptions): ObjectStore {
    const { bucket, kmsKey } = options;
    const doFetch = options.fetch ?? fetch;
    const origin = options.endpoint ?? DEFAULT_ENDPOINT;
    const objectsUrl = `${origin}/storage/v1/b/${encodeURIComponent(bucket)}/o`;
    const objectUrl = (key: string) => `${objectsUrl}/${encodeURIComponent(key)}`;

    async function send(
        method: string,
        url: string,
        { body, signal }: { body?: Uint8Array; signal?: AbortSignal | undefined } = {}
    ): Promise<Response> {
        let response: Response | undefined;
        for (const fresh of [false, true]) {
            signal?.throwIfAborted();
            const headers: Record<string, string> = { authorization: `Bearer ${await options.token({ fresh })}` };
            if (body) headers[CONTENT_TYPE_HEADER] = 'application/octet-stream';
            const init: RequestInit = { method, headers };
            if (signal) init.signal = signal;
            if (body) init.body = body as NonNullable<RequestInit['body']>;
            response = await doFetch(url, init);
            if (response.status !== HTTP_UNAUTHORIZED || fresh) break;
            await response.arrayBuffer();
        }
        return response as Response;
    }

    async function fail(operation: string, response: Response): Promise<never> {
        throw new GcsError(operation, response.status, (await response.text()).slice(0, ERROR_DETAIL_CHARS));
    }

    return {
        async put(key, body, call): Promise<PutResult> {
            const query = new URLSearchParams({ uploadType: 'media', name: key, ifGenerationMatch: '0' });
            if (kmsKey) query.set('kmsKeyName', kmsKey);
            const response = await send(
                'POST',
                `${origin}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`,
                {
                    body,
                    signal: call?.signal,
                }
            );
            if (response.status === HTTP_PRECONDITION_FAILED) {
                await response.arrayBuffer();
                return 'exists';
            }
            if (response.status !== HTTP_OK) return fail('PUT', response);
            await response.arrayBuffer();
            return 'created';
        },
        async get(key) {
            const response = await send('GET', `${objectUrl(key)}?alt=media`);
            if (response.status === HTTP_NOT_FOUND) {
                await response.arrayBuffer();
                return null;
            }
            if (response.status !== HTTP_OK) return fail('GET', response);
            return new Uint8Array(await response.arrayBuffer());
        },
        async head(key, call) {
            const response = await send('GET', `${objectUrl(key)}?fields=size`, { signal: call?.signal });
            if (response.status === HTTP_NOT_FOUND) {
                await response.arrayBuffer();
                return null;
            }
            if (response.status !== HTTP_OK) return fail('HEAD', response);
            return { size: Number(((await response.json()) as { size: string }).size) };
        },
        async delete(key) {
            const response = await send('DELETE', objectUrl(key));
            if (response.ok || response.status === HTTP_NOT_FOUND) {
                await response.arrayBuffer();
                return;
            }
            return fail('DELETE', response);
        },
        async list(prefix, call) {
            const query = new URLSearchParams({
                prefix,
                maxResults: String(call?.limit ?? LIST_LIMIT),
                fields: 'kind,nextPageToken,items(name)',
            });
            const response = await send('GET', `${objectsUrl}?${query}`, { signal: call?.signal });
            if (response.status !== HTTP_OK) return fail('LIST', response);
            const names = namesOfListing(await response.json().catch(() => undefined));
            if (!names) throw new GcsError('LIST', response.status, 'not a complete listing');
            return names;
        },
    };
}
