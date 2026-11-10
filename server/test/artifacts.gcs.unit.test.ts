import { describe, expect, it } from 'vitest';
import { createGcsStore } from '../src/artifacts/gcs-store.js';
import { createGcsTokenProvider } from '../src/artifacts/gcs-credentials.js';
import { CredentialError } from '../src/artifacts/s3-credentials.js';

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MS = 1000;

const missingFile = () => Object.assign(new Error('no such file'), { code: 'ENOENT' });
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('GCS store requests', () => {
    function recorder(status = 200, body = '{"size":"3"}') {
        const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
        const fetchStub = (async (url: URL | string, init: RequestInit) => {
            calls.push({
                url: String(url),
                method: init.method ?? 'GET',
                headers: init.headers as Record<string, string>,
            });
            return new Response(body, { status });
        }) as typeof fetch;
        return { calls, fetchStub };
    }
    const build = (over: Partial<Parameters<typeof createGcsStore>[0]>, fetchStub: typeof fetch) =>
        createGcsStore({ bucket: 'bkt', kmsKey: '', token: async () => 'tok', fetch: fetchStub, ...over });

    it('puts create-only through the upload endpoint with the encoded object name and a bearer token', async () => {
        const { calls, fetchStub } = recorder();
        expect(await build({}, fetchStub).put('factory/a b/k', new Uint8Array([1, 2, 3]))).toBe('created');
        const url = new URL(calls[0]!.url);
        expect(url.origin + url.pathname).toBe('https://storage.googleapis.com/upload/storage/v1/b/bkt/o');
        expect(url.searchParams.get('uploadType')).toBe('media');
        expect(url.searchParams.get('name')).toBe('factory/a b/k');
        expect(url.searchParams.get('ifGenerationMatch')).toBe('0');
        expect(url.searchParams.has('kmsKeyName')).toBe(false);
        expect(calls[0]!.method).toBe('POST');
        expect(calls[0]!.headers.authorization).toBe('Bearer tok');
    });

    it('names the customer-managed key on a write when one is set', async () => {
        const { calls, fetchStub } = recorder();
        await build({ kmsKey: 'projects/p/locations/l/keyRings/r/cryptoKeys/k' }, fetchStub).put(
            'k',
            new Uint8Array([1])
        );
        expect(new URL(calls[0]!.url).searchParams.get('kmsKeyName')).toBe(
            'projects/p/locations/l/keyRings/r/cryptoKeys/k'
        );
    });

    it('reads, sizes and deletes by the percent-encoded object path', async () => {
        const { calls, fetchStub } = recorder();
        const store = build({}, fetchStub);
        await store.get('factory/x/k');
        expect(await store.head('factory/x/k')).toEqual({ size: 3 });
        await store.delete('factory/x/k');
        expect(calls.map((c) => [c.method, c.url])).toEqual([
            ['GET', 'https://storage.googleapis.com/storage/v1/b/bkt/o/factory%2Fx%2Fk?alt=media'],
            ['GET', 'https://storage.googleapis.com/storage/v1/b/bkt/o/factory%2Fx%2Fk?fields=size'],
            ['DELETE', 'https://storage.googleapis.com/storage/v1/b/bkt/o/factory%2Fx%2Fk'],
        ]);
    });

    it('reads a 412 as exists and any other write failure as an error', async () => {
        expect(await build({}, recorder(412).fetchStub).put('k', new Uint8Array([1]))).toBe('exists');
        await expect(build({}, recorder(500).fetchStub).put('k', new Uint8Array([1]))).rejects.toThrow(
            /GCS PUT answered 500/
        );
    });

    it('reads a 404 as absent for get and head, deletes an absent key quietly, and a 403 as an error', async () => {
        const store = build({}, recorder(404).fetchStub);
        expect(await store.get('k')).toBeNull();
        expect(await store.head('k')).toBeNull();
        await expect(store.delete('k')).resolves.toBeUndefined();
        const refused = build({}, recorder(403).fetchStub);
        await expect(refused.get('k')).rejects.toThrow(/GCS GET answered 403/);
        await expect(refused.head('k')).rejects.toThrow(/GCS HEAD answered 403/);
        await expect(refused.delete('k')).rejects.toThrow(/GCS DELETE answered 403/);
    });

    it('refetches the token once after a 401 and retries with it', async () => {
        const seen: string[] = [];
        const fetchStub = (async (_url: URL | string, init: RequestInit) => {
            const auth = (init.headers as Record<string, string>).authorization!;
            seen.push(auth);
            return auth === 'Bearer stale' ? new Response('', { status: 401 }) : new Response('x', { status: 200 });
        }) as typeof fetch;
        const token = async (options?: { fresh?: boolean }) => (options?.fresh ? 'new' : 'stale');
        expect(new TextDecoder().decode((await build({ token }, fetchStub).get('k'))!)).toBe('x');
        expect(seen).toEqual(['Bearer stale', 'Bearer new']);
    });

    it('does not retry a second 401', async () => {
        const fetchStub = (async () => new Response('', { status: 401 })) as typeof fetch;
        await expect(build({}, fetchStub).get('k')).rejects.toThrow(/GCS GET answered 401/);
    });

    it('does not retry a 401 once the caller has aborted', async () => {
        const controller = new AbortController();
        let sent = 0;
        const fetchStub = (async () => {
            sent += 1;
            controller.abort();
            return new Response('', { status: 401 });
        }) as typeof fetch;
        await expect(
            build({}, fetchStub).put('k', new Uint8Array([1]), { signal: controller.signal })
        ).rejects.toThrow();
        expect(sent).toBe(1);
    });

    it('passes the abort signal to a write', async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchStub = (async (_url: URL | string, init: RequestInit) => {
            init.signal?.throwIfAborted();
            return new Response('', { status: 200 });
        }) as typeof fetch;
        await expect(
            build({}, fetchStub).put('k', new Uint8Array([1]), { signal: controller.signal })
        ).rejects.toThrow();
    });
});

describe('GCS credentials (Application Default Credentials)', () => {
    const metadata = (calls: { url: string; init?: RequestInit | undefined }[], expiresIn = 3600) =>
        (async (url: URL | string, init?: RequestInit) => {
            calls.push({ url: String(url), init });
            return json({ access_token: `meta-${calls.length}`, expires_in: expiresIn });
        }) as typeof fetch;

    it('takes the token from the metadata server (GKE Workload Identity) when no file exists', async () => {
        const calls: { url: string; init?: RequestInit | undefined }[] = [];
        const token = createGcsTokenProvider({
            env: {},
            fetch: metadata(calls),
            readFile: async () => {
                throw missingFile();
            },
        });
        expect(await token()).toBe('meta-1');
        expect(calls[0]!.url).toBe(METADATA_TOKEN_URL);
        expect((calls[0]!.init!.headers as Record<string, string>)['metadata-flavor']).toBe('Google');
    });

    it('caches the token until shortly before it expires and refetches on `fresh`', async () => {
        const calls: { url: string; init?: RequestInit | undefined }[] = [];
        let now = 0;
        const token = createGcsTokenProvider({
            env: {},
            fetch: metadata(calls, 3600),
            readFile: async () => {
                throw missingFile();
            },
            now: () => now,
        });
        await token();
        now = 3000 * MS;
        expect(await token()).toBe('meta-1');
        expect(await token({ fresh: true })).toBe('meta-2');
        now = 6400 * MS;
        expect(await token()).toBe('meta-3');
        expect(calls).toHaveLength(3);
    });

    it('shares one fetch between concurrent callers', async () => {
        const calls: { url: string; init?: RequestInit | undefined }[] = [];
        const token = createGcsTokenProvider({
            env: {},
            fetch: metadata(calls),
            readFile: async () => {
                throw missingFile();
            },
        });
        expect(await Promise.all([token(), token(), token()])).toEqual(['meta-1', 'meta-1', 'meta-1']);
        expect(calls).toHaveLength(1);
    });

    const userFile = JSON.stringify({
        type: 'authorized_user',
        client_id: 'cid',
        client_secret: 'csecret',
        refresh_token: 'rtoken',
    });

    it('refreshes the gcloud authorized-user credential from the well-known file', async () => {
        const reads: string[] = [];
        const calls: { url: string; init?: RequestInit | undefined }[] = [];
        const token = createGcsTokenProvider({
            env: { CLOUDSDK_CONFIG: '/cfg' },
            fetch: (async (url: URL | string, init?: RequestInit) => {
                calls.push({ url: String(url), init });
                return json({ access_token: 'user-token', expires_in: 3600 });
            }) as typeof fetch,
            readFile: async (path) => {
                reads.push(path);
                return userFile;
            },
        });
        expect(await token()).toBe('user-token');
        expect(reads).toEqual(['/cfg/application_default_credentials.json']);
        expect(calls[0]!.url).toBe(OAUTH_TOKEN_URL);
        const body = new URLSearchParams(String(calls[0]!.init!.body));
        expect(Object.fromEntries(body)).toEqual({
            grant_type: 'refresh_token',
            client_id: 'cid',
            client_secret: 'csecret',
            refresh_token: 'rtoken',
        });
    });

    it('prefers GOOGLE_APPLICATION_CREDENTIALS over the well-known file', async () => {
        const reads: string[] = [];
        const token = createGcsTokenProvider({
            env: { GOOGLE_APPLICATION_CREDENTIALS: '/creds/user.json', CLOUDSDK_CONFIG: '/cfg' },
            fetch: (async () => json({ access_token: 't', expires_in: 60 })) as typeof fetch,
            readFile: async (path) => {
                reads.push(path);
                return userFile;
            },
        });
        await token();
        expect(reads).toEqual(['/creds/user.json']);
    });

    it('refuses a service-account key file: there is no key-file option', async () => {
        const token = createGcsTokenProvider({
            env: { GOOGLE_APPLICATION_CREDENTIALS: '/creds/key.json' },
            fetch: (async () => {
                throw new Error('must not be called');
            }) as typeof fetch,
            readFile: async () => JSON.stringify({ type: 'service_account', private_key: 'secret' }),
        });
        const error = await token().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CredentialError);
        expect((error as CredentialError).kind).toBe('misconfigured');
        expect((error as Error).message).toMatch(/service_account/);
        expect((error as Error).message).not.toMatch(/secret/);
    });

    it('does not fall through to the metadata server when a named credential file is unreadable', async () => {
        const calls: { url: string; init?: RequestInit | undefined }[] = [];
        const token = createGcsTokenProvider({
            env: { GOOGLE_APPLICATION_CREDENTIALS: '/creds/gone.json' },
            fetch: metadata(calls),
            readFile: async () => {
                throw missingFile();
            },
        });
        const error = await token().catch((e: unknown) => e);
        expect((error as CredentialError).kind).toBe('misconfigured');
        expect(calls).toHaveLength(0);
    });

    it.each([
        [401, 'misconfigured'],
        [503, 'unavailable'],
    ] as const)('reports a %i from the metadata server as %s, without its body', async (status, kind) => {
        const token = createGcsTokenProvider({
            env: {},
            fetch: (async () => new Response('private detail', { status })) as typeof fetch,
            readFile: async () => {
                throw missingFile();
            },
        });
        const error = await token().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CredentialError);
        expect((error as CredentialError).kind).toBe(kind);
        expect((error as Error).message).toContain(String(status));
        expect((error as Error).message).not.toContain('private detail');
    });

    it('reports an unreachable metadata server as unavailable', async () => {
        const token = createGcsTokenProvider({
            env: {},
            fetch: (async () => {
                throw new TypeError('fetch failed');
            }) as typeof fetch,
            readFile: async () => {
                throw missingFile();
            },
        });
        expect(((await token().catch((e: unknown) => e)) as CredentialError).kind).toBe('unavailable');
    });
});
