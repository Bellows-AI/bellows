import { describe, expect, it } from 'vitest';
import { connectionSelectionRefusal, type SelectedConnection } from '@factory-ai/core';
import { buildApp } from '../src/app.js';
import { bridgedRequestClass } from '../src/auth/bridge-binding.js';
import type { AppConfig } from '../src/config.js';
import type { AuthStore } from '../src/auth/store.js';
import { MAX_EXECUTORS_PER_ORG, MAX_EXECUTORS_PER_USER } from '../src/routes/executor-fields.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryUserExecutorStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';
import type { MemoryUserExecutorStore } from './helpers-user-executor-store.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CONFLICT,
    HTTP_CREATED,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_OK,
    HTTP_UNAVAILABLE,
    HTTP_UNPROCESSABLE,
    trackApps,
} from './helpers-http.js';

/**
 * Offline: the HTTP contract of the organization-scoped executor routes (issue 391) against the
 * in-memory store double. The store's own rules — the per-scope name index, the preference
 * fallback chain — are covered by server/test-db/user-executor-store.test.ts, which needs a
 * container.
 */

const track = trackApps();

const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const CLAUDE_CODE = {
    name: 'team-runner',
    type: 'claude-code',
    config: { model: 'sonnet' },
    providerConnectionId: CONNECTION_ID,
};

async function boot(
    executors: MemoryUserExecutorStore = memoryUserExecutorStore(),
    overrides: Partial<AppConfig> = {},
    providerConnections?: Parameters<typeof staticRegistry>[0] extends infer P
        ? P extends { providerConnections?: infer C }
            ? C
            : never
        : never
) {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const config = testConfig({ auth: githubAuth(), ...overrides });
    const instance = await build(executors, auth, config, providerConnections);
    track(instance);
    return {
        instance,
        admin,
        member,
        executors,
        adminCookie: await signedIn(auth, admin),
        memberCookie: await signedIn(auth, member),
    };
}

/** Boots the app with the given executor store. */
function build(
    executors: MemoryUserExecutorStore,
    auth: AuthStore,
    config: AppConfig,
    providerConnections?: Parameters<typeof boot>[2]
) {
    return buildApp({
        config,
        orgs: staticRegistry({
            config,
            userExecutors: executors,
            providerConnections,
            telemetry: stubTelemetryClient(),
        }),
        auth,
    });
}

describe('organization executors: permissions', () => {
    it('a member reads selection metadata, never the configuration', async () => {
        const { instance, adminCookie, memberCookie } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });

        const response = await instance.inject({
            method: 'GET',
            url: '/api/org/executors',
            headers: { cookie: memberCookie },
        });
        expect(response.statusCode).toBe(HTTP_OK);
        const body = response.json();
        expect(body.executors).toEqual([expect.objectContaining({ name: 'team-runner', type: 'claude-code' })]);
        // The config may hold provider credentials: members get the fact a profile exists and
        // what it launches, never the payload.
        expect(JSON.stringify(body)).not.toContain('sonnet');
        expect(body.executors[0].config).toBeUndefined();
    });

    it('an admin reads the full configuration', async () => {
        const { instance, adminCookie } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });

        const body = (
            await instance.inject({ method: 'GET', url: '/api/org/executors', headers: { cookie: adminCookie } })
        ).json();
        expect(body.executors).toEqual([
            expect.objectContaining({
                name: 'team-runner',
                config: { model: 'sonnet' },
                createdBy: expect.any(String),
            }),
        ]);
    });

    it('non-admin mutations return 403 and leave the data unchanged', async () => {
        const { instance, adminCookie, memberCookie, executors } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        const id = executors.rows()[0]!.id;

        for (const request of [
            { method: 'POST', url: '/api/org/executors', payload: { ...CLAUDE_CODE, name: 'other' } },
            { method: 'PUT', url: `/api/org/executors/${id}`, payload: { ...CLAUDE_CODE, name: 'renamed' } },
            { method: 'DELETE', url: `/api/org/executors/${id}` },
            { method: 'POST', url: `/api/org/executors/${id}/scope`, payload: { scope: 'user' } },
        ] as const) {
            const response = await instance.inject({ ...request, headers: { cookie: memberCookie } });
            expect(response.statusCode, `${request.method} ${request.url}`).toBe(HTTP_FORBIDDEN);
            expect(response.json().code).toBe('FORBIDDEN');
        }
        // Every refusal left the org row exactly as the admin wrote it.
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'team-runner', userId: null })]);
    });

    it('a member cannot promote their own personal profile — 403, rows untouched', async () => {
        const { instance, memberCookie, member, executors } = await boot();
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: memberCookie },
            payload: {
                executors: [{ name: 'mine', type: 'claude-code', config: {}, providerConnectionId: CONNECTION_ID }],
            },
        });
        const personal = executors.rows().find((row) => row.userId === member.user.id)!;

        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${personal.id}/scope`,
            headers: { cookie: memberCookie },
            payload: { scope: 'org' },
        });
        expect(response.statusCode).toBe(HTTP_FORBIDDEN);
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'mine', userId: member.user.id })]);
    });

    it('a whole-list replacement attempt on the org scope is refused — the org scope has no list PUT', async () => {
        // The personal PUT is the caller's own list; an org-shaped entry in it is a tamper attempt
        // against the shared scope and refuses loudly rather than being rewritten.
        const { instance, adminCookie, memberCookie, executors } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });

        for (const [label, cookie, entries] of [
            ['member', memberCookie, [{ ...CLAUDE_CODE, scope: 'org' }]],
            ['admin', adminCookie, [{ ...CLAUDE_CODE, scope: 'org' }]],
            [
                'userId tamper',
                memberCookie,
                [
                    {
                        name: 'x',
                        type: 'claude-code',
                        config: {},
                        providerConnectionId: CONNECTION_ID,
                        userId: '00000000-0000-4000-8000-000000000000',
                    },
                ],
            ],
        ] as const) {
            const response = await instance.inject({
                method: 'PUT',
                url: '/api/workspace/executors',
                headers: { cookie },
                payload: { executors: entries },
            });
            expect(response.statusCode, label).toBe(HTTP_BAD_REQUEST);
        }
        // The org row was never touched by any of those PUTs.
        expect(executors.rows().filter((row) => row.userId === null)).toHaveLength(1);
    });
});

describe('organization executors: admin CRUD', () => {
    it('creates an org profile and answers it with its config', async () => {
        const { instance, adminCookie, executors } = await boot();
        const response = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: { ...CLAUDE_CODE, gateFixRounds: 5 },
        });

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(response.json()).toEqual(
            expect.objectContaining({ name: 'team-runner', config: { model: 'sonnet' }, gateFixRounds: 5 })
        );
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'team-runner', userId: null })]);
    });

    it('edits and deletes by id', async () => {
        const { instance, adminCookie, executors } = await boot();
        const created = (
            await instance.inject({
                method: 'POST',
                url: '/api/org/executors',
                headers: { cookie: adminCookie },
                payload: CLAUDE_CODE,
            })
        ).json();
        const id = created.id as string;

        const renamed = await instance.inject({
            method: 'PUT',
            url: `/api/org/executors/${id}`,
            headers: { cookie: adminCookie },
            payload: {
                name: 'renamed',
                type: 'claude-code',
                config: { model: 'opus' },
                gateFixRounds: 1,
                providerConnectionId: CONNECTION_ID,
            },
        });
        expect(renamed.statusCode).toBe(HTTP_OK);
        expect(renamed.json()).toEqual(expect.objectContaining({ name: 'renamed', config: { model: 'opus' } }));

        const removed = await instance.inject({
            method: 'DELETE',
            url: `/api/org/executors/${id}`,
            headers: { cookie: adminCookie },
        });
        expect(removed.statusCode).toBe(HTTP_OK);
        expect(executors.rows()).toEqual([]);
    });

    it('answers 404 for an id that names no org row', async () => {
        const { instance, adminCookie } = await boot();
        const ghost = '99999999-9999-4999-8999-999999999999';
        expect(
            (
                await instance.inject({
                    method: 'PUT',
                    url: `/api/org/executors/${ghost}`,
                    headers: { cookie: adminCookie },
                    payload: CLAUDE_CODE,
                })
            ).statusCode
        ).toBe(HTTP_NOT_FOUND);
        expect(
            (
                await instance.inject({
                    method: 'DELETE',
                    url: `/api/org/executors/${ghost}`,
                    headers: { cookie: adminCookie },
                })
            ).statusCode
        ).toBe(HTTP_NOT_FOUND);
    });

    it('refuses a duplicate org name with 409', async () => {
        const { instance, adminCookie } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        const response = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: { ...CLAUDE_CODE, config: {} },
        });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('NAME_TAKEN');
    });

    it('a personal row of the same name is not a conflict', async () => {
        const { instance, adminCookie } = await boot();
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: {
                executors: [{ name: 'team-runner', type: 'opencode', config: {}, providerConnectionId: CONNECTION_ID }],
            },
        });
        const response = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        expect(response.statusCode).toBe(HTTP_CREATED);
    });

    it('caps the org list', async () => {
        const { instance, adminCookie } = await boot();
        for (let i = 0; i < MAX_EXECUTORS_PER_ORG; i += 1) {
            const response = await instance.inject({
                method: 'POST',
                url: '/api/org/executors',
                headers: { cookie: adminCookie },
                payload: {
                    name: `executor-${i}`,
                    type: 'claude-code',
                    config: {},
                    providerConnectionId: CONNECTION_ID,
                },
            });
            expect(response.statusCode).toBe(HTTP_CREATED);
        }
        const over = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: { name: 'one-too-many', type: 'claude-code', config: {}, providerConnectionId: CONNECTION_ID },
        });
        expect(over.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(over.json().code).toBe('TOO_MANY_EXECUTORS');
    });

    it('validates the create body: type, name shape, config object, rounds', async () => {
        const { instance, adminCookie } = await boot();
        const refusals = [
            [{ name: 'x', type: 'codex', config: {}, providerConnectionId: CONNECTION_ID }, 'BAD_EXECUTOR_TYPE'],
            [
                { name: 'a/b', type: 'claude-code', config: {}, providerConnectionId: CONNECTION_ID },
                'BAD_EXECUTOR_NAME',
            ],
            [{ name: 'x', type: 'claude-code', config: 'text' }, 'BAD_BODY'],
            [{ name: 'x', type: 'claude-code', config: {}, gateFixRounds: 11 }, 'BAD_EXECUTOR_ROUNDS'],
        ] as const;
        for (const [payload, code] of refusals) {
            const response = await instance.inject({
                method: 'POST',
                url: '/api/org/executors',
                headers: { cookie: adminCookie },
                payload,
            });
            expect(response.statusCode, JSON.stringify(payload)).toBe(HTTP_BAD_REQUEST);
            expect(response.json().code).toBe(code);
        }
    });
});

describe('organization executors: runner class', () => {
    /** The board's declared classes (RUNNER_CLASSES): names and the docker flag only. */
    const CLASSES = {
        runnerClasses: [
            { name: 'standard', docker: false },
            { name: 'sandboxed', docker: true },
        ],
    };

    it('refuses a profile naming an undeclared class with an error naming `runnerClass`', async () => {
        const { instance, adminCookie, executors } = await boot(memoryUserExecutorStore(), CLASSES);
        const created = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: { ...CLAUDE_CODE, runnerClass: 'gpu' },
        });
        expect(created.statusCode).toBe(HTTP_UNPROCESSABLE);
        expect(created.json().code).toBe('BAD_RUNNER_CLASS');
        expect(created.json().error).toMatch(/runnerClass/);
        expect(created.json().error).toMatch(/standard, sandboxed/);
        expect(executors.rows()).toEqual([]);

        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        const id = executors.rows()[0]!.id;
        for (const runnerClass of ['gpu', 42, '']) {
            const edited = await instance.inject({
                method: 'PUT',
                url: `/api/org/executors/${id}`,
                headers: { cookie: adminCookie },
                payload: { ...CLAUDE_CODE, runnerClass },
            });
            expect(edited.statusCode, String(runnerClass)).toBe(HTTP_UNPROCESSABLE);
            expect(edited.json().code, String(runnerClass)).toBe('BAD_RUNNER_CLASS');
            expect(edited.json().error, String(runnerClass)).toMatch(/runnerClass/);
        }
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'team-runner' })]);
    });

    it('refuses any class on a board that declares none', async () => {
        const { instance, adminCookie, executors } = await boot();
        const created = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: { ...CLAUDE_CODE, runnerClass: 'standard' },
        });
        expect(created.statusCode).toBe(HTTP_UNPROCESSABLE);
        expect(created.json().code).toBe('BAD_RUNNER_CLASS');
        expect(created.json().error).toMatch(/runnerClass/);
        expect(executors.rows()).toEqual([]);
    });

    it('accepts a declared class', async () => {
        const { instance, adminCookie, memberCookie, executors } = await boot(memoryUserExecutorStore(), CLASSES);
        const created = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: { ...CLAUDE_CODE, runnerClass: 'sandboxed' },
        });
        expect(created.statusCode).toBe(HTTP_CREATED);
        expect(created.json().runnerClass).toBe('sandboxed');

        // Both the admin list and the members' selection metadata say which class a profile runs in.
        for (const cookie of [adminCookie, memberCookie]) {
            const listed = await instance.inject({ method: 'GET', url: '/api/org/executors', headers: { cookie } });
            expect(listed.json().executors).toEqual([expect.objectContaining({ runnerClass: 'sandboxed' })]);
        }
        const poll = await instance.inject({ method: 'GET', url: '/api/workspace', headers: { cookie: memberCookie } });
        expect(poll.json().orgExecutors).toEqual([expect.objectContaining({ runnerClass: 'sandboxed' })]);

        // An edit carries the whole entry: naming no class (or null) returns the profile to the default.
        const id = executors.rows()[0]!.id;
        const edited = await instance.inject({
            method: 'PUT',
            url: `/api/org/executors/${id}`,
            headers: { cookie: adminCookie },
            payload: { ...CLAUDE_CODE, runnerClass: null },
        });
        expect(edited.statusCode).toBe(HTTP_OK);
        expect(edited.json().runnerClass).toBeNull();
    });

    it('a non-admin cannot set runnerClass on an org profile', async () => {
        const { instance, adminCookie, memberCookie, executors } = await boot(memoryUserExecutorStore(), CLASSES);
        const refused = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: memberCookie },
            payload: { ...CLAUDE_CODE, runnerClass: 'sandboxed' },
        });
        expect(refused.statusCode).toBe(HTTP_FORBIDDEN);
        expect(executors.rows()).toEqual([]);

        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        const id = executors.rows()[0]!.id;
        const edit = await instance.inject({
            method: 'PUT',
            url: `/api/org/executors/${id}`,
            headers: { cookie: memberCookie },
            payload: { ...CLAUDE_CODE, runnerClass: 'sandboxed' },
        });
        expect(edit.statusCode).toBe(HTTP_FORBIDDEN);
        expect(executors.rows()).toEqual([expect.objectContaining({ runnerClass: null })]);
    });
});

describe('organization executors: scope changes', () => {
    it('an admin promotes their own personal row; the name is freed in the personal scope', async () => {
        const { instance, adminCookie, admin, executors } = await boot();
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: {
                executors: [
                    { name: 'mine', type: 'claude-code', config: { model: 'm' }, providerConnectionId: CONNECTION_ID },
                ],
            },
        });
        const personal = executors.rows().find((row) => row.userId === admin.user.id)!;

        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${personal.id}/scope`,
            headers: { cookie: adminCookie },
            payload: { scope: 'org' },
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(executors.rows()).toEqual([
            expect.objectContaining({ name: 'mine', userId: null, createdBy: admin.user.id }),
        ]);
    });

    it('an admin demotes an org row into their own personal list', async () => {
        const { instance, adminCookie, admin, executors } = await boot();
        const created = (
            await instance.inject({
                method: 'POST',
                url: '/api/org/executors',
                headers: { cookie: adminCookie },
                payload: CLAUDE_CODE,
            })
        ).json();

        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${created.id}/scope`,
            headers: { cookie: adminCookie },
            payload: { scope: 'user' },
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'team-runner', userId: admin.user.id })]);
    });

    it('a scope change colliding with a name in the target scope answers 409 and moves nothing', async () => {
        const { instance, adminCookie, executors } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: {
                executors: [{ name: 'team-runner', type: 'opencode', config: {}, providerConnectionId: CONNECTION_ID }],
            },
        });
        const orgRow = executors.rows().find((row) => row.userId === null)!;

        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${orgRow.id}/scope`,
            headers: { cookie: adminCookie },
            payload: { scope: 'user' },
        });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(executors.rows()).toEqual([
            expect.objectContaining({ name: 'team-runner', userId: null }),
            expect.objectContaining({ name: 'team-runner', userId: expect.any(String) }),
        ]);
    });

    it('a promotion into a full org list answers 400 and moves nothing', async () => {
        const { instance, adminCookie, admin, executors } = await boot();
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: {
                executors: [{ name: 'mine', type: 'claude-code', config: {}, providerConnectionId: CONNECTION_ID }],
            },
        });
        const personal = executors.rows().find((row) => row.userId === admin.user.id)!;
        for (let i = 0; i < MAX_EXECUTORS_PER_ORG; i += 1) {
            await instance.inject({
                method: 'POST',
                url: '/api/org/executors',
                headers: { cookie: adminCookie },
                payload: { name: `full-${i}`, type: 'claude-code', config: {}, providerConnectionId: CONNECTION_ID },
            });
        }

        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${personal.id}/scope`,
            headers: { cookie: adminCookie },
            payload: { scope: 'org' },
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('TOO_MANY_EXECUTORS');
        // Nothing moved: the personal row is still the caller's.
        expect(executors.rows().find((row) => row.name === 'mine')?.userId).toBe(admin.user.id);
    });

    it('a demotion into a full personal list answers 400 and moves nothing', async () => {
        const { instance, adminCookie, executors } = await boot();
        const created = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        const orgId = (created.json() as { id: string }).id;
        const mine = Array.from({ length: MAX_EXECUTORS_PER_USER }, (_, i) => ({
            name: `p-${i}`,
            type: 'claude-code',
            config: {},
            providerConnectionId: CONNECTION_ID,
        }));
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: { executors: mine },
        });

        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${orgId}/scope`,
            headers: { cookie: adminCookie },
            payload: { scope: 'user' },
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('TOO_MANY_EXECUTORS');
        // Nothing moved: the org row is still the organization's.
        expect(executors.rows().find((row) => row.id === orgId)?.userId).toBeNull();
    });

    it('refuses a scope value that is neither user nor org', async () => {
        const { instance, adminCookie } = await boot();
        const response = await instance.inject({
            method: 'POST',
            url: '/api/org/executors/99999999-9999-4999-8999-999999999999/scope',
            headers: { cookie: adminCookie },
            payload: { scope: 'repo' },
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_SCOPE');
    });
});

describe('the workspace poll and the personal routes after 391', () => {
    it('the poll carries org selection metadata and the resolved default, no org config', async () => {
        const { instance, adminCookie } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: {
                executors: [
                    {
                        name: 'mine',
                        type: 'opencode',
                        config: { model: 'secret-model' },
                        providerConnectionId: CONNECTION_ID,
                    },
                ],
            },
        });

        const body = (
            await instance.inject({ method: 'GET', url: '/api/workspace', headers: { cookie: adminCookie } })
        ).json();
        expect(body.executors).toEqual([expect.objectContaining({ name: 'mine', type: 'opencode' })]);
        expect(body.executors[0].config).toBeUndefined();
        expect(body.orgExecutors).toEqual([expect.objectContaining({ name: 'team-runner', type: 'claude-code' })]);
        expect(JSON.stringify(body)).not.toContain('sonnet');
        // No configured default: nothing resolves, however many profiles exist.
        expect(body.defaultExecutor).toBeNull();
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie: adminCookie },
            payload: { executorId: body.executors[0].id },
        });
        const after = (
            await instance.inject({ method: 'GET', url: '/api/workspace', headers: { cookie: adminCookie } })
        ).json();
        expect(after.defaultExecutor).toEqual({ scope: 'user', name: 'mine' });
    });

    it('PUT /api/workspace/executors/default selects an org executor by id for the member', async () => {
        const { instance, adminCookie, memberCookie, member, executors } = await boot();
        const created = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        const id = created.json().id as string;

        const response = await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie: memberCookie },
            payload: { executorId: id },
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(await executors.selectedDefault(member.user.id)).toMatchObject({ executorId: id, scope: 'org' });

        // The poll folds the selection in: the member now autoselects the org profile.
        const poll = (
            await instance.inject({ method: 'GET', url: '/api/workspace', headers: { cookie: memberCookie } })
        ).json();
        expect(poll.defaultExecutor).toEqual({ scope: 'org', name: 'team-runner' });
    });

    it('the default route answers 404 for an id the caller cannot resolve, and 400 for a body with no executorId', async () => {
        const { instance, adminCookie } = await boot();
        const missing = await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie: adminCookie },
            payload: { executorId: '99999999-9999-4999-8999-999999999999' },
        });
        expect(missing.statusCode).toBe(HTTP_NOT_FOUND);

        const nameOnly = await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie: adminCookie },
            payload: { executor: 'x', executorScope: 'org' },
        });
        expect(nameOnly.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(nameOnly.json().code).toBe('BAD_BODY');
    });

    it('a PUT entry carrying isDefault is refused — the flag moved to the preference route', async () => {
        const { instance, adminCookie } = await boot();
        const response = await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: { executors: [{ name: 'x', type: 'claude-code', config: {}, isDefault: true }] },
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it('answers 503 when the deployment has no executor store', async () => {
        const auth = memoryAuthStore();
        const member = auth.seedMember('test-org', 'octocat');
        const config = testConfig({ auth: githubAuth() });
        const instance = await buildApp({
            config,
            orgs: staticRegistry({
                config,
                telemetry: stubTelemetryClient(),
            }),
            auth,
        });
        track(instance);
        const cookie = await signedIn(auth, member);
        const response = await instance.inject({ method: 'GET', url: '/api/org/executors', headers: { cookie } });
        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
    });
});

describe('executor lists to a bridged (MCP) caller', () => {
    it('omit the configuration, which may hold provider credentials; a cookie admin still gets it', async () => {
        const { instance, admin, adminCookie } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: { executors: [CLAUDE_CODE] },
        });
        const Request = bridgedRequestClass({ ...admin, scopes: ['factory:read'] });
        for (const url of ['/api/org/executors', '/api/workspace/executors']) {
            const bridged = await instance.inject({ method: 'GET', url, Request });
            expect(bridged.statusCode, url).toBe(HTTP_OK);
            const rows = bridged.json().executors as Record<string, unknown>[];
            expect(rows.length, url).toBeGreaterThan(0);
            for (const row of rows) expect(row, url).not.toHaveProperty('config');
            const cookie = await instance.inject({ method: 'GET', url, headers: { cookie: adminCookie } });
            for (const row of cookie.json().executors as Record<string, unknown>[])
                expect(row, url).toHaveProperty('config');
        }
    });
});

describe('organization executors: provider connection selection', () => {
    const ORG_CONNECTION = '66666666-6666-4666-8666-666666666666';
    const PERSONAL_CONNECTION = '77777777-7777-4777-8777-777777777777';
    const OPENAI_CONNECTION = '88888888-8888-4888-8888-888888888888';
    const known: Record<string, SelectedConnection> = {
        [ORG_CONNECTION]: { provider: 'anthropic', scope: 'org', ownerId: null },
        [PERSONAL_CONNECTION]: { provider: 'anthropic', scope: 'personal', ownerId: 'someone' },
        [OPENAI_CONNECTION]: { provider: 'openai', scope: 'org', ownerId: null },
    };
    /** The shared rule the SQL store runs in its transaction, applied by the double. */
    const freshRules = () =>
        memoryUserExecutorStore(({ owner, connectionId, type }) => {
            const connection = known[connectionId];
            return connectionSelectionRefusal({
                // A personal connection is its saving member's own: the owner is who saves it.
                connection:
                    connection && connection.scope === 'personal'
                        ? { ...connection, ownerId: owner }
                        : (connection ?? null),
                owner,
                agentType: type as 'claude-code' | 'opencode',
            });
        });
    const create = (cookie: string, instance: Awaited<ReturnType<typeof boot>>['instance'], extra: object) =>
        instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie },
            payload: { ...CLAUDE_CODE, ...extra },
        });

    it('stores and echoes an org connection, the selection metadata every member reads', async () => {
        const { instance, adminCookie, memberCookie } = await boot(freshRules());
        const created = await create(adminCookie, instance, { providerConnectionId: ORG_CONNECTION });
        expect(created.statusCode).toBe(HTTP_CREATED);
        expect(created.json()).toMatchObject({ providerConnectionId: ORG_CONNECTION });
        const listed = await instance.inject({
            method: 'GET',
            url: '/api/org/executors',
            headers: { cookie: memberCookie },
        });
        expect(listed.json().executors[0]).toMatchObject({ providerConnectionId: ORG_CONNECTION });
        expect(listed.json().executors[0]).not.toHaveProperty('config');
    });

    it.each([
        ['a personal connection on an organization executor', { providerConnectionId: PERSONAL_CONNECTION }],
        ['an unsupported provider and executor type', { providerConnectionId: OPENAI_CONNECTION }],
        ['an unknown connection', { providerConnectionId: '99999999-9999-4999-8999-999999999999' }],
    ])('refuses %s with 409 PROVIDER_CONNECTION_REFUSED, storing nothing', async (_name, extra) => {
        const { instance, adminCookie, executors } = await boot(freshRules());
        const refused = await create(adminCookie, instance, extra);
        expect(refused.statusCode).toBe(HTTP_CONFLICT);
        expect(refused.json()).toMatchObject({ code: 'PROVIDER_CONNECTION_REFUSED' });
        expect(executors.rows()).toEqual([]);
    });

    it('refuses a malformed, missing or null connection id as a bad body, and an edit that switches to a refused one', async () => {
        const { instance, adminCookie } = await boot(freshRules());
        expect((await create(adminCookie, instance, { providerConnectionId: 'not-an-id' })).statusCode).toBe(
            HTTP_BAD_REQUEST
        );
        const created = (await create(adminCookie, instance, { providerConnectionId: ORG_CONNECTION })).json();
        const edit = await instance.inject({
            method: 'PUT',
            url: `/api/org/executors/${created.id}`,
            headers: { cookie: adminCookie },
            payload: { ...CLAUDE_CODE, providerConnectionId: OPENAI_CONNECTION },
        });
        expect(edit.statusCode).toBe(HTTP_CONFLICT);
        // A connection is required on every edit: omitting it or sending null is a bad body, and the row keeps its own.
        for (const [label, payload] of [
            ['omitted', { name: CLAUDE_CODE.name, type: CLAUDE_CODE.type, config: CLAUDE_CODE.config }],
            ['null', { ...CLAUDE_CODE, providerConnectionId: null }],
        ] as const) {
            const refused = await instance.inject({
                method: 'PUT',
                url: `/api/org/executors/${created.id}`,
                headers: { cookie: adminCookie },
                payload,
            });
            expect(refused.statusCode, label).toBe(HTTP_BAD_REQUEST);
            expect(refused.json(), label).toMatchObject({ code: 'BAD_BODY' });
        }
        const kept = await instance.inject({
            method: 'PUT',
            url: `/api/org/executors/${created.id}`,
            headers: { cookie: adminCookie },
            payload: { ...CLAUDE_CODE, providerConnectionId: ORG_CONNECTION },
        });
        expect(kept.json()).toMatchObject({ providerConnectionId: ORG_CONNECTION });
    });

    it('refuses a promotion that would carry a personal connection into the organization', async () => {
        const { instance, adminCookie, executors } = await boot(freshRules());
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: {
                executors: [
                    { name: 'mine', type: 'claude-code', config: {}, providerConnectionId: PERSONAL_CONNECTION },
                ],
            },
        });
        const row = executors.rows()[0]!;
        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${row.id}/scope`,
            headers: { cookie: adminCookie },
            payload: { scope: 'org' },
        });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json()).toMatchObject({ code: 'PROVIDER_CONNECTION_REFUSED' });
        expect(executors.rows()[0]!.userId).not.toBeNull();
    });
});

describe('organization executors: safe connection metadata', () => {
    const ORG_CONNECTION = '66666666-6666-4666-8666-666666666666';
    const SECRET = 'sk-never-in-a-payload';
    const listFor = async () => [
        { id: ORG_CONNECTION, name: 'Team key', provider: 'anthropic', scope: 'org', baseUrl: null, hasKey: true },
    ];
    const seed = async () => {
        const executors = memoryUserExecutorStore();
        const booted = await boot(executors, {}, { listFor } as never);
        await executors.createOrg({
            name: 'team',
            type: 'claude-code',
            config: { apiKey: SECRET, model: 'sonnet' },
            createdBy: booted.admin.user.id,
            providerConnectionId: ORG_CONNECTION,
        });
        return booted;
    };
    const expected = {
        providerConnectionId: ORG_CONNECTION,
        providerConnectionName: 'Team key',
        providerConnectionProvider: 'anthropic',
        providerConnectionScope: 'org',
    };

    it('gives a member the connection fields and the override indicator without config or key', async () => {
        const { instance, memberCookie } = await seed();
        const response = await instance.inject({
            method: 'GET',
            url: '/api/org/executors',
            headers: { cookie: memberCookie },
        });
        const row = response.json().executors[0];
        expect(row).toMatchObject({ ...expected, configOverridesConnection: true });
        expect(row).not.toHaveProperty('config');
        expect(response.body).not.toContain(SECRET);
    });

    it('gives an admin the same fields beside the config, and a bridged admin the member view', async () => {
        const { instance, adminCookie, admin } = await seed();
        const listed = await instance.inject({
            method: 'GET',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
        });
        expect(listed.json().executors[0]).toMatchObject({ ...expected, configOverridesConnection: true });
        expect(listed.json().executors[0]).toHaveProperty('config');
        const Request = bridgedRequestClass({ ...admin, scopes: ['factory:read'] });
        const bridged = await instance.inject({ method: 'GET', url: '/api/org/executors', Request });
        expect(bridged.json().executors[0]).toMatchObject(expected);
        expect(bridged.json().executors[0]).not.toHaveProperty('config');
        expect(bridged.body).not.toContain(SECRET);
    });
});
