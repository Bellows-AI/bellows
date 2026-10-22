import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { githubAuth, harness, memoryAuthStore, memoryUserExecutorStore, signedIn } from './helpers.js';
import { MAX_EXECUTORS_PER_USER } from '../src/routes/executor-fields.js';
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND, HTTP_OK, trackApps } from './helpers-http.js';

/** Offline: the member's executor profiles over the in-memory store; the board has no workspace configuration. */

const track = trackApps();

const REPOS = [
    { owner: 'acme', name: 'web' },
    { owner: 'acme', name: 'api' },
];

async function boot() {
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
        config: { auth: githubAuth() },
    });
    track(h.app);
    return { app: h.app, caller, cookie: await signedIn(auth, caller), executors };
}

describe('GET /api/workspace', () => {
    it('keys are exactly executors, orgExecutors, defaultExecutor', async () => {
        const { app, cookie } = await boot();
        const response = await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(Object.keys(response.json()).sort()).toEqual(['defaultExecutor', 'executors', 'orgExecutors']);
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

    it('persists the preference and echoes it on the poll; rows carry no default flag', async () => {
        // Issue 391: the default is a per-member preference naming a scope, not a flag on a row —
        // one org row is shared by every member, so the flag had to move off the row.
        const { app, cookie } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE, { name: 'oc', type: 'opencode', config: {} }]);
        const put = await app.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie },
            payload: { executor: 'oc', executorScope: 'user' },
        });
        expect(put.statusCode).toBe(HTTP_OK);
        expect(put.json().defaultExecutor).toEqual({ scope: 'user', name: 'oc' });

        const poll = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(poll.defaultExecutor).toEqual({ scope: 'user', name: 'oc' });
        expect(poll.executors).toEqual([
            expect.objectContaining({ name: 'main' }),
            expect.objectContaining({ name: 'oc' }),
        ]);
        // No row carries a default flag any more — the preference is the whole mechanism.
        expect(JSON.stringify(poll.executors)).not.toContain('isDefault');

        const config = (
            await app.inject({ method: 'GET', url: '/api/workspace/executors', headers: { cookie } })
        ).json();
        expect(config.executors).toEqual([
            expect.objectContaining({ name: 'main' }),
            expect.objectContaining({ name: 'oc' }),
        ]);
    });

    it('a row sent without a preference resolves the first row on the poll', async () => {
        const { app, cookie } = await boot();
        const put = await putExecutors(app, cookie, [CLAUDE_CODE]);
        expect(put.json().executors).toEqual([expect.objectContaining({ name: 'main' })]);

        const poll = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(poll.defaultExecutor).toEqual({ scope: 'user', name: 'main' });
    });

    it('a later preference move re-points the default', async () => {
        const { app, cookie } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE, { name: 'oc', type: 'opencode', config: {} }]);
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie },
            payload: { executor: 'main', executorScope: 'user' },
        });
        const second = await app.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie },
            payload: { executor: 'oc', executorScope: 'user' },
        });
        expect(second.json().defaultExecutor).toEqual({ scope: 'user', name: 'oc' });
    });

    it('dropping the preferred row falls back to the first remaining row, never a ghost', async () => {
        const { app, cookie } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE, { name: 'oc', type: 'opencode', config: {} }]);
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie },
            payload: { executor: 'main', executorScope: 'user' },
        });
        await putExecutors(app, cookie, [{ name: 'oc', type: 'opencode', config: {} }]);

        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.defaultExecutor).toEqual({ scope: 'user', name: 'oc' });
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
