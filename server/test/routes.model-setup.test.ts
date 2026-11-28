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
                    connectionId: 'connection-1',
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
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const EXECUTOR_ID = '22222222-2222-4222-8222-222222222222';

describe('GET /api/model-setup', () => {
    it('answers nothing configured on a fresh board', async () => {
        const b = await boot();
        const response = await get(b, b.memberCookie);
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ org: null, personal: null, effective: null });
    });

    it('shows a saved personal setup by names only, the personal scope effective', async () => {
        const b = await boot();
        await b.envVars.replaceWorkspace(b.member.user.id, [
            { name: 'ANTHROPIC_API_KEY', value: ANTHROPIC_KEY, isSecret: true },
        ]);

        const response = await get(b, b.memberCookie);
        expect(response.json()).toEqual({
            org: null,
            personal: {
                provider: 'anthropic',
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
            org: { provider: 'openrouter', keyNames: ['OPENROUTER_API_KEY'] },
            personal: null,
            effective: 'org',
        });
    });

    it('is a 503, never "nothing configured", when the env read fails', async () => {
        const b = await boot();
        b.envVars.listWorkspace = async () => {
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
        updatedAt: '2026-01-02T03:04:05.678Z',
        connection: { id: 'connection-1', name: 'Anthropic', provider: 'anthropic', scope: 'org', baseUrl: null },
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

    it('answers the stable identities and never the key, and writes no env row', async () => {
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
        expect(b.setup.commands[0]).toMatchObject({
            requestId: 'request-1',
            connection: {
                intent: 'create',
                provider: 'anthropic',
                key: ANTHROPIC_KEY,
                name: 'Anthropic',
                baseUrl: null,
            },
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

    it('saves a subscription token in cloud for an org the operator lists, and refuses it for another', async () => {
        const body = withConnection({
            intent: 'create',
            provider: 'subscription',
            key: 'sk-ant-oat-test',
            name: 'Sub',
        });
        const listed = await boot({ deploymentMode: 'cloud', cloudSubscriptionOrgIds: new Set(['test-org']) });
        const saved = await put(listed, listed.memberCookie, body);
        expect(saved.statusCode).toBe(HTTP_OK);
        expect(listed.setup.commands).toHaveLength(1);
        const other = await boot({ deploymentMode: 'cloud', cloudSubscriptionOrgIds: new Set(['other-org']) });
        expect((await put(other, other.memberCookie, body)).json().code).toBe('CLOUD_CREDENTIAL_REFUSED');
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
            withConnection({ intent: 'reuse', id: CONNECTION_ID, key: 'sk-x' }),
            // An id that is not a row id never reaches a uuid column.
            withConnection({ intent: 'reuse', id: 'not-a-uuid' }),
            withConnection({ intent: 'rotate', id: 'not-a-uuid', key: 'sk-x' }),
            withConnection({ intent: 'none' }),
            withConnection({ intent: 'none', key: 'sk-x' }),
            withConnection({ intent: 'rotate', id: CONNECTION_ID, key: 'has space' }),
            withConnection({ intent: 'create', provider: 'anthropic', key: 'sk-x' }),
            { ...anthropicPersonal, executor: { name: 'Claude', id: '' } },
            { ...anthropicPersonal, executor: { id: 'not-a-uuid' } },
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
                { intent: 'reuse', id: CONNECTION_ID },
                { executor: { id: EXECUTOR_ID, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' } }
            )
        );
        await put(b, b.memberCookie, withConnection({ intent: 'rotate', id: CONNECTION_ID, key: 'sk-ant-new' }));
        expect(b.setup.commands.map((c) => c.connection.intent)).toEqual(['reuse', 'rotate']);
        expect(b.setup.commands[0]?.executor).toMatchObject({
            id: EXECUTOR_ID,
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

        b.setup.fail = new ExecutorConnectionRefusedError(
            'scope',
            'An organization executor can only use an organization provider connection.'
        );
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

describe('/api/auth/me platformModel', () => {
    it('reports whether the deployment supplies the model', async () => {
        for (const platformModelProvided of [false, true]) {
            const b = await boot({ platformModelProvided });
            const me = await b.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: b.memberCookie } });
            expect(me.json()).toMatchObject({ platformModel: platformModelProvided });
        }
    });
});
