import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { ExecutorConnectionRefusedError } from '../src/db/executor-connection-selection.js';
import {
    ModelSetupConflict,
    ModelSetupNameConflict,
    type ModelSetupStore,
    type SelectedSetup,
    type SetupCommand,
} from '../src/db/model-setup-store.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryEnvVarStore,
    memoryUserExecutorStore,
    signedIn,
    staticRegistry,
    testConfig,
} from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CONFLICT,
    HTTP_FORBIDDEN,
    HTTP_OK,
    HTTP_SERVICE_UNAVAILABLE,
    trackApps,
} from './helpers-http.js';
import { storeOutage } from './helpers-outage.js';

/**
 * Offline: the HTTP contract of `GET` / `PUT /api/model-setup` against the in-memory env and executor store doubles and
 * a recording double of the setup command. The command's transaction (a failed publication step leaves the previous
 * default usable, a retry replays) is covered by server/test-db/model-setup.store.test.ts, and the route over the real
 * stores by server/test-db/model-setup.routes.test.ts.
 */
const track = trackApps();

const ANTHROPIC_KEY = 'sk-ant-test-value';
const OPENROUTER_KEY = 'sk-or-test-value';

/** The setup command's double: records what the route asked for and answers fixed identities, or what a test scripts. */
function recordingSetup() {
    const commands: SetupCommand[] = [];
    let selected: SelectedSetup | null = null;
    const double = {
        commands,
        fail: null as Error | null,
        setSelected: (value: SelectedSetup | null) => {
            selected = value;
        },
        store: {
            async apply(command: SetupCommand) {
                if (double.fail) throw double.fail;
                commands.push(command);
                return {
                    scope: command.scope,
                    executorId: command.executor.id ?? 'executor-1',
                    executorName: command.executor.name ?? 'kept',
                    connectionId: command.connection.intent === 'none' ? null : 'connection-1',
                    connectionName: command.connection.intent === 'create' ? command.connection.name : null,
                    replayed: false,
                };
            },
            async selectedFor() {
                return selected;
            },
        } satisfies ModelSetupStore,
    };
    return double;
}

async function boot(overrides: Partial<AppConfig> = {}) {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const envVars = memoryEnvVarStore();
    const executors = memoryUserExecutorStore();
    const setup = recordingSetup();
    const config = testConfig({ auth: githubAuth(), ...overrides });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, envVars, userExecutors: executors, modelSetup: setup.store }),
        auth,
    });
    track(app);
    return {
        app,
        envVars,
        executors,
        setup,
        admin,
        member,
        adminCookie: await signedIn(auth, admin),
        memberCookie: await signedIn(auth, member),
    };
}

type Booted = Awaited<ReturnType<typeof boot>>;
const get = (b: Booted, cookie: string) =>
    b.app.inject({ method: 'GET', url: '/api/model-setup', headers: { cookie } });
const put = (b: Booted, cookie: string, payload: object) =>
    b.app.inject({ method: 'PUT', url: '/api/model-setup', headers: { cookie }, payload });

const anthropicPersonal = {
    scope: 'personal',
    requestId: 'request-1',
    agentType: 'claude-code',
    model: 'claude-sonnet-4-5',
    connection: { intent: 'create', provider: 'anthropic', key: ANTHROPIC_KEY, name: 'Anthropic' },
    executor: { name: 'Claude' },
};
const withConnection = (connection: object, over: object = {}) => ({ ...anthropicPersonal, connection, ...over });

describe('GET /api/model-setup', () => {
    it('answers nothing configured on a fresh board', async () => {
        const b = await boot();
        const response = await get(b, b.memberCookie);
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ platform: false, org: null, personal: null, effective: null });
    });

    it('shows a saved personal setup by names only, the personal scope effective', async () => {
        const b = await boot();
        await b.envVars.replaceWorkspace(b.member.user.id, [
            { name: 'ANTHROPIC_API_KEY', value: ANTHROPIC_KEY, isSecret: true },
        ]);
        await b.executors.setAgentDefault(b.member.user.id, {
            agentType: 'claude-code',
            model: 'claude-sonnet-4-5',
            provider: 'anthropic',
        });

        const response = await get(b, b.memberCookie);
        expect(response.json()).toEqual({
            platform: false,
            org: null,
            personal: {
                provider: 'anthropic',
                agentType: 'claude-code',
                model: 'claude-sonnet-4-5',
                keyNames: ['ANTHROPIC_API_KEY'],
            },
            effective: 'personal',
        });
        expect(response.body).not.toContain(ANTHROPIC_KEY);
    });

    it('infers the provider from the names of a scope saved outside the model setup', async () => {
        const b = await boot();
        await b.envVars.replaceOrg('env-admin', [
            { name: 'OPENROUTER_API_KEY', value: OPENROUTER_KEY, isSecret: true },
        ]);
        expect((await get(b, b.memberCookie)).json()).toEqual({
            platform: false,
            org: { provider: 'openrouter', agentType: null, model: null, keyNames: ['OPENROUTER_API_KEY'] },
            personal: null,
            effective: 'org',
        });
    });

    it('reports the platform model, effective while no scope holds a key', async () => {
        const b = await boot({ platformModelProvided: true });
        expect((await get(b, b.memberCookie)).json()).toEqual({
            platform: true,
            org: null,
            personal: null,
            effective: 'platform',
        });
        await b.envVars.replaceWorkspace(b.member.user.id, [
            { name: 'ANTHROPIC_API_KEY', value: ANTHROPIC_KEY, isSecret: true },
        ]);
        expect((await get(b, b.memberCookie)).json()).toMatchObject({ platform: true, effective: 'personal' });
    });

    it('is a 503, never "nothing configured", when the env read fails', async () => {
        const b = await boot({ platformModelProvided: true });
        b.envVars.listWorkspace = async () => {
            throw storeOutage();
        };
        const response = await get(b, b.memberCookie);
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.json()).not.toHaveProperty('effective');
    });

    it('is a 503 when the agent default read fails', async () => {
        const b = await boot();
        b.executors.agentDefaults = async () => {
            throw storeOutage();
        };
        const response = await get(b, b.memberCookie);
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.json()).not.toHaveProperty('effective');
    });
});

describe('GET /api/model-setup with a default executor', () => {
    const selected: SelectedSetup = {
        scope: 'org',
        executorId: 'executor-1',
        executorName: 'Claude',
        agentType: 'claude-code',
        model: 'claude-sonnet-4-5',
        suspended: false,
        connection: { id: 'connection-1', name: 'Anthropic', provider: 'anthropic', scope: 'org' },
    };

    it('reports the selected executor and its connection, effective before any env key, with no value', async () => {
        const b = await boot();
        b.setup.setSelected(selected);
        await b.envVars.replaceWorkspace(b.member.user.id, [
            { name: 'OPENAI_API_KEY', value: 'sk-env-key', isSecret: true },
        ]);
        const response = await get(b, b.memberCookie);
        expect(response.json()).toMatchObject({
            effective: 'executor',
            selected: {
                scope: 'org',
                executorId: 'executor-1',
                name: 'Claude',
                agentType: 'claude-code',
                model: 'claude-sonnet-4-5',
                connection: { id: 'connection-1', provider: 'anthropic', scope: 'org' },
            },
            personal: { provider: 'openai' },
        });
        expect(response.body).not.toContain('sk-env-key');
    });

    it('leaves the legacy source effective while the default executor is suspended', async () => {
        const b = await boot();
        b.setup.setSelected({ ...selected, suspended: true });
        const response = await get(b, b.memberCookie);
        expect(response.json()).toMatchObject({ effective: null, selected: { suspended: true } });
    });

    it('is a 503, never "nothing configured", when the default executor read fails', async () => {
        const b = await boot();
        b.setup.store.selectedFor = async () => {
            throw storeOutage();
        };
        const response = await get(b, b.memberCookie);
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.json()).not.toHaveProperty('effective');
    });
});

describe('PUT /api/model-setup', () => {
    it('refuses a member writing the org scope with 403 and applies nothing', async () => {
        const b = await boot();
        const response = await put(b, b.memberCookie, { ...anthropicPersonal, scope: 'org' });
        expect(response.statusCode).toBe(HTTP_FORBIDDEN);
        expect(b.setup.commands).toEqual([]);
    });

    it('lets an admin write the org scope', async () => {
        const b = await boot();
        expect((await put(b, b.adminCookie, { ...anthropicPersonal, scope: 'org' })).statusCode).toBe(HTTP_OK);
        expect(b.setup.commands[0]).toMatchObject({ scope: 'org', userId: b.admin.user.id });
    });

    it('answers the stable identities and never the key, and writes no env row or agent default', async () => {
        const b = await boot();
        const response = await put(b, b.memberCookie, anthropicPersonal);
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({
            saved: true,
            scope: 'personal',
            executorId: 'executor-1',
            executorName: 'Claude',
            connectionId: 'connection-1',
            connectionName: 'Anthropic',
            replayed: false,
        });
        expect(response.body).not.toContain(ANTHROPIC_KEY);
        expect(b.envVars.rows()).toEqual([]);
        expect(await b.executors.agentDefaults(b.member.user.id)).toEqual({ org: null, personal: null });
        expect(b.setup.commands[0]).toMatchObject({
            requestId: 'request-1',
            connection: { intent: 'create', provider: 'anthropic', key: ANTHROPIC_KEY, name: 'Anthropic', baseUrl: null },
            executor: { name: 'Claude', agentType: 'claude-code', model: 'claude-sonnet-4-5' },
        });
    });

    it('refuses an agent the provider does not run', async () => {
        const b = await boot();
        const response = await put(
            b,
            b.memberCookie,
            withConnection(
                { intent: 'create', provider: 'openai', key: 'sk-openai', name: 'OpenAI' },
                { model: 'gpt-5' }
            )
        );
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(b.setup.commands).toEqual([]);
    });

    it('refuses a subscription token in cloud with CLOUD_CREDENTIAL_REFUSED', async () => {
        const b = await boot({ deploymentMode: 'cloud' });
        const response = await put(
            b,
            b.memberCookie,
            withConnection({ intent: 'create', provider: 'subscription', key: 'sk-ant-oat-test', name: 'Sub' })
        );
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('CLOUD_CREDENTIAL_REFUSED');
        expect(b.setup.commands).toEqual([]);
    });

    it('refuses LiteLLM without a base URL, and passes the base URL on with one', async () => {
        const b = await boot();
        const litellm = { intent: 'create', provider: 'litellm', key: 'sk-litellm', name: 'Proxy' };
        expect((await put(b, b.memberCookie, withConnection(litellm))).statusCode).toBe(HTTP_BAD_REQUEST);
        expect(b.setup.commands).toEqual([]);

        const saved = await put(b, b.memberCookie, withConnection({ ...litellm, baseUrl: 'https://llm.example.test' }));
        expect(saved.statusCode).toBe(HTTP_OK);
        expect(b.setup.commands[0]?.connection).toMatchObject({ baseUrl: 'https://llm.example.test' });
    });

    it('refuses a malformed body: unknown fields, intents, request ids and keys', async () => {
        const b = await boot();
        const refused = [
            { ...anthropicPersonal, extra: 1 },
            { ...anthropicPersonal, requestId: '' },
            { ...anthropicPersonal, requestId: undefined },
            withConnection({ intent: 'steal', id: 'x' }),
            withConnection({ intent: 'reuse' }),
            withConnection({ intent: 'reuse', id: 'x', key: 'sk-x' }),
            withConnection({ intent: 'none', key: 'sk-x' }),
            withConnection({ intent: 'rotate', id: 'x', key: 'has space' }),
            withConnection({ intent: 'create', provider: 'anthropic', key: 'sk-x' }),
            { ...anthropicPersonal, executor: { name: 'Claude', id: '' } },
        ];
        for (const body of refused) {
            const response = await put(b, b.memberCookie, body);
            expect(response.statusCode, JSON.stringify(body)).toBe(HTTP_BAD_REQUEST);
            expect(response.body).not.toContain(ANTHROPIC_KEY);
        }
        expect(b.setup.commands).toEqual([]);
    });

    it('passes reuse and rotate intents on by id, an edit naming its executor id', async () => {
        const b = await boot();
        await put(
            b,
            b.memberCookie,
            withConnection(
                { intent: 'reuse', id: 'connection-1' },
                { executor: { id: 'executor-1', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' } }
            )
        );
        await put(b, b.memberCookie, withConnection({ intent: 'rotate', id: 'connection-1', key: 'sk-ant-new' }));
        expect(b.setup.commands.map((c) => c.connection.intent)).toEqual(['reuse', 'rotate']);
        expect(b.setup.commands[0]?.executor).toMatchObject({
            id: 'executor-1',
            expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        });
    });

    it('answers a name collision 409 NAME_TAKEN, a stale setup 409, and a refused selection 409', async () => {
        const b = await boot();
        b.setup.fail = new ModelSetupNameConflict('connection');
        const taken = await put(b, b.memberCookie, anthropicPersonal);
        expect(taken.statusCode).toBe(HTTP_CONFLICT);
        expect(taken.json().code).toBe('NAME_TAKEN');
        expect(taken.body).not.toContain(ANTHROPIC_KEY);

        b.setup.fail = new ModelSetupConflict('The executor changed since you read it');
        const stale = await put(b, b.memberCookie, anthropicPersonal);
        expect(stale.statusCode).toBe(HTTP_CONFLICT);
        expect(stale.json().code).toBe('MODEL_SETUP_CONFLICT');

        b.setup.fail = new ExecutorConnectionRefusedError('scope', 'An organization executor can only use an organization provider connection.');
        const refused = await put(b, b.memberCookie, anthropicPersonal);
        expect(refused.statusCode).toBe(HTTP_CONFLICT);
        expect(refused.json().code).toBe('PROVIDER_CONNECTION_REFUSED');
    });

    it('a failing store answers 503 and no key leaks', async () => {
        const b = await boot();
        b.setup.fail = storeOutage();
        const response = await put(b, b.memberCookie, anthropicPersonal);
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.body).not.toContain(ANTHROPIC_KEY);
    });
});

describe('PUT /api/model-setup with no connection', () => {
    const none = withConnection(
        { intent: 'none' },
        { executor: { name: 'Platform' } }
    );

    it('with the platform model on, applies an executor on the platform model', async () => {
        const b = await boot({ platformModelProvided: true });
        const response = await put(b, b.memberCookie, none);
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().connectionId).toBeNull();
        expect(b.setup.commands[0]?.connection).toEqual({ intent: 'none', source: 'platform' });
        expect(b.envVars.rows()).toEqual([]);
    });

    it('adopts the org’s existing key with the platform model off, leaving the env as it was', async () => {
        const b = await boot();
        await b.envVars.replaceOrg('env-admin', [
            { name: 'OPENROUTER_API_KEY', value: OPENROUTER_KEY, isSecret: true },
        ]);
        const before = b.envVars.rows();
        const response = await put(
            b,
            b.memberCookie,
            withConnection({ intent: 'none' }, { agentType: 'opencode', model: 'anthropic/claude-sonnet-4.5' })
        );
        expect(response.statusCode).toBe(HTTP_OK);
        expect(b.envVars.rows()).toEqual(before);
        expect(b.setup.commands[0]?.connection).toEqual({ intent: 'none', source: 'openrouter' });
    });

    it('refuses it with no key in view or an agent the key cannot run', async () => {
        const none_ = await boot();
        expect((await put(none_, none_.memberCookie, none)).statusCode).toBe(HTTP_BAD_REQUEST);
        expect(none_.setup.commands).toEqual([]);

        const b = await boot();
        await b.envVars.replaceOrg('env-admin', [{ name: 'OPENAI_API_KEY', value: 'sk-openai', isSecret: true }]);
        expect((await put(b, b.memberCookie, none)).statusCode).toBe(HTTP_BAD_REQUEST);
        // The org's key is not in the org scope's view of a personal key; only the member's own is.
        await b.envVars.replaceOrg('env-admin', []);
        await b.envVars.replaceWorkspace(b.member.user.id, [{ name: 'OPENAI_API_KEY', value: 'mine', isSecret: true }]);
        expect((await put(b, b.adminCookie, { ...none, scope: 'org' })).statusCode).toBe(HTTP_BAD_REQUEST);
        expect(b.setup.commands).toEqual([]);
    });

    it('refuses it with 503 when the names cannot be read', async () => {
        const b = await boot();
        b.envVars.listOrg = async () => {
            throw storeOutage();
        };
        const response = await put(b, b.memberCookie, withConnection({ intent: 'none' }, { agentType: 'opencode', model: 'gpt-5' }));
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(b.setup.commands).toEqual([]);
    });
});

describe('/api/auth/me platformModel', () => {
    it('reports whether the deployment supplies the model', async () => {
        for (const platformModelProvided of [false, true]) {
            const b = await boot({ platformModelProvided });
            const me = await b.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: b.memberCookie } });
            expect(me.json()).toMatchObject({ platformModel: platformModelProvided });
        }
    });
});
