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
import type { ProviderSetupStore, SetupCommand } from '../src/db/provider-setup-store.js';
import { HTTP_BAD_REQUEST, HTTP_OK, trackApps } from './helpers-http.js';

/** Offline: a rotation's base URL on `POST /api/provider-connections/setup`: absent leaves the connection's endpoint in place. */
const track = trackApps();

async function boot() {
    const auth = memoryAuthStore();
    const member = auth.seedMember('test-org', 'octocat');
    const envVars = memoryEnvVarStore();
    const executors = memoryUserExecutorStore();
    const commands: SetupCommand[] = [];
    const providerSetup: ProviderSetupStore = {
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
    };
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, envVars, userExecutors: executors, providerSetup }),
        auth,
    });
    track(app);
    return { app, envVars, commands, member, cookie: await signedIn(auth, member) };
}

type Booted = Awaited<ReturnType<typeof boot>>;
const post = (b: Booted, payload: object) =>
    b.app.inject({ method: 'POST', url: '/api/provider-connections/setup', headers: { cookie: b.cookie }, payload });

const save = {
    scope: 'personal',
    requestId: 'request-1',
    connection: { intent: 'create', provider: 'anthropic', key: 'sk-ant-new', name: 'Anthropic' },
    executor: { name: 'Claude', agentType: 'claude-code', model: 'm' },
};

describe('a rotation base URL in the provider setup', () => {
    it('rotation without a baseUrl leaves the connection’s endpoint, and a baseUrl replaces it', async () => {
        const b = await boot();
        const rotate = { intent: 'rotate', id: '11111111-1111-4111-8111-111111111111', key: 'sk-ant-new' };
        expect((await post(b, { ...save, connection: rotate })).statusCode).toBe(HTTP_OK);
        expect(b.commands[0]?.connection).toEqual(rotate);

        const moved = { ...rotate, baseUrl: 'https://gateway.example.test' };
        expect((await post(b, { ...save, connection: moved })).statusCode).toBe(HTTP_OK);
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
            expect((await post(b, body)).statusCode, JSON.stringify(body)).toBe(HTTP_BAD_REQUEST);
        expect(b.commands).toEqual([]);
    });
});
