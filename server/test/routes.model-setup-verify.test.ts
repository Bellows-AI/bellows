import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createProviderKeys } from '../src/provider-keys/verify.js';
import {
    type FakeProvider,
    modelList,
    openRouterKey,
    serverError,
    startFakeProvider,
    unauthorized,
} from './fake-provider.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, testConfig } from './helpers.js';
import { HTTP_BAD_REQUEST, HTTP_OK, HTTP_UNAUTHORIZED, trackApps } from './helpers-http.js';

/**
 * Offline: `POST /api/model-setup/verify`. A member's provider key is checked against the provider and
 * stored nowhere; the key never reaches a log line or a response body.
 */

const track = trackApps();
const URL_PATH = '/api/model-setup/verify';
const KEY = 'sk-ant-api03-route-secret-0123456789';
const HTTP_TOO_MANY = 429;
const LIMIT = 10;

let fake: FakeProvider;
beforeEach(async () => {
    fake = await startFakeProvider();
});
afterEach(async () => {
    await fake.close();
});

async function boot(deploymentMode: 'self-hosted' | 'cloud' = 'self-hosted') {
    const auth = memoryAuthStore();
    const alice = auth.seedMember('test-org', 'alice');
    const bob = auth.seedMember('test-org', 'bob');
    const config = testConfig({ auth: githubAuth(), deploymentMode });
    const lines: string[] = [];
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config }),
        auth,
        providerKeys: createProviderKeys({
            deploymentMode,
            endpoints: { anthropic: fake.origin, openai: fake.origin, openrouter: `${fake.origin}/api` },
        }),
        logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    });
    track(app);
    return { app, lines, alice: await signedIn(auth, alice), bob: await signedIn(auth, bob) };
}

type Booted = Awaited<ReturnType<typeof boot>>;

const verify = (app: Booted['app'], cookie: string, payload: unknown) =>
    app.inject({
        method: 'POST',
        url: URL_PATH,
        headers: { cookie, 'content-type': 'application/json' },
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });

describe('POST /api/model-setup/verify', () => {
    it('answers the check, uncached', async () => {
        const { app, alice } = await boot();
        fake.reply('/v1/models', modelList('claude-sonnet-4-5'));
        const res = await verify(app, alice, { provider: 'anthropic', key: KEY });
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.json()).toEqual({ ok: true, models: ['claude-sonnet-4-5'] });
    });

    it('answers a failed check as 200 with its code and a message', async () => {
        const { app, alice } = await boot();
        fake.reply('/v1/models', unauthorized);
        const res = await verify(app, alice, { provider: 'anthropic', key: KEY });
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.json()).toEqual({ ok: false, code: 'INVALID_KEY', message: expect.any(String) });
    });

    it.each([
        ['an unknown provider', { provider: 'mistral', key: KEY }],
        ['no key', { provider: 'anthropic' }],
        ['an empty key', { provider: 'anthropic', key: '' }],
        ['a key with whitespace', { provider: 'anthropic', key: `${KEY}\r\nx-evil: 1` }],
        [
            'a base URL for a subscription',
            { provider: 'subscription', key: 'sk-ant-oat01-a', baseUrl: 'http://127.0.0.1:1' },
        ],
        ['a base URL that is not a URL', { provider: 'litellm', key: KEY, baseUrl: 'not a url' }],
        ['a base URL that is not http', { provider: 'litellm', key: KEY, baseUrl: 'file:///etc/passwd' }],
        ['a base URL with userinfo', { provider: 'litellm', key: KEY, baseUrl: 'https://u:p@proxy.example.test' }],
        ['litellm without a base URL', { provider: 'litellm', key: KEY }],
        ['an unknown field', { provider: 'anthropic', key: KEY, extra: 1 }],
    ])('refuses %s as BAD_BODY without asking anyone', async (_label, payload) => {
        const { app, alice } = await boot();
        const res = await verify(app, alice, payload);
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json()).toMatchObject({ code: 'BAD_BODY' });
        expect(res.body).not.toContain(KEY);
        expect(fake.requests).toEqual([]);
    });

    it('a malformed JSON body that carries the key is refused without echoing it', async () => {
        const { app, alice, lines } = await boot();
        const res = await verify(app, alice, `{"provider":"anthropic","key":"${KEY}",`);
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.body).not.toContain(KEY);
        expect(lines.join('\n')).not.toContain(KEY);
    });

    it('cloud: a base URL on a private address is refused before any request', async () => {
        const { app, alice } = await boot('cloud');
        const res = await verify(app, alice, { provider: 'litellm', key: KEY, baseUrl: fake.origin });
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.json()).toMatchObject({ ok: false, code: 'REFUSED_IN_CLOUD' });
        expect(fake.requests).toEqual([]);
    });

    it('the 11th check in a minute by one member is 429 RATE_LIMITED; another member is unaffected', async () => {
        const { app, alice, bob } = await boot();
        fake.reply('/api/v1/key', openRouterKey(5));
        for (let i = 0; i < LIMIT; i += 1) {
            expect((await verify(app, alice, { provider: 'openrouter', key: KEY })).statusCode).toBe(HTTP_OK);
        }
        const over = await verify(app, alice, { provider: 'openrouter', key: KEY });
        expect(over.statusCode).toBe(HTTP_TOO_MANY);
        expect(over.json()).toMatchObject({ code: 'RATE_LIMITED' });
        expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
        expect(fake.requests).toHaveLength(LIMIT);
        expect((await verify(app, bob, { provider: 'openrouter', key: KEY })).statusCode).toBe(HTTP_OK);
    });

    it('needs a signed-in member', async () => {
        const { app } = await boot();
        const res = await app.inject({ method: 'POST', url: URL_PATH, payload: { provider: 'anthropic', key: KEY } });
        expect(res.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(res.body).not.toContain(KEY);
    });

    it('the key appears in no log line and no response body, success or failure', async () => {
        const { app, alice, lines } = await boot();
        const bodies: string[] = [];
        for (const reply of [modelList('m'), unauthorized, serverError]) {
            fake.reply('/v1/models', reply);
            bodies.push((await verify(app, alice, { provider: 'anthropic', key: KEY })).body);
            bodies.push((await verify(app, alice, { provider: 'litellm', key: KEY, baseUrl: fake.origin })).body);
        }
        bodies.push((await verify(app, alice, { provider: 'subscription', key: KEY })).body);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join('\n')).not.toContain(KEY);
        for (const body of bodies) expect(body).not.toContain(KEY);
        expect(fake.requests.length).toBeGreaterThan(0);
    });
});
