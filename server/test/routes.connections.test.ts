import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ConnectionRefusedError } from '../src/db/connection-bindings.js';
import type { ConnectionStore, ConnectionView, NewConnection } from '../src/db/connection-store.js';
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
    HTTP_BAD_GATEWAY,
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
 * Offline: the connection routes' HTTP contract (issue #546) and the task-create selection check,
 * against an in-memory store double. The store's SQL is pinned by server/test-db/connection-store.test.ts.
 */

const CLOUD_ID = 'bc18dcc3-123a-4216-a5a2-4f7b0e55b297';
const API_TOKEN = 'secret-atlassian-token';
const SITE = { site: 'https://Example.atlassian.net/', email: 'agent@example.com', apiToken: API_TOKEN };

const track = trackApps();

/** A store double with the real scoping rule, holding tokens like the table does. */
function memoryConnections(): ConnectionStore & { rows: (NewConnection & { id: string })[] } {
    const rows: (NewConnection & { id: string })[] = [];
    const view = (row: NewConnection & { id: string }): ConnectionView => ({
        id: row.id,
        provider: 'jira',
        credential: 'legacy_api_token',
        ownership: row.ownerUserId === null ? 'legacy-org' : 'personal',
        principal: row.ownerUserId === null ? null : 'self',
        site: row.site,
        account: row.email,
        access: row.access,
        status: 'active',
        createdAt: '2026-10-08T00:00:00.000Z',
    });
    return {
        rows,
        async list(userId) {
            return rows.filter((r) => r.ownerUserId === null || r.ownerUserId === userId).map(view);
        },
        async create(input) {
            const row = { ...input, id: crypto.randomUUID() };
            rows.push(row);
            return view(row);
        },
        async candidates(userId, provider) {
            return rows
                .filter((r) => r.ownerUserId === userId && provider === 'jira')
                .map(view)
                .reverse();
        },
        async disconnect(id, { userId, admin }) {
            const at = rows.findIndex(
                (r) => r.id === id && (r.ownerUserId === userId || (r.ownerUserId === null && admin))
            );
            if (at === -1) return { disconnected: false, revokedGrantId: null };
            rows.splice(at, 1);
            return { disconnected: true, revokedGrantId: null };
        },
    };
}

async function boot() {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const other = auth.seedMember('test-org', 'hubot');
    const connections = memoryConnections();
    const created: { connections: string[] | undefined }[] = [];
    const jobs = jobStoreSlice<JobActionStore>({
        // The store resolves and authorizes; the double refuses what no row of this fake grants `by`.
        async create(_command: string, by: string | null, target: { connectionIds?: string[] }) {
            for (const id of target.connectionIds ?? []) {
                const row = connections.rows.find((r) => r.id === id);
                if (!row || (row.ownerUserId !== null && row.ownerUserId !== by)) {
                    throw new ConnectionRefusedError('not-authorized');
                }
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
        cloudIdLookup: async (host) => (host === 'example.atlassian.net' ? CLOUD_ID : null),
    });
    track(app);
    return {
        instance: app,
        connections,
        created,
        cookie: {
            admin: await signedIn(auth, admin),
            member: await signedIn(auth, member),
            other: await signedIn(auth, other),
        },
    };
}

describe('connection routes', () => {
    it('need a session', async () => {
        const { instance } = await boot();
        expect((await instance.inject({ method: 'GET', url: '/api/connections' })).statusCode).toBe(HTTP_UNAUTHORIZED);
        expect((await instance.inject({ method: 'POST', url: '/api/connections', payload: SITE })).statusCode).toBe(
            HTTP_UNAUTHORIZED
        );
    });

    it('creates a member-owned read connection, never echoing the token', async () => {
        const { instance, cookie, connections } = await boot();
        const res = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: SITE,
        });
        expect(res.statusCode).toBe(HTTP_CREATED);
        expect(res.json()).toMatchObject({ site: 'example.atlassian.net', access: 'read', ownership: 'personal' });
        expect(res.body).not.toContain(API_TOKEN);
        expect(connections.rows[0]).toMatchObject({ cloudId: CLOUD_ID, apiToken: API_TOKEN });
        const list = await instance.inject({
            method: 'GET',
            url: '/api/connections',
            headers: { cookie: cookie.member },
        });
        expect(list.statusCode).toBe(HTTP_OK);
        expect(list.body).not.toContain(API_TOKEN);
    });

    it('lets only an admin create an org-wide connection', async () => {
        const { instance, cookie } = await boot();
        const refused = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: { ...SITE, scope: 'org' },
        });
        expect(refused.statusCode).toBe(HTTP_FORBIDDEN);
        const allowed = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.admin },
            payload: { ...SITE, scope: 'org', access: 'write' },
        });
        expect(allowed.statusCode).toBe(HTTP_CREATED);
        expect(allowed.json()).toMatchObject({ ownership: 'legacy-org', access: 'write' });
    });

    it.each([
        ['a non-Atlassian host', { ...SITE, site: 'evil.example.com' }],
        ['an internal host', { ...SITE, site: 'localhost' }],
        ['a missing token', { ...SITE, apiToken: '' }],
        ['a quote in the email', { ...SITE, email: 'a"b@example.com' }],
        ['an unknown access level', { ...SITE, access: 'admin' }],
        ['an unknown scope', { ...SITE, scope: 'global' }],
    ])('refuses %s', async (_label, payload) => {
        const { instance, cookie, connections } = await boot();
        const res = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload,
        });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json()).toMatchObject({ code: 'BAD_CONNECTION' });
        expect(connections.rows).toHaveLength(0);
    });

    it('refuses a site whose cloud id cannot be resolved', async () => {
        const { instance, cookie } = await boot();
        const res = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: { ...SITE, site: 'nowhere.atlassian.net' },
        });
        expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
    });

    it("hides another member's connection from list and delete, and lets an admin delete only org ones", async () => {
        const { instance, cookie, connections } = await boot();
        const own = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: SITE,
        });
        const id = own.json().id as string;
        const seen = await instance.inject({
            method: 'GET',
            url: '/api/connections',
            headers: { cookie: cookie.other },
        });
        expect(seen.json().connections).toEqual([]);
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
        expect(connections.rows).toHaveLength(0);
    });

    it('DELETE disconnects and answers 204; another member id answers 404', async () => {
        const { instance, cookie, connections } = await boot();
        const created = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: SITE,
        });
        const { id } = created.json() as { id: string };
        const foreign = await instance.inject({
            method: 'DELETE',
            url: `/api/connections/${id}`,
            headers: { cookie: cookie.other },
        });
        expect(foreign.statusCode).toBe(HTTP_NOT_FOUND);
        expect(connections.rows).toHaveLength(1);
        const mine = await instance.inject({
            method: 'DELETE',
            url: `/api/connections/${id}`,
            headers: { cookie: cookie.member },
        });
        expect(mine.statusCode).toBe(HTTP_NO_CONTENT);
        expect(mine.body).toBe('');
    });

    it('list carries ownership and credential and no token', async () => {
        const { instance, cookie } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: SITE,
        });
        const list = await instance.inject({
            method: 'GET',
            url: '/api/connections',
            headers: { cookie: cookie.member },
        });
        const [row] = list.json().connections as Record<string, unknown>[];
        expect(row).toMatchObject({
            provider: 'jira',
            credential: 'legacy_api_token',
            ownership: 'personal',
            principal: 'self',
            account: 'agent@example.com',
            status: 'active',
        });
        expect(Object.keys(row!).join()).not.toMatch(/token|secret/i);
        expect(list.body).not.toContain(API_TOKEN);
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
        const { instance, cookie, created } = await boot();
        const made = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: SITE,
        });
        const res = await create(instance, cookie.member, [made.json().id]);
        expect(res.statusCode).toBe(HTTP_CREATED);
        expect(created).toEqual([{ connections: [made.json().id] }]);
    });

    it("answers the store's refusal of another member's or an unknown connection as 403, creating nothing", async () => {
        const { instance, cookie, created } = await boot();
        const made = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: SITE,
        });
        for (const id of [made.json().id, crypto.randomUUID()]) {
            const res = await create(instance, cookie.other, [id]);
            expect(res.statusCode).toBe(HTTP_FORBIDDEN);
            expect(res.json()).toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
        }
        expect(created).toEqual([]);
    });

    it('lets a member name a legacy org connection, and refuses a malformed id', async () => {
        const { instance, cookie, created } = await boot();
        const org = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.admin },
            payload: { ...SITE, scope: 'org' },
        });
        expect((await create(instance, cookie.other, [org.json().id])).statusCode).toBe(HTTP_CREATED);
        expect(created).toHaveLength(1);
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
