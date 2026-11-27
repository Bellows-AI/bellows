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
import type { ModelSetupStore, SetupCommand } from '../src/db/model-setup-store.js';
import { HTTP_BAD_REQUEST, HTTP_OK, trackApps } from './helpers-http.js';

/**
 * Offline: a scope's base URL in `GET /api/model-setup` — the plain value, never a secret's — and a rotation's base URL
 * on `PUT`: absent leaves the connection's endpoint in place.
 */
const track = trackApps();

async function boot() {
    const auth = memoryAuthStore();
    const member = auth.seedMember('test-org', 'octocat');
    const envVars = memoryEnvVarStore();
    const executors = memoryUserExecutorStore();
    const commands: SetupCommand[] = [];
    const modelSetup: ModelSetupStore = {
        async apply(command) {
            commands.push(command);
            return {
                scope: command.scope,
                executorId: 'executor-1',
                executorName: 'Claude',
                connectionId: 'connection-1',
                connectionName: null,
                replayed: false,
            };
        },
        async selectedFor() {
            return null;
        },
    };
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, envVars, userExecutors: executors, modelSetup }),
        auth,
    });
    track(app);
    return { app, envVars, commands, member, cookie: await signedIn(auth, member) };
}

type Booted = Awaited<ReturnType<typeof boot>>;
const get = (b: Booted) => b.app.inject({ method: 'GET', url: '/api/model-setup', headers: { cookie: b.cookie } });
const put = (b: Booted, payload: object) =>
    b.app.inject({ method: 'PUT', url: '/api/model-setup', headers: { cookie: b.cookie }, payload });

const save = {
    scope: 'personal',
    requestId: 'request-1',
    agentType: 'claude-code',
    model: 'm',
    connection: { intent: 'create', provider: 'anthropic', key: 'sk-ant-new', name: 'Anthropic' },
    executor: { name: 'Claude' },
};

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

    it('PUT rotation without a baseUrl leaves the connection’s endpoint, and a baseUrl replaces it', async () => {
        const b = await boot();
        const rotate = { intent: 'rotate', id: '11111111-1111-4111-8111-111111111111', key: 'sk-ant-new' };
        expect((await put(b, { ...save, connection: rotate })).statusCode).toBe(HTTP_OK);
        expect(b.commands[0]?.connection).toEqual(rotate);

        const moved = { ...rotate, baseUrl: 'https://gateway.example.test' };
        expect((await put(b, { ...save, connection: moved })).statusCode).toBe(HTTP_OK);
        expect(b.commands[1]?.connection).toEqual(moved);
    });

    it('refuses a rotation baseUrl that is not an http(s) URL without credentials, and keepBaseUrl, which is gone', async () => {
        const b = await boot();
        const rotate = { intent: 'rotate', id: '11111111-1111-4111-8111-111111111111', key: 'sk-ant-new' };
        const refused = [
            { ...save, connection: { ...rotate, baseUrl: 'ftp://x.example.test' } },
            { ...save, connection: { ...rotate, baseUrl: 'https://user:pw@x.example.test' } },
            { ...save, connection: { ...rotate, keepBaseUrl: true } },
            { ...save, keepBaseUrl: true },
        ];
        for (const body of refused)
            expect((await put(b, body)).statusCode, JSON.stringify(body)).toBe(HTTP_BAD_REQUEST);
        expect(b.commands).toEqual([]);
    });
});
