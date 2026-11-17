import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryEnvVarStore,
    memoryUserExecutorStore,
    signedIn,
    staticRegistry,
    testConfig,
} from './helpers.js';
import { HTTP_BAD_REQUEST, HTTP_OK, trackApps } from './helpers-http.js';

/**
 * Offline: a scope's base URL in `GET /api/model-setup` — the plain value, never a secret's — and `keepBaseUrl` on
 * `PUT`, so a save that does not touch a base URL stored as a secret leaves it in place.
 */
const track = trackApps();

async function boot() {
    const auth = memoryAuthStore();
    const member = auth.seedMember('test-org', 'octocat');
    const envVars = memoryEnvVarStore();
    const executors = memoryUserExecutorStore();
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({ config, orgs: staticRegistry({ config, envVars, userExecutors: executors }), auth });
    track(app);
    return { app, envVars, member, cookie: await signedIn(auth, member) };
}

type Booted = Awaited<ReturnType<typeof boot>>;
const get = (b: Booted) => b.app.inject({ method: 'GET', url: '/api/model-setup', headers: { cookie: b.cookie } });
const put = (b: Booted, payload: object) =>
    b.app.inject({ method: 'PUT', url: '/api/model-setup', headers: { cookie: b.cookie }, payload });

const save = { scope: 'personal', provider: 'anthropic', key: 'sk-ant-new', agentType: 'claude-code', model: 'm' };

describe('a scope base URL in the model setup', () => {
    it('GET returns a plain base URL, and only that one is set for a secret one', async () => {
        const plain = await boot();
        await plain.envVars.replaceWorkspace(plain.member.user.id, [
            { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-x', isSecret: true },
            { name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example.test', isSecret: false },
        ]);
        const view = (await get(plain)).json().personal;
        expect(view).toMatchObject({ provider: 'litellm', baseUrl: 'https://gateway.example.test' });
        expect(view.baseUrlSet).toBeUndefined();

        const secret = await boot();
        await secret.envVars.replaceWorkspace(secret.member.user.id, [
            { name: 'OPENAI_API_KEY', value: 'sk-x', isSecret: true },
            { name: 'OPENAI_BASE_URL', value: 'https://hidden.example.test', isSecret: true },
        ]);
        const response = await get(secret);
        expect(response.json().personal).toMatchObject({ provider: 'openai', baseUrlSet: true });
        expect(response.json().personal.baseUrl).toBeUndefined();
        expect(response.body).not.toContain('hidden.example.test');
    });

    it('PUT with keepBaseUrl replaces the key and leaves the secret base URL; without it the base URL goes', async () => {
        const b = await boot();
        const rows = [
            { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-old', isSecret: true },
            { name: 'ANTHROPIC_BASE_URL', value: 'https://hidden.example.test', isSecret: true },
        ];
        await b.envVars.replaceWorkspace(b.member.user.id, rows);
        expect((await put(b, { ...save, keepBaseUrl: true })).statusCode).toBe(HTTP_OK);
        expect((await get(b)).json().personal).toMatchObject({ baseUrlSet: true });

        expect((await put(b, save)).statusCode).toBe(HTTP_OK);
        const after = (await get(b)).json().personal;
        expect(after.baseUrlSet).toBeUndefined();
        expect(after.baseUrl).toBeUndefined();
    });

    it('refuses keepBaseUrl beside a baseUrl, as anything but true, or for LiteLLM and a subscription', async () => {
        const b = await boot();
        const refused = [
            { ...save, keepBaseUrl: true, baseUrl: 'https://x.example.test' },
            { ...save, keepBaseUrl: false },
            { ...save, provider: 'litellm', keepBaseUrl: true },
            { ...save, provider: 'subscription', keepBaseUrl: true },
        ];
        for (const body of refused)
            expect((await put(b, body)).statusCode, JSON.stringify(body)).toBe(HTTP_BAD_REQUEST);
    });
});
