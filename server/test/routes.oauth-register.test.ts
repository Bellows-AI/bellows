import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { OAuthStore } from '../src/auth/oauth-store.js';
import {
    githubAuth,
    memoryAuthStore,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from './helpers.js';
import { trackApps } from './helpers-http.js';

const track = trackApps();
const PUBLIC_URL = 'https://board.example.test';
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAVAILABLE = 503;
const HTTP_TOO_MANY = 429;
const GOOD = {
    redirect_uris: ['http://127.0.0.1/callback'],
    client_name: 'Native tool',
    token_endpoint_auth_method: 'none',
};

type Upsert = Parameters<OAuthStore['upsertClient']>[0];
const board = async (upsertClient: (input: Upsert) => Promise<void> = async () => undefined) => {
    const config = testConfig({
        auth: githubAuth({ publicUrl: PUBLIC_URL }),
        mcp: { enabled: true, resource: `${PUBLIC_URL}/api/mcp`, trustedOrigins: [] },
    });
    return track(
        await buildApp({
            config,
            orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
            store: telemetryStoreStub(),
            auth: memoryAuthStore(),
            oauth: { upsertClient } as unknown as OAuthStore,
        })
    );
};
const register = (app: Awaited<ReturnType<typeof board>>, payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/oauth/register', payload: payload as object });

describe('POST /api/oauth/register (RFC 7591)', () => {
    it('registers a public client with no credential, generating the id server-side', async () => {
        const stored: Upsert[] = [];
        const app = await board(async (input) => void stored.push(input));
        const response = await register(app, { ...GOOD, client_id: 'chosen-by-caller' });
        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(response.headers['cache-control']).toBe('no-store');
        const body = response.json();
        expect(body).toMatchObject({
            redirect_uris: GOOD.redirect_uris,
            client_name: 'Native tool',
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
        });
        expect(body.client_id).toMatch(/^dcr_[\w-]{24}$/);
        expect(body.client_secret).toBeUndefined();
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ clientId: body.client_id, kind: 'dcr', redirectUris: GOOD.redirect_uris });
        const second = (await register(app, GOOD)).json();
        expect(second.client_id).not.toBe(body.client_id);
    });

    it.each([
        ['no redirect_uris', { client_name: 'x' }, 'invalid_redirect_uri'],
        ['an empty list', { redirect_uris: [] }, 'invalid_redirect_uri'],
        ['a plain http redirect', { redirect_uris: ['http://client.example.test/cb'] }, 'invalid_redirect_uri'],
        ['a javascript redirect', { redirect_uris: ['javascript:alert(1)'] }, 'invalid_redirect_uri'],
        ['a fragment', { redirect_uris: ['https://client.example.test/cb#x'] }, 'invalid_redirect_uri'],
        [
            'eleven redirects',
            { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://c.example.test/${i}`) },
            'invalid_redirect_uri',
        ],
        [
            'a confidential client',
            { ...GOOD, token_endpoint_auth_method: 'client_secret_basic' },
            'invalid_client_metadata',
        ],
        ['a supplied secret', { ...GOOD, client_secret: 's' }, 'invalid_client_metadata'],
        ['an implicit grant', { ...GOOD, grant_types: ['implicit'] }, 'invalid_client_metadata'],
        ['a token response type', { ...GOOD, response_types: ['token'] }, 'invalid_client_metadata'],
        ['a control character in the name', { ...GOOD, client_name: 'a\nb' }, 'invalid_client_metadata'],
        ['an array body', [GOOD], 'invalid_client_metadata'],
    ])('refuses %s with %s', async (_name, payload, error) => {
        const stored: Upsert[] = [];
        const response = await register(await board(async (input) => void stored.push(input)), payload);
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().error).toBe(error);
        expect(stored).toHaveLength(0);
    });

    it('answers 503 when the registration could not be stored, never a client id', async () => {
        const response = await register(
            await board(async () => {
                throw new Error('down');
            }),
            GOOD
        );
        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(response.json().client_id).toBeUndefined();
    });

    it('refuses a body over 16 KiB', async () => {
        const response = await register(await board(), { ...GOOD, client_name: 'x'.repeat(20_000) });
        expect(response.statusCode).toBe(413);
    });
});

describe('DCR rate limit (this process only)', () => {
    const limited = async (registrationLimits: { perAddress: number; total: number; windowMs: number }) => {
        const config = testConfig({
            auth: githubAuth({ publicUrl: PUBLIC_URL }),
            mcp: { enabled: true, resource: `${PUBLIC_URL}/api/mcp`, trustedOrigins: [] },
        });
        const { oauthRoutes } = await import('../src/routes/oauth.js');
        const Fastify = (await import('fastify')).default;
        const app = Fastify();
        await app.register(
            oauthRoutes({
                config,
                auth: memoryAuthStore(),
                oauth: { upsertClient: async () => undefined } as unknown as OAuthStore,
                registrationLimits,
            })
        );
        return track(app);
    };

    it('answers 429 with Retry-After once a caller is over its window', async () => {
        const app = await limited({ perAddress: 2, total: 100, windowMs: 60_000 });
        expect((await register(app, GOOD)).statusCode).toBe(HTTP_CREATED);
        expect((await register(app, GOOD)).statusCode).toBe(HTTP_CREATED);
        const refused = await register(app, GOOD);
        expect(refused.statusCode).toBe(HTTP_TOO_MANY);
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('also bounds the replica as a whole, whoever asks', async () => {
        const app = await limited({ perAddress: 100, total: 2, windowMs: 60_000 });
        const from = (ip: string) =>
            app.inject({ method: 'POST', url: '/api/oauth/register', payload: GOOD, remoteAddress: ip });
        expect((await from('203.0.113.1')).statusCode).toBe(HTTP_CREATED);
        expect((await from('203.0.113.2')).statusCode).toBe(HTTP_CREATED);
        expect((await from('203.0.113.3')).statusCode).toBe(HTTP_TOO_MANY);
    });
});
