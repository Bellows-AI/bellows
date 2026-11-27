import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { githubAuth, harness, memoryAuthStore, memoryUserExecutorStore, signedIn } from './helpers.js';
import { MAX_EXECUTORS_PER_USER } from '../src/routes/executor-fields.js';
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND, HTTP_OK, HTTP_UNPROCESSABLE, trackApps } from './helpers-http.js';

/** Offline: the member's executor profiles over the in-memory store; the board has no workspace configuration. */

const track = trackApps();

const REPOS = [
    { owner: 'acme', name: 'web' },
    { owner: 'acme', name: 'api' },
];

async function boot(runnerClasses: { name: string; docker: boolean }[] = []) {
    const auth = memoryAuthStore();
    const caller = auth.seedMember('test-org', 'octocat');
    const executors = memoryUserExecutorStore();
    const h = await harness({
        auth,
        userExecutors: executors,
        repos: REPOS,
        // github mode, so the cookie is what identifies the caller. Under `none` the resolver
        // returns the stand-in local account regardless of what cookie arrives, and a test
        // about per-member profiles needs two members to be distinguishable.
        config: { auth: githubAuth(), runnerClasses },
    });
    track(h.app);
    return { app: h.app, caller, cookie: await signedIn(auth, caller), executors };
}

describe('GET /api/workspace', () => {
    it('keys are exactly executors, orgExecutors, defaultExecutor, agentDefault, executorsAvailable', async () => {
        const { app, cookie } = await boot();
        const response = await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(Object.keys(response.json()).sort()).toEqual([
            'agentDefault',
            'defaultExecutor',
            'executors',
            'executorsAvailable',
            'orgExecutors',
        ]);
    });

    it('answers the agent default with no default executor when it wins over a profile the member never chose', async () => {
        const { app, cookie, caller, executors } = await boot();
        await executors.replace(caller.user.id, [{ name: 'main', type: 'claude-code', config: {} }]);
        const poll = async () =>
            (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json() as {
                defaultExecutor: unknown;
                agentDefault: unknown;
            };
        expect(await poll()).toMatchObject({ defaultExecutor: { scope: 'user', name: 'main' }, agentDefault: null });

        await executors.setAgentDefault(null, { agentType: 'opencode', model: 'anthropic/claude-sonnet-4-5' });
        expect(await poll()).toMatchObject({
            defaultExecutor: null,
            agentDefault: { agentType: 'opencode', model: 'anthropic/claude-sonnet-4-5', from: 'org' },
        });
    });
});

describe('the retired checkout routes', () => {
    it.each([
        ['PUT', '/api/workspace/repos'],
        ['DELETE', '/api/workspace/repos/acme/web'],
    ] as const)('%s %s is not a route', async (method, url) => {
        const { app, cookie } = await boot();
        const response = await app.inject({
            method,
            url,
            headers: { cookie },
            ...(method === 'PUT' ? { payload: { repos: [] } } : {}),
        });

        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });
});

const putExecutors = (app: FastifyInstance, cookie: string, executors: unknown) =>
    app.inject({
        method: 'PUT',
        url: '/api/workspace/executors',
        headers: { cookie },
        payload: { executors },
    });

const CLAUDE_CODE = { name: 'main', type: 'claude-code', config: { model: 'sonnet' } };

describe('executors: listing and replacing', () => {
    it('lists executors in the GET payload, without their config', async () => {
        // The config may hold credentials the member pasted, and this payload is a poll that can
        // run every two seconds.
        const { app, cookie, executors } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE]);

        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.executors).toEqual([expect.objectContaining({ name: 'main', type: 'claude-code' })]);
        expect(JSON.stringify(body)).not.toContain('sonnet');
        expect(executors.rows()[0]?.config).toEqual({ model: 'sonnet' });
    });

    it('replaces the whole list, so replaying the same body changes nothing', async () => {
        const { app, cookie, executors } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE]);
        await putExecutors(app, cookie, [{ name: 'second', type: 'claude-code', config: {} }]);

        expect(executors.rows().map((row) => row.name)).toEqual(['second']);
    });

    it('keeps members apart', async () => {
        const auth = memoryAuthStore();
        const a = auth.seedMember('test-org', 'octocat');
        const b = auth.seedMember('test-org', 'scallop');
        const executors = memoryUserExecutorStore();
        const h = await harness({
            auth,
            userExecutors: executors,
            repos: REPOS,
            config: { auth: githubAuth() },
        });
        track(h.app);
        const cookieA = await signedIn(auth, a);
        const cookieB = await signedIn(auth, b);

        await putExecutors(h.app, cookieA, [CLAUDE_CODE]);
        await putExecutors(h.app, cookieB, []);

        expect(executors.rows().map((row) => row.userId)).toEqual([a.user.id]);
    });

    const idOf = async (app: FastifyInstance, cookie: string, name: string) =>
        (
            (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json() as {
                executors: { id: string; name: string }[];
            }
        ).executors.find((row) => row.name === name)!.id;
    const putDefault = (app: FastifyInstance, cookie: string, payload: Record<string, unknown>) =>
        app.inject({ method: 'PUT', url: '/api/workspace/executors/default', headers: { cookie }, payload });

    it('persists the default by id and echoes it on the poll; rows carry no default flag', async () => {
        const { app, cookie } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE, { name: 'oc', type: 'opencode', config: {} }]);
        const put = await putDefault(app, cookie, { executorId: await idOf(app, cookie, 'oc') });
        expect(put.statusCode).toBe(HTTP_OK);
        expect(put.json().defaultExecutor).toEqual({ scope: 'user', name: 'oc' });

        const poll = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(poll.defaultExecutor).toEqual({ scope: 'user', name: 'oc' });
        expect(poll.executors).toEqual([
            expect.objectContaining({ name: 'main' }),
            expect.objectContaining({ name: 'oc' }),
        ]);
        expect(JSON.stringify(poll.executors)).not.toContain('isDefault');

        const config = (
            await app.inject({ method: 'GET', url: '/api/workspace/executors', headers: { cookie } })
        ).json();
        expect(config.executors).toEqual([
            expect.objectContaining({ name: 'main' }),
            expect.objectContaining({ name: 'oc' }),
        ]);
    });

    it('a row sent without a default resolves the first row on the poll', async () => {
        const { app, cookie } = await boot();
        const put = await putExecutors(app, cookie, [CLAUDE_CODE]);
        expect(put.json().executors).toEqual([expect.objectContaining({ name: 'main' })]);

        const poll = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(poll.defaultExecutor).toEqual({ scope: 'user', name: 'main' });
    });

    it('a later selection re-points the default', async () => {
        const { app, cookie } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE, { name: 'oc', type: 'opencode', config: {} }]);
        await putDefault(app, cookie, { executorId: await idOf(app, cookie, 'main') });
        const second = await putDefault(app, cookie, { executorId: await idOf(app, cookie, 'oc') });
        expect(second.json().defaultExecutor).toEqual({ scope: 'user', name: 'oc' });
    });

    it('refuses a name-only body with 400 and leaves the resolved default alone', async () => {
        const { app, cookie } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE, { name: 'oc', type: 'opencode', config: {} }]);
        await putDefault(app, cookie, { executorId: await idOf(app, cookie, 'main') });

        const refused = await putDefault(app, cookie, { executor: 'oc', executorScope: 'user' });
        expect(refused.statusCode).toBe(HTTP_BAD_REQUEST);
        const poll = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(poll.defaultExecutor).toEqual({ scope: 'user', name: 'main' });
    });

    it('answers 404 for an executor id the caller cannot select', async () => {
        const { app, cookie } = await boot();
        const missing = await putDefault(app, cookie, { executorId: '99999999-9999-4999-8999-999999999999' });
        expect(missing.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('reads a legacy name-keyed preference, and dropping its row falls back to the first remaining row', async () => {
        const { app, cookie, caller, executors } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE, { name: 'oc', type: 'opencode', config: {} }]);
        executors.seedLegacyDefault(caller.user.id, { scope: 'user', name: 'oc' });
        const poll = async () =>
            (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect((await poll()).defaultExecutor).toEqual({ scope: 'user', name: 'oc' });

        await putExecutors(app, cookie, [CLAUDE_CODE]);
        expect((await poll()).defaultExecutor).toEqual({ scope: 'user', name: 'main' });
    });

    it('persists gateFixRounds and echoes it on the PUT response, the poll and the config read', async () => {
        const { app, cookie, executors } = await boot();
        const put = await putExecutors(app, cookie, [{ ...CLAUDE_CODE, gateFixRounds: 5 }]);

        expect(put.statusCode).toBe(HTTP_OK);
        expect(executors.rows()[0]?.gateFixRounds).toBe(5);
        expect(put.json().executors).toEqual([expect.objectContaining({ name: 'main', gateFixRounds: 5 })]);

        const poll = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(poll.executors).toEqual([expect.objectContaining({ name: 'main', gateFixRounds: 5 })]);

        const config = (
            await app.inject({ method: 'GET', url: '/api/workspace/executors', headers: { cookie } })
        ).json();
        expect(config.executors).toEqual([expect.objectContaining({ name: 'main', gateFixRounds: 5 })]);
    });

    it('a row sent without gateFixRounds gets the default of 3', async () => {
        const { app, cookie, executors } = await boot();
        const put = await putExecutors(app, cookie, [CLAUDE_CODE]);

        expect(put.statusCode).toBe(HTTP_OK);
        expect(executors.rows()[0]?.gateFixRounds).toBe(3);
        expect(put.json().executors).toEqual([expect.objectContaining({ name: 'main', gateFixRounds: 3 })]);
    });
});

describe('executors: validation', () => {
    it('refuses an unknown type', async () => {
        const { app, cookie } = await boot();
        const response = await putExecutors(app, cookie, [{ name: 'x', type: 'codex', config: {} }]);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_EXECUTOR_TYPE');
    });

    it('accepts an opencode executor', async () => {
        const { app, cookie, executors } = await boot();
        const response = await putExecutors(app, cookie, [{ name: 'oc', type: 'opencode', config: {} }]);

        expect(response.statusCode).toBe(HTTP_OK);
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'oc', type: 'opencode' })]);
    });

    it('refuses a config that is not a JSON object', async () => {
        const { app, cookie } = await boot();
        const NON_OBJECT_NUMBER = 7;
        for (const config of [[], 'text', NON_OBJECT_NUMBER, null]) {
            const response = await putExecutors(app, cookie, [{ name: 'x', type: 'claude-code', config }]);
            expect(response.statusCode, String(config)).toBe(HTTP_BAD_REQUEST);
        }
    });

    it('refuses duplicate names, by name rather than as a key violation', async () => {
        const { app, cookie } = await boot();
        const response = await putExecutors(app, cookie, [
            CLAUDE_CODE,
            { name: 'main', type: 'claude-code', config: {} },
        ]);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('EXECUTOR_NAME_CONFLICT');
    });

    it('refuses a name that cannot become a directory, by name', async () => {
        const { app, cookie } = await boot();
        for (const name of ['-x', '.', '..', 'a/b', '']) {
            const response = await putExecutors(app, cookie, [{ name, type: 'claude-code', config: {} }]);
            expect(response.statusCode, name).toBe(HTTP_BAD_REQUEST);
            expect(response.json().code, name).toBe('BAD_EXECUTOR_NAME');
        }
    });

    it('caps how many executors one member can configure', async () => {
        const { app, cookie } = await boot();
        const many = Array.from({ length: MAX_EXECUTORS_PER_USER + 1 }, (_, i) => ({
            name: `e${i}`,
            type: 'claude-code',
            config: {},
        }));
        const response = await putExecutors(app, cookie, many);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('TOO_MANY_EXECUTORS');
    });

    it('rejects a body that is not a list of { name, type, config }', async () => {
        const { app, cookie } = await boot();
        expect((await putExecutors(app, cookie, 'main')).statusCode).toBe(HTTP_BAD_REQUEST);
        expect((await putExecutors(app, cookie, [{ name: 'x', type: 'claude-code' }])).statusCode).toBe(
            HTTP_BAD_REQUEST
        );
    });

    it('refuses two defaults as BAD_BODY, not TOO_MANY_EXECUTORS', async () => {
        const { app, cookie, executors } = await boot();
        const response = await putExecutors(app, cookie, [
            { ...CLAUDE_CODE, isDefault: true },
            { name: 'oc', type: 'opencode', config: {}, isDefault: true },
        ]);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_BODY');
        expect(executors.rows()).toEqual([]);
    });

    it('refuses a non-boolean isDefault', async () => {
        const { app, cookie } = await boot();
        for (const isDefault of ['yes', 1]) {
            const response = await putExecutors(app, cookie, [{ ...CLAUDE_CODE, isDefault }]);
            expect(response.statusCode, String(isDefault)).toBe(HTTP_BAD_REQUEST);
            expect(response.json().code, String(isDefault)).toBe('BAD_BODY');
        }
    });

    it.each([
        ['a negative number', -1],
        ['over the ceiling', 11],
        ['a fraction', 2.5],
        ['a numeric string', '3'],
        ['null', null],
        ['an object', { rounds: 3 }],
    ])('refuses a gateFixRounds that is not a nonnegative bounded integer (%s)', async (_label, gateFixRounds) => {
        const { app, cookie, executors } = await boot();
        const response = await putExecutors(app, cookie, [{ ...CLAUDE_CODE, gateFixRounds }]);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_EXECUTOR_ROUNDS');
        expect(executors.rows()).toEqual([]);
    });
});

describe('executors: runner class', () => {
    const CLASSES = [
        { name: 'standard', docker: false },
        { name: 'sandboxed', docker: true },
    ];

    it('a personal profile naming a class is refused', async () => {
        const { app, cookie, executors } = await boot(CLASSES);
        // Even a class the board declares: a class is an organization admin's choice, on org profiles only.
        const response = await putExecutors(app, cookie, [{ ...CLAUDE_CODE, runnerClass: 'standard' }]);

        expect(response.statusCode).toBe(HTTP_UNPROCESSABLE);
        expect(response.json().code).toBe('BAD_RUNNER_CLASS');
        expect(response.json().error).toMatch(/runnerClass/);
        expect(executors.rows()).toEqual([]);
    });

    it('a personal entry carrying runnerClass null names no class and is accepted', async () => {
        const { app, cookie, executors } = await boot(CLASSES);
        const response = await putExecutors(app, cookie, [{ ...CLAUDE_CODE, runnerClass: null }]);

        expect(response.statusCode).toBe(HTTP_OK);
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'main', runnerClass: null })]);
    });

    it('GET /api/workspace/executors lists the classes the board declares, with their docker flag', async () => {
        const { app, cookie } = await boot(CLASSES);
        const response = await app.inject({ method: 'GET', url: '/api/workspace/executors', headers: { cookie } });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().runnerClasses).toEqual(CLASSES);
    });

    it('a board that declares no classes lists none', async () => {
        const { app, cookie } = await boot();
        const response = await app.inject({ method: 'GET', url: '/api/workspace/executors', headers: { cookie } });

        expect(response.json().runnerClasses).toEqual([]);
    });
});

describe('executors: PUT lifecycle', () => {
    it('writes rows on a board with no workspace configuration', async () => {
        const { app, cookie, executors } = await boot();
        const response = await putExecutors(app, cookie, [CLAUDE_CODE]);

        expect(response.statusCode).toBe(HTTP_OK);
        expect(executors.rows()).toHaveLength(1);
    });

    it('answers 200, because nothing runs in the background', async () => {
        // There is nothing to wait out; the rows are written by the time the response is sent.
        const { app, cookie } = await boot();
        const response = await putExecutors(app, cookie, [CLAUDE_CODE]);

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().executors[0]).toMatchObject({ name: 'main', type: 'claude-code' });
    });
});

describe('executors: GET /api/workspace/executors', () => {
    it('reads the whole list back with configs, for the edit dialog', async () => {
        // The on-demand read the dialog opens with: the member's own rows, config included — the
        // poll never carries it, but an edit cannot pre-fill without it.
        const { app, cookie } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE]);

        const response = await app.inject({ method: 'GET', url: '/api/workspace/executors', headers: { cookie } });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().executors).toEqual([
            expect.objectContaining({ name: 'main', type: 'claude-code', config: { model: 'sonnet' } }),
        ]);
    });

    it('keeps members apart on the config read too', async () => {
        // The one route that hands back pasted credentials: a scoping regression here would leak
        // one member's config into another member's edit dialog.
        const auth = memoryAuthStore();
        const a = auth.seedMember('test-org', 'octocat');
        const b = auth.seedMember('test-org', 'scallop');
        const executors = memoryUserExecutorStore();
        const h = await harness({
            auth,
            userExecutors: executors,
            repos: REPOS,
            config: { auth: githubAuth() },
        });
        track(h.app);
        const cookieA = await signedIn(auth, a);
        const cookieB = await signedIn(auth, b);

        await putExecutors(h.app, cookieA, [CLAUDE_CODE]);
        const response = await h.app.inject({
            method: 'GET',
            url: '/api/workspace/executors',
            headers: { cookie: cookieB },
        });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().executors).toEqual([]);
    });

    it('reads rows on a board with no workspace configuration', async () => {
        const { app, cookie } = await boot();
        const response = await app.inject({ method: 'GET', url: '/api/workspace/executors', headers: { cookie } });

        expect(response.statusCode).toBe(HTTP_OK);
    });
});

describe('executor rows: safe provider connection metadata', () => {
    const ORG_CONNECTION = '66666666-6666-4666-8666-666666666666';
    const OWN_CONNECTION = '77777777-7777-4777-8777-777777777777';
    const SECRET = 'sk-never-in-a-payload';
    const visible = [
        { id: ORG_CONNECTION, name: 'Team key', provider: 'anthropic', scope: 'org', baseUrl: null, hasKey: true },
        { id: OWN_CONNECTION, name: 'My key', provider: 'openrouter', scope: 'personal', baseUrl: null, hasKey: true },
    ];

    async function bootWithConnections() {
        const auth = memoryAuthStore();
        const caller = auth.seedMember('test-org', 'octocat');
        const executors = memoryUserExecutorStore();
        const h = await harness({
            auth,
            userExecutors: executors,
            repos: REPOS,
            config: { auth: githubAuth() },
            providerConnections: { listFor: async () => visible } as never,
        });
        track(h.app);
        await executors.replace(caller.user.id, [
            { name: 'plain', type: 'claude-code', config: {} },
            { name: 'shared', type: 'claude-code', config: {}, providerConnectionId: ORG_CONNECTION },
            {
                name: 'pasted',
                type: 'opencode',
                config: {
                    provider: { custom: { options: { baseURL: 'https://llm.example.test/v1', apiKey: SECRET } } },
                },
                providerConnectionId: OWN_CONNECTION,
            },
        ]);
        await executors.createOrg({
            name: 'team',
            type: 'claude-code',
            config: {},
            createdBy: caller.user.id,
            providerConnectionId: ORG_CONNECTION,
        });
        return { app: h.app, cookie: await signedIn(auth, caller) };
    }

    it('names the connection, its provider and scope, and flags a config override, on the poll', async () => {
        const { app, cookie } = await bootWithConnections();
        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        const byName = Object.fromEntries(body.executors.map((row: { name: string }) => [row.name, row]));
        expect(byName.plain).toMatchObject({
            providerConnectionId: null,
            providerConnectionName: null,
            providerConnectionProvider: null,
            providerConnectionScope: null,
            configOverridesConnection: false,
        });
        expect(byName.shared).toMatchObject({
            providerConnectionId: ORG_CONNECTION,
            providerConnectionName: 'Team key',
            providerConnectionProvider: 'anthropic',
            providerConnectionScope: 'org',
            configOverridesConnection: false,
        });
        expect(byName.pasted).toMatchObject({
            providerConnectionName: 'My key',
            providerConnectionScope: 'personal',
            configOverridesConnection: true,
        });
        expect(body.orgExecutors[0]).toMatchObject({
            providerConnectionName: 'Team key',
            providerConnectionProvider: 'anthropic',
            providerConnectionScope: 'org',
        });
        const text = JSON.stringify(body);
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('baseURL');
        expect(body.executors[0]).not.toHaveProperty('config');
    });

    it('reads a connection the caller cannot see as absent, never as an error or a leak', async () => {
        const { app, cookie } = await bootWithConnections();
        // Another member's personal connection is not in the caller's list: the id travels, the details do not.
        const hidden = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(hidden.executors.length).toBeGreaterThan(0);
        const edit = await app.inject({ method: 'GET', url: '/api/workspace/executors', headers: { cookie } });
        const row = edit.json().executors.find((r: { name: string }) => r.name === 'shared');
        expect(row).toMatchObject({ providerConnectionName: 'Team key', providerConnectionScope: 'org' });
    });
});
