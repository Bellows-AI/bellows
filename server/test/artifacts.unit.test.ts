import { describe, expect, it } from 'vitest';
import { loadArtifactsConfig, normalizePrefix } from '../src/config-artifacts.js';
import { chunkKey, InvalidKeyError, parseChunkKey, type StreamRef } from '../src/artifacts/keys.js';
import { CredentialError, createCredentialProvider } from '../src/artifacts/s3-credentials.js';
import { createS3Store } from '../src/artifacts/s3-store.js';
import { sha256Hex, signRequest } from '../src/artifacts/sigv4.js';

/** AWS's published example credentials and requests: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html */
const EXAMPLE_KEYS = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const EXAMPLE_TIME = new Date('2013-05-24T00:00:00Z');

describe('SigV4', () => {
    it('signs the published GET Object example', () => {
        const headers = signRequest({
            method: 'GET',
            url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
            headers: { Range: 'bytes=0-9' },
            payloadHash: sha256Hex(''),
            region: 'us-east-1',
            service: 's3',
            credentials: EXAMPLE_KEYS,
            now: EXAMPLE_TIME,
        });
        expect(headers.authorization).toBe(
            'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
                'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
                'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
        );
    });

    it('signs the published PUT Object example, encoding the key and signing extra headers', () => {
        const headers = signRequest({
            method: 'PUT',
            url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
            headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
            payloadHash: sha256Hex('Welcome to Amazon S3.'),
            region: 'us-east-1',
            service: 's3',
            credentials: EXAMPLE_KEYS,
            now: EXAMPLE_TIME,
        });
        expect(headers.authorization).toContain(
            'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'
        );
    });

    it('signs the session token when credentials carry one', () => {
        const headers = signRequest({
            method: 'GET',
            url: new URL('https://b.s3.amazonaws.com/k'),
            payloadHash: sha256Hex(''),
            region: 'us-east-1',
            service: 's3',
            credentials: { ...EXAMPLE_KEYS, sessionToken: 'tok' },
            now: EXAMPLE_TIME,
        });
        expect(headers['x-amz-security-token']).toBe('tok');
        expect(headers.authorization).toContain('x-amz-security-token');
    });

    it('scopes the signature to the service it is asked for, not to s3', () => {
        const sign = (service: string) =>
            signRequest({
                method: 'POST',
                url: new URL('https://secretsmanager.us-east-1.amazonaws.com/'),
                headers: { 'x-amz-target': 'secretsmanager.GetSecretValue' },
                payloadHash: sha256Hex('{}'),
                region: 'us-east-1',
                service,
                credentials: EXAMPLE_KEYS,
                now: EXAMPLE_TIME,
            }).authorization;
        expect(sign('secretsmanager')).toContain('/20130524/us-east-1/secretsmanager/aws4_request,');
        expect(sign('secretsmanager')).not.toBe(sign('s3'));
    });
});

describe('object keys', () => {
    const ref: StreamRef = {
        member: 'm1',
        root: 'r1',
        job: 'j1',
        claimSeq: 3,
        executor: 'claude-code',
        session: 's1',
        stream: 'raw',
    };

    it('lays a chunk out as org/member/root/job/claimSeq/executor/session/stream/offset:012', () => {
        expect(chunkKey('factory/', 'org1', ref, 42)).toBe('factory/org1/m1/r1/j1/3/claude-code/s1/raw/000000000042');
    });

    it('round-trips through parseChunkKey', () => {
        const key = chunkKey('factory/', 'org1', ref, 7);
        expect(parseChunkKey('factory/', key)).toEqual({ orgId: 'org1', ref, offset: 7 });
    });

    it.each([
        ['a path separator', { ...ref, session: 'a/b' }],
        ['a traversal segment', { ...ref, job: '..' }],
        ['an empty segment', { ...ref, stream: '' }],
        ['a space', { ...ref, executor: 'claude code' }],
    ])('refuses %s in a segment', (_name, bad) => {
        expect(() => chunkKey('', 'org1', bad, 0)).toThrow(InvalidKeyError);
    });

    it('refuses an offset a 12-digit key cannot order, and a negative one', () => {
        expect(() => chunkKey('', 'org1', ref, 10 ** 12)).toThrow(InvalidKeyError);
        expect(() => chunkKey('', 'org1', ref, -1)).toThrow(InvalidKeyError);
    });

    it('does not parse a key outside the prefix or of the wrong shape', () => {
        expect(parseChunkKey('factory/', 'other/org1/m1/r1/j1/3/e/s/raw/000000000001')).toBeNull();
        expect(parseChunkKey('factory/', 'factory/org1/m1/r1/j1/3/e/s/raw/1')).toBeNull();
        expect(parseChunkKey('factory/', 'factory/org1/m1/r1/j1')).toBeNull();
    });

    it('normalizes the prefix to empty or one trailing slash', () => {
        expect(normalizePrefix('')).toBe('');
        expect(normalizePrefix('/factory')).toBe('factory/');
        expect(normalizePrefix('a/b//')).toBe('a/b/');
    });
});

describe('S3 requests', () => {
    function recorder(status = 200) {
        const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
        const fetchStub = (async (url: URL | string, init: RequestInit) => {
            calls.push({ url: String(url), method: init.method!, headers: init.headers as Record<string, string> });
            return new Response('', { status, headers: { 'content-length': '3' } });
        }) as typeof fetch;
        return { calls, fetchStub };
    }
    const build = (over: Partial<Parameters<typeof createS3Store>[0]>, fetchStub: typeof fetch) =>
        createS3Store({
            bucket: 'bkt',
            region: 'eu-west-1',
            endpoint: '',
            forcePathStyle: false,
            kmsKeyId: '',
            credentials: async () => EXAMPLE_KEYS,
            fetch: fetchStub,
            ...over,
        });

    it('puts create-only, with SSE-S3, on the virtual-hosted AWS host', async () => {
        const { calls, fetchStub } = recorder();
        expect(await build({}, fetchStub).put('factory/k', new Uint8Array([1, 2, 3]))).toBe('created');
        expect(calls[0]!.url).toBe('https://bkt.s3.eu-west-1.amazonaws.com/factory/k');
        expect(calls[0]!.headers['if-none-match']).toBe('*');
        expect(calls[0]!.headers['x-amz-server-side-encryption']).toBe('AES256');
        expect(calls[0]!.headers.authorization).toContain('SignedHeaders=');
        expect(calls[0]!.headers.authorization).toContain('if-none-match');
    });

    it('uses SSE-KMS when a key is set', async () => {
        const { calls, fetchStub } = recorder();
        await build({ kmsKeyId: 'alias/artifacts' }, fetchStub).put('k', new Uint8Array([1]));
        expect(calls[0]!.headers['x-amz-server-side-encryption']).toBe('aws:kms');
        expect(calls[0]!.headers['x-amz-server-side-encryption-aws-kms-key-id']).toBe('alias/artifacts');
    });

    it('addresses a custom endpoint path-style and sends no SSE-S3 header', async () => {
        const { calls, fetchStub } = recorder();
        await build({ endpoint: 'http://s3:9000', forcePathStyle: true }, fetchStub).put('k', new Uint8Array([1]));
        expect(calls[0]!.url).toBe('http://s3:9000/bkt/k');
        expect(calls[0]!.headers).not.toHaveProperty('x-amz-server-side-encryption');
    });

    it('reads a 412 as exists and any other failure as an error', async () => {
        expect(await build({}, recorder(412).fetchStub).put('k', new Uint8Array([1]))).toBe('exists');
        await expect(build({}, recorder(500).fetchStub).put('k', new Uint8Array([1]))).rejects.toThrow(
            /PUT answered 500/
        );
    });

    it('reads a 404 as absent for get and head, and a 403 as an error', async () => {
        const store = build({}, recorder(404).fetchStub);
        expect(await store.get('k')).toBeNull();
        expect(await store.head('k')).toBeNull();
        await expect(build({}, recorder(403).fetchStub).get('k')).rejects.toThrow(/GET answered 403/);
    });
});

describe('S3 credentials chain', () => {
    const expiry = (ms: number) => new Date(ms).toISOString();
    const NOW = Date.parse('2026-01-01T00:00:00Z');

    function jsonFetch(calls: { url: string; init: RequestInit | undefined }[], body: unknown) {
        return (async (url: string | URL, init?: RequestInit) => {
            calls.push({ url: String(url), init });
            return new Response(JSON.stringify(body), { status: 200 });
        }) as typeof fetch;
    }

    it('prefers static keys over everything else in the environment', async () => {
        const provider = createCredentialProvider({
            static: { accessKeyId: 'AK', secretAccessKey: 'SK' },
            env: {
                AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://pod/creds',
                AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/t',
            },
            region: 'us-east-1',
            fetch: (async () => {
                throw new Error('must not be called');
            }) as typeof fetch,
        });
        expect(await provider()).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK' });
    });

    it('uses EKS Pod Identity next, sending the token file as the authorization header', async () => {
        const calls: { url: string; init: RequestInit | undefined }[] = [];
        const provider = createCredentialProvider({
            static: null,
            env: {
                AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
                AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/token',
            },
            region: 'us-east-1',
            readFile: async () => 'pod-token\n',
            now: () => NOW,
            fetch: jsonFetch(calls, {
                AccessKeyId: 'PA',
                SecretAccessKey: 'PS',
                Token: 'PT',
                Expiration: expiry(NOW + 3_600_000),
            }),
        });
        expect(await provider()).toMatchObject({ accessKeyId: 'PA', secretAccessKey: 'PS', sessionToken: 'PT' });
        expect(calls[0]!.url).toBe('http://169.254.170.23/v1/credentials');
        expect(calls[0]!.init?.headers).toEqual({ authorization: 'pod-token' });
    });

    it('falls back to IRSA: AssumeRoleWithWebIdentity with the projected token', async () => {
        const calls: { url: string; init: RequestInit | undefined }[] = [];
        const provider = createCredentialProvider({
            static: null,
            env: { AWS_WEB_IDENTITY_TOKEN_FILE: '/jwt', AWS_ROLE_ARN: 'arn:aws:iam::1:role/factory' },
            region: 'eu-west-1',
            readFile: async () => 'jwt-token',
            now: () => NOW,
            fetch: jsonFetch(calls, {
                AssumeRoleWithWebIdentityResponse: {
                    AssumeRoleWithWebIdentityResult: {
                        Credentials: {
                            AccessKeyId: 'IA',
                            SecretAccessKey: 'IS',
                            SessionToken: 'IT',
                            Expiration: expiry(NOW + 3_600_000),
                        },
                    },
                },
            }),
        });
        expect(await provider()).toMatchObject({ accessKeyId: 'IA', sessionToken: 'IT' });
        expect(calls[0]!.url).toBe('https://sts.eu-west-1.amazonaws.com');
        const form = new URLSearchParams(String(calls[0]!.init?.body));
        expect(form.get('Action')).toBe('AssumeRoleWithWebIdentity');
        expect(form.get('RoleArn')).toBe('arn:aws:iam::1:role/factory');
        expect(form.get('WebIdentityToken')).toBe('jwt-token');
    });

    it('caches until shortly before expiry, then refetches once for concurrent callers', async () => {
        let now = NOW;
        const calls: { url: string; init: RequestInit | undefined }[] = [];
        const provider = createCredentialProvider({
            static: null,
            env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://pod/c', AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/t' },
            region: 'us-east-1',
            readFile: async () => 't',
            now: () => now,
            fetch: (async (url: string | URL, init?: RequestInit) => {
                calls.push({ url: String(url), init });
                return new Response(
                    JSON.stringify({
                        AccessKeyId: 'A',
                        SecretAccessKey: 'S',
                        Token: 'T',
                        Expiration: expiry(now + 3_600_000),
                    }),
                    { status: 200 }
                );
            }) as typeof fetch,
        });
        await provider();
        await provider();
        expect(calls).toHaveLength(1);
        now += 3_600_000 - 60_000;
        await Promise.all([provider(), provider(), provider()]);
        expect(calls).toHaveLength(2);
    });

    it('fails loudly when a configured source fails, and when nothing is configured', async () => {
        const broken = createCredentialProvider({
            static: null,
            env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://pod/c', AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/t' },
            region: 'us-east-1',
            readFile: async () => 't',
            fetch: (async () => new Response('denied', { status: 403 })) as typeof fetch,
        });
        await expect(broken()).rejects.toThrow(/Pod Identity answered 403/);
        await expect(createCredentialProvider({ static: null, env: {}, region: 'us-east-1' })()).rejects.toThrow(
            /no S3 credentials/
        );
    });
});

describe('artifacts config', () => {
    it('reads the attachment draft TTL in hours', () => {
        expect(loadArtifactsConfig({ ATTACHMENTS_DRAFT_TTL_HOURS: '6' }).attachmentDraftTtlHours).toBe(6);
    });

    it('defaults to the filesystem backend with a 90 day retention and no quota', () => {
        expect(loadArtifactsConfig({})).toEqual({
            backend: { kind: 'filesystem', root: '/tmp/factory-artifacts' },
            retentionDays: 90,
            orgQuotaBytes: 0,
            attachmentDraftTtlHours: 24,
        });
    });

    it('reads the s3 backend, defaulting the prefix and, with an endpoint, the region', () => {
        const config = loadArtifactsConfig({
            ARTIFACTS_BACKEND: 's3',
            ARTIFACTS_S3_BUCKET: 'bkt',
            ARTIFACTS_S3_ENDPOINT: 'http://s3:9000',
            ARTIFACTS_S3_FORCE_PATH_STYLE: 'true',
            ARTIFACTS_ACCESS_KEY_ID: 'a',
            ARTIFACTS_SECRET_ACCESS_KEY: 'b',
        });
        expect(config.backend).toEqual({
            kind: 's3',
            bucket: 'bkt',
            region: 'us-east-1',
            endpoint: 'http://s3:9000',
            forcePathStyle: true,
            prefix: 'factory/',
            kmsKeyId: '',
            staticCredentials: { accessKeyId: 'a', secretAccessKey: 'b' },
        });
    });

    it.each([
        ['an unknown backend', { ARTIFACTS_BACKEND: 'gcs' }, /ARTIFACTS_BACKEND/],
        ['s3 without a bucket', { ARTIFACTS_BACKEND: 's3' }, /ARTIFACTS_S3_BUCKET/],
        ['s3 with neither a region nor an endpoint', { ARTIFACTS_BACKEND: 's3', ARTIFACTS_S3_BUCKET: 'b' }, /REGION/],
        [
            'half a static key',
            {
                ARTIFACTS_BACKEND: 's3',
                ARTIFACTS_S3_BUCKET: 'b',
                ARTIFACTS_S3_REGION: 'r',
                ARTIFACTS_ACCESS_KEY_ID: 'a',
            },
            /together/,
        ],
        ['a relative filesystem root', { ARTIFACTS_FS_ROOT: 'data' }, /absolute/],
        ['a zero retention', { ARTIFACTS_RETENTION_DAYS: '0' }, /RETENTION/],
        ['a negative quota', { ARTIFACTS_ORG_QUOTA_BYTES: '-1' }, /QUOTA/],
        ['a zero attachment draft TTL', { ATTACHMENTS_DRAFT_TTL_HOURS: '0' }, /ATTACHMENTS_DRAFT_TTL_HOURS/],
        ['a fractional attachment draft TTL', { ATTACHMENTS_DRAFT_TTL_HOURS: '1.5' }, /ATTACHMENTS_DRAFT_TTL_HOURS/],
    ])('refuses %s', (_name, env, message) => {
        expect(() => loadArtifactsConfig(env)).toThrow(message);
    });
});

describe('credential provider hardening', () => {
    const POD = { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://pod/c', AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/t' };
    const keys = { AccessKeyId: 'A', SecretAccessKey: 'S', Expiration: new Date(Date.now() + 3_600_000).toISOString() };

    it('never puts a response body in the error, and types a refusal as misconfigured', async () => {
        const provider = createCredentialProvider({
            static: null,
            env: POD,
            region: 'us-east-1',
            readFile: async () => 't',
            fetch: (async () => new Response('sentinel-body-text', { status: 403 })) as typeof fetch,
        });
        const error = await provider().then(
            () => new Error('resolved'),
            (e: unknown) => e
        );
        expect(error).toBeInstanceOf(CredentialError);
        expect((error as CredentialError).kind).toBe('misconfigured');
        expect((error as Error).message).toMatch(/Pod Identity answered 403/);
        expect((error as Error).message).not.toContain('sentinel-body-text');
    });

    it('types a server failure as unavailable', async () => {
        const provider = createCredentialProvider({
            static: null,
            env: POD,
            region: 'us-east-1',
            readFile: async () => 't',
            fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
        });
        await expect(provider()).rejects.toMatchObject({ kind: 'unavailable' });
    });

    it('times out a hung credential fetch, and the next call fetches again', async () => {
        let calls = 0;
        const provider = createCredentialProvider({
            static: null,
            env: POD,
            region: 'us-east-1',
            readFile: async () => 't',
            fetchTimeoutMs: 30,
            fetch: ((_url: unknown, init?: RequestInit) => {
                calls += 1;
                if (calls === 1) {
                    return new Promise((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
                    });
                }
                return Promise.resolve(new Response(JSON.stringify(keys), { status: 200 }));
            }) as typeof fetch,
        });
        await expect(provider()).rejects.toMatchObject({ kind: 'unavailable' });
        expect(await provider()).toMatchObject({ accessKeyId: 'A' });
        expect(calls).toBe(2);
    });

    it('types a missing source as misconfigured', async () => {
        await expect(createCredentialProvider({ static: null, env: {}, region: 'us-east-1' })()).rejects.toMatchObject({
            kind: 'misconfigured',
        });
    });
});

describe('credential provider: one shared fetch bounded on its own', () => {
    const POD = { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://pod/c', AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/t' };
    const keysOf = (id: string) =>
        JSON.stringify({
            AccessKeyId: id,
            SecretAccessKey: 'S',
            Expiration: new Date(Date.now() + 3_600_000).toISOString(),
        });

    it('bounds a stalled token-file read, and a later call fetches with a readable file', async () => {
        let reads = 0;
        let fetches = 0;
        const provider = createCredentialProvider({
            static: null,
            env: POD,
            region: 'us-east-1',
            fetchTimeoutMs: 40,
            readFile: () => {
                reads += 1;
                return reads === 1 ? new Promise<string>(() => undefined) : Promise.resolve('t');
            },
            fetch: (async () => {
                fetches += 1;
                return new Response(keysOf('FRESH'), { status: 200 });
            }) as typeof fetch,
        });
        const started = Date.now();
        await expect(provider()).rejects.toMatchObject({ kind: 'unavailable' });
        expect(Date.now() - started).toBeLessThan(500);
        expect(await provider()).toMatchObject({ accessKeyId: 'FRESH' });
        expect(fetches).toBe(1);
    });

    it('drops the stale attempt when its read resolves late', async () => {
        let release: (value: string) => void = () => undefined;
        let reads = 0;
        let fetches = 0;
        const provider = createCredentialProvider({
            static: null,
            env: POD,
            region: 'us-east-1',
            fetchTimeoutMs: 40,
            readFile: () => {
                reads += 1;
                return reads === 1 ? new Promise<string>((resolve) => (release = resolve)) : Promise.resolve('t');
            },
            fetch: (async () => {
                fetches += 1;
                return new Response(keysOf(`K${fetches}`), { status: 200 });
            }) as typeof fetch,
        });
        await expect(provider()).rejects.toMatchObject({ kind: 'unavailable' });
        expect(await provider()).toMatchObject({ accessKeyId: 'K1' });
        release('t');
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await provider()).toMatchObject({ accessKeyId: 'K1' });
        expect(fetches).toBe(1);
    });
});
