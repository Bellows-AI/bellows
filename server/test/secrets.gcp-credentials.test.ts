import { describe, expect, it } from 'vitest';
import { CredentialError } from '../src/artifacts/s3-credentials.js';
import { createGcpTokenProvider } from '../src/secrets/gcp-credentials.js';

/** Application Default Credentials only (docs/secrets.md): metadata server, authorized_user file, no key file. */
const user = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
        type: 'authorized_user',
        client_id: 'client',
        client_secret: 'shh',
        refresh_token: 'refresh',
        ...extra,
    });
const absent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Call {
    url: string;
    init: RequestInit;
}

function setup(options: {
    env?: NodeJS.ProcessEnv;
    files?: Record<string, string | Error>;
    reply?: (call: Call) => Response;
}) {
    const calls: Call[] = [];
    const clock = { now: 1_000_000 };
    const provider = createGcpTokenProvider({
        env: options.env ?? { CLOUDSDK_CONFIG: '/adc' },
        now: () => clock.now,
        readFile: async (path) => {
            const file = options.files?.[path] ?? absent;
            if (file instanceof Error) throw file;
            return file;
        },
        fetch: (async (url: string, init: RequestInit) => {
            const call = { url, init };
            calls.push(call);
            return (options.reply ?? (() => answer({ access_token: 'tok', expires_in: 3600 })))(call);
        }) as typeof fetch,
    });
    return { provider, calls, clock };
}

const rejection = async (promise: Promise<unknown>) => {
    try {
        await promise;
    } catch (e) {
        return e as CredentialError;
    }
    throw new Error('expected a rejection');
};

describe('createGcpTokenProvider', () => {
    it('asks the metadata server when no credential file exists (Workload Identity)', async () => {
        const { provider, calls } = setup({});
        expect(await provider()).toEqual({ token: 'tok', quotaProject: null });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(
            'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
        );
        expect(calls[0]?.init.headers).toEqual({ 'Metadata-Flavor': 'Google' });
    });

    it('honours GCE_METADATA_HOST', async () => {
        const { provider, calls } = setup({ env: { CLOUDSDK_CONFIG: '/adc', GCE_METADATA_HOST: 'meta.test:8080' } });
        await provider();
        expect(calls[0]?.url).toMatch(/^http:\/\/meta\.test:8080\/computeMetadata\//);
    });

    it('refreshes an authorized_user file through the OAuth endpoint and carries its quota project', async () => {
        const { provider, calls } = setup({
            files: { '/adc/application_default_credentials.json': user({ quota_project_id: 'quota-1' }) },
        });
        expect(await provider()).toEqual({ token: 'tok', quotaProject: 'quota-1' });
        expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
        const form = new URLSearchParams(String(calls[0]?.init.body));
        expect(Object.fromEntries(form)).toEqual({
            grant_type: 'refresh_token',
            client_id: 'client',
            client_secret: 'shh',
            refresh_token: 'refresh',
        });
    });

    it('reads the file GOOGLE_APPLICATION_CREDENTIALS names before the gcloud one', async () => {
        const { provider, calls } = setup({
            env: { GOOGLE_APPLICATION_CREDENTIALS: '/named.json', CLOUDSDK_CONFIG: '/adc' },
            files: { '/named.json': user(), '/adc/application_default_credentials.json': 'not read' },
        });
        await provider();
        expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    });

    it.each([
        ['a service-account key file', JSON.stringify({ type: 'service_account', private_key: 'k' })],
        ['an external-account file', JSON.stringify({ type: 'external_account' })],
        ['a file that is not JSON', 'nope'],
        ['an authorized_user file without a refresh token', JSON.stringify({ type: 'authorized_user' })],
    ])('refuses %s as misconfigured and never asks the metadata server', async (_what, text) => {
        const { provider, calls } = setup({ files: { '/adc/application_default_credentials.json': text } });
        const error = await rejection(provider());
        expect(error).toBeInstanceOf(CredentialError);
        expect(error.kind).toBe('misconfigured');
        expect(error.message).not.toContain('private_key');
        expect(calls).toHaveLength(0);
    });

    it('does not fall through to the metadata server from a file it was told to read', async () => {
        const { provider, calls } = setup({ env: { GOOGLE_APPLICATION_CREDENTIALS: '/gone.json' } });
        expect((await rejection(provider())).kind).toBe('misconfigured');
        expect(calls).toHaveLength(0);
    });

    it('treats an unreadable well-known file as misconfigured, not as absent', async () => {
        const { provider, calls } = setup({ files: { '/adc/application_default_credentials.json': denied } });
        expect((await rejection(provider())).kind).toBe('misconfigured');
        expect(calls).toHaveLength(0);
    });

    it('classifies a 4xx answer as misconfigured and a 5xx or 429 as unavailable, never echoing a body', async () => {
        for (const [status, kind] of [
            [403, 'misconfigured'],
            [429, 'unavailable'],
            [503, 'unavailable'],
        ] as const) {
            const { provider } = setup({ reply: () => answer({ error: 'secret-detail' }, status) });
            const error = await rejection(provider());
            expect(error.kind).toBe(kind);
            expect(error.message).not.toContain('secret-detail');
        }
    });

    it('treats a malformed answer as unavailable', async () => {
        const { provider } = setup({ reply: () => answer({ access_token: '', expires_in: 'soon' }) });
        expect((await rejection(provider())).kind).toBe('unavailable');
    });

    it('caches until a minute before expiry, refetches after, and `fresh` skips the cache', async () => {
        const { provider, calls, clock } = setup({});
        await provider();
        await provider();
        expect(calls).toHaveLength(1);
        clock.now += 3600_000 - 61_000;
        await provider();
        expect(calls).toHaveLength(1);
        clock.now += 2_000;
        await provider();
        expect(calls).toHaveLength(2);
        await provider({ fresh: true });
        expect(calls).toHaveLength(3);
    });

    it('serves concurrent callers with one fetch and tries again after a failure', async () => {
        let fail = true;
        const { provider, calls } = setup({
            reply: () => (fail ? answer({}, 503) : answer({ access_token: 'tok', expires_in: 3600 })),
        });
        const failures = await Promise.allSettled([provider(), provider()]);
        expect(failures.map((r) => r.status)).toEqual(['rejected', 'rejected']);
        expect(calls).toHaveLength(1);
        fail = false;
        const [a, b] = await Promise.all([provider(), provider()]);
        expect(a).toEqual(b);
        expect(calls).toHaveLength(2);
    });
});
