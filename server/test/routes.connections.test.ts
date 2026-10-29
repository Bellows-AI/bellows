import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { DestroyRevokedSecret } from '../src/routes/connections.js';
import { ConnectionRefusedError } from '../src/db/connection-bindings.js';
import type { ConnectionStore, ConnectionView } from '../src/db/connection-store.js';
import type { JobActionStore } from '../src/db/jobs/job-store-actions.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import {
    githubAuth,
    memoryAuthStore,
    signedIn,
    staticRegistry,
    jobStoreSlice,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CREATED,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_NO_CONTENT,
    HTTP_OK,
    HTTP_UNAUTHORIZED,
    trackApps,
} from './helpers-http.js';

/**
 * Offline: the connection routes' HTTP contract and the task-create selection check, against an in-memory store
 * double. A connection is created by the OAuth authorization flow (routes.integrations.test.ts), never here. The
 * store's SQL is pinned by server/test-db/connection-store.test.ts.
 */

const track = trackApps();

interface Row {
    id: string;
    ownerUserId: string;
}

/** A store double with the real scoping rule: a member sees and disconnects only their own. */
function memoryConnections(revokedGrantId: string | null = null): ConnectionStore & { rows: Row[] } {
    const rows: Row[] = [];
    const view = (row: Row): ConnectionView => ({
        id: row.id,
        provider: 'jira',
        credential: 'oauth_grant',
        ownership: 'personal',
        principal: 'self',
        site: 'example.atlassian.net',
        account: 'agent@example.com',
        access: 'read',
        status: 'active',
        createdAt: '2026-10-08T00:00:00.000Z',
    });
    return {
        rows,
        async list(userId) {
            return rows.filter((r) => r.ownerUserId === userId).map(view);
        },
        async candidates(userId, provider) {
            return rows
                .filter((r) => r.ownerUserId === userId && provider === 'jira')
                .map(view)
                .reverse();
        },
        async disconnect(id, { userId }) {
            const at = rows.findIndex((r) => r.id === id && r.ownerUserId === userId);
            if (at === -1) return { disconnected: false, revokedGrantId: null };
            rows.splice(at, 1);
            return { disconnected: true, revokedGrantId };
        },
    };
}

interface BootOptions {
    /** The grant the double's disconnect reports as revoked (an OAuth connection that was the grant's last). */
    revokedGrantId?: string;
    destroyRevokedSecret?: DestroyRevokedSecret;
}

async function boot(options: BootOptions = {}) {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const other = auth.seedMember('test-org', 'hubot');
    const connections = memoryConnections(options.revokedGrantId ?? null);
    const created: { connections: string[] | undefined }[] = [];
    const jobs = jobStoreSlice<JobActionStore>({
        // The store resolves and authorizes; the double refuses what no row of this fake grants `by`.
        async create(_command: string, by: string | null, target: { connectionIds?: string[] }) {
            for (const id of target.connectionIds ?? []) {
                const row = connections.rows.find((r) => r.id === id);
                if (!row || row.ownerUserId !== by) throw new ConnectionRefusedError('not-authorized');
            }
            created.push({ connections: target.connectionIds });
            return { id: crypto.randomUUID() };
        },
    });
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: staticRegistry({
            config,
            repos: staticRepoSource([{ owner: 'Bellows-AI', name: 'bellows.ai' }]),
            telemetry: stubTelemetryClient(),
            connections,
            jobs,
        }),
        auth,
        ...(options.destroyRevokedSecret ? { destroyRevokedSecret: options.destroyRevokedSecret } : {}),
    });
    track(app);
    const cookie = {
        admin: await signedIn(auth, admin),
        member: await signedIn(auth, member),
        other: await signedIn(auth, other),
    };
    /** A connection of `who`, as the OAuth flow would have left it. */
    const seed = (who: 'admin' | 'member' | 'other'): string => {
        const ownerUserId = { admin: admin.user.id, member: member.user.id, other: other.user.id }[who];
        const id = crypto.randomUUID();
        connections.rows.push({ id, ownerUserId });
        return id;
    };
    return { instance: app, connections, created, cookie, seed };
}

describe('connection routes', () => {
    it('need a session', async () => {
        const { instance } = await boot();
        expect((await instance.inject({ method: 'GET', url: '/api/connections' })).statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('has no create route: a connection is made by the OAuth flow', async () => {
        const { instance, cookie, connections } = await boot();
        const res = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: { site: 'example.atlassian.net', email: 'agent@example.com', apiToken: 'x' },
        });
        expect(res.statusCode).toBe(HTTP_NOT_FOUND);
        expect(connections.rows).toHaveLength(0);
    });

    it('lists the caller own OAuth connections, with ownership and credential and no token', async () => {
        const { instance, cookie, seed } = await boot();
        seed('member');
        seed('other');
        const list = await instance.inject({
            method: 'GET',
            url: '/api/connections',
            headers: { cookie: cookie.member },
        });
        expect(list.statusCode).toBe(HTTP_OK);
        const rows = list.json().connections as Record<string, unknown>[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            provider: 'jira',
            credential: 'oauth_grant',
            ownership: 'personal',
            principal: 'self',
            account: 'agent@example.com',
            status: 'active',
        });
        expect(Object.keys(rows[0]!).join()).not.toMatch(/token|secret/i);
    });

    it("hides another member's connection from delete, an admin included", async () => {
        const { instance, cookie, connections, seed } = await boot();
        const id = seed('member');
        for (const who of ['other', 'admin'] as const) {
            const res = await instance.inject({
                method: 'DELETE',
                url: `/api/connections/${id}`,
                headers: { cookie: cookie[who] },
            });
            expect(res.statusCode).toBe(HTTP_NOT_FOUND);
        }
        expect(connections.rows).toHaveLength(1);
        const mine = await instance.inject({
            method: 'DELETE',
            url: `/api/connections/${id}`,
            headers: { cookie: cookie.member },
        });
        expect(mine.statusCode).toBe(HTTP_NO_CONTENT);
        expect(mine.body).toBe('');
        expect(connections.rows).toHaveLength(0);
    });

    describe('a disconnect that revoked a grant destroys its secret after the commit', () => {
        const GRANT = '3c1b6f0e-6d0f-4d77-9b0a-6c8d0f5f7a11';
        const del = async (options: BootOptions) => {
            const { instance, cookie, seed } = await boot(options);
            const id = seed('member');
            return instance.inject({
                method: 'DELETE',
                url: `/api/connections/${id}`,
                headers: { cookie: cookie.member },
            });
        };

        it('calls destroyRevokedSecret once with the org and the revoked grant', async () => {
            const calls: [string, string][] = [];
            const res = await del({
                revokedGrantId: GRANT,
                destroyRevokedSecret: async (orgId, grantId) => {
                    calls.push([orgId, grantId]);
                    return { ok: true };
                },
            });
            expect(res.statusCode).toBe(HTTP_NO_CONTENT);
            expect(calls).toEqual([['test-org', GRANT]]);
        });

        it('does not call it when the disconnect revoked no grant', async () => {
            const calls: string[] = [];
            const res = await del({
                destroyRevokedSecret: async (_orgId, grantId) => {
                    calls.push(grantId);
                    return { ok: true };
                },
            });
            expect(res.statusCode).toBe(HTTP_NO_CONTENT);
            expect(calls).toEqual([]);
        });

        it('still answers 204 when the destroy throws or reports a refusal', async () => {
            expect(
                (
                    await del({
                        revokedGrantId: GRANT,
                        destroyRevokedSecret: async () => {
                            throw new Error('boom');
                        },
                    })
                ).statusCode
            ).toBe(HTTP_NO_CONTENT);
            expect(
                (
                    await del({
                        revokedGrantId: GRANT,
                        destroyRevokedSecret: async () => ({ ok: false, reason: 'pending' }),
                    })
                ).statusCode
            ).toBe(HTTP_NO_CONTENT);
        });
    });
});

describe('selecting connections for a task', () => {
    const create = (instance: FastifyInstance, cookie: string, connections?: unknown) =>
        instance.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { cookie },
            payload: {
                repo: 'Bellows-AI/bellows.ai',
                command: 'look at ABC-1',
                ...(connections === undefined ? {} : { connections }),
            },
        });

    it('hands the store the named connection ids', async () => {
        const { instance, cookie, created, seed } = await boot();
        const id = seed('member');
        const res = await create(instance, cookie.member, [id]);
        expect(res.statusCode).toBe(HTTP_CREATED);
        expect(created).toEqual([{ connections: [id] }]);
    });

    it("answers the store's refusal of another member's or an unknown connection as 403, creating nothing", async () => {
        const { instance, cookie, created, seed } = await boot();
        const id = seed('member');
        for (const named of [id, crypto.randomUUID()]) {
            const res = await create(instance, cookie.other, [named]);
            expect(res.statusCode).toBe(HTTP_FORBIDDEN);
            expect(res.json()).toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
        }
        expect(created).toEqual([]);
    });

    it('refuses a malformed id', async () => {
        const { instance, cookie } = await boot();
        const bad = await create(instance, cookie.other, ['not-a-uuid']);
        expect(bad.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(bad.json()).toMatchObject({ code: 'BAD_CONNECTION' });
    });

    it('creates a task with no connections when none is named: the store, not the route, picks a default', async () => {
        const { instance, cookie, created } = await boot();
        expect((await create(instance, cookie.member)).statusCode).toBe(HTTP_CREATED);
        expect(created).toEqual([{ connections: [] }]);
    });
});
