import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ConnectionStore, ConnectionView } from '../src/db/connection-store.js';
import type { AuthorizationFlow } from '../src/integrations/authorization-flow.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, testConfig } from './helpers.js';
import { HTTP_BAD_REQUEST, HTTP_SERVICE_UNAVAILABLE, HTTP_UNAUTHORIZED, trackApps } from './helpers-http.js';
import { storeOutage } from './helpers-outage.js';

/**
 * Offline: `GET /api/integrations/catalog`, the shared provider list joined with this deployment's configuration and
 * the caller's own connections. A state is stated only when real state backs it.
 */

const track = trackApps();

const view = (id: string, extra: Partial<ConnectionView> = {}): ConnectionView => ({
    id,
    provider: 'jira',
    credential: 'oauth_grant',
    ownership: 'personal',
    principal: 'self',
    site: 'private-site.example',
    account: 'private-person@example.test',
    access: 'write',
    status: 'active',
    needsReconnect: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
});

interface Boot {
    configured?: readonly string[];
    /** Connections by member login. */
    rows?: Record<string, ConnectionView[]>;
    failList?: boolean;
    noStore?: boolean;
}

async function boot({ configured = ['jira'], rows = {}, failList = false, noStore = false }: Boot = {}) {
    const auth = memoryAuthStore();
    const alice = auth.seedMember('test-org', 'alice');
    const bob = auth.seedMember('test-org', 'bob');
    const byUser = new Map<string, ConnectionView[]>([
        [alice.user.id, rows.alice ?? []],
        [bob.user.id, rows.bob ?? []],
    ]);
    const connections = {
        async list(userId: string) {
            if (failList) throw storeOutage('read failed');
            return byUser.get(userId) ?? [];
        },
    } as unknown as ConnectionStore;
    const config = testConfig({ auth: githubAuth() });
    const flow = {} as AuthorizationFlow;
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, ...(noStore ? {} : { connections }) }),
        auth,
        integrations: {
            resolverOf: () => ({
                resolveCredential: async () => {
                    throw new Error('unused');
                },
            }),
            flowOf: () => flow,
            configured,
        },
    });
    track(app);
    return { app, aliceCookie: await signedIn(auth, alice), bobCookie: await signedIn(auth, bob) };
}

type Booted = Awaited<ReturnType<typeof boot>>;
interface Entry {
    provider: string;
    name: string;
    category: string;
    description: string;
    state: string;
    reason?: string;
    connections: number;
    capabilities?: { read: string[]; write: string[] };
    connect?: { path: string };
    manage?: { path: string };
}
const catalog = async (booted: Booted, query = '', cookie = booted.aliceCookie) => {
    const response = await booted.app.inject({
        method: 'GET',
        url: `/api/integrations/catalog${query}`,
        headers: { cookie },
    });
    return { response, body: response.json() as { providers: Entry[]; cursor: string | null } };
};
const entry = (providers: Entry[], id: string) => providers.find((p) => p.provider === id);

describe('GET /api/integrations/catalog states', () => {
    it('a configured oauth provider with no connection is connectable, with a connect action and its capabilities', async () => {
        const { body } = await catalog(await boot());
        expect(entry(body.providers, 'jira')).toMatchObject({
            name: 'Jira',
            category: 'Issue tracking',
            state: 'connectable',
            connections: 0,
            connect: { path: '/settings/integrations/available' },
        });
        expect(entry(body.providers, 'jira')?.capabilities?.write).toContain('write:jira-work');
    });

    it('an oauth provider this deployment has no client for is unavailable, with no connect action', async () => {
        const { body } = await catalog(await boot({ configured: [] }));
        const jira = entry(body.providers, 'jira');
        expect(jira).toMatchObject({ state: 'unavailable', reason: 'not_configured' });
        expect(jira?.connect).toBeUndefined();
        expect(jira?.manage).toBeUndefined();
    });

    it('a planned provider is planned and never connectable', async () => {
        const { body } = await catalog(await boot());
        const slack = entry(body.providers, 'slack');
        expect(slack).toMatchObject({ state: 'planned', connections: 0 });
        expect(slack?.connect).toBeUndefined();
    });

    it('an organization-managed provider is unavailable to a member, with the reason', async () => {
        const { body } = await catalog(await boot());
        expect(entry(body.providers, 'github')).toMatchObject({ state: 'unavailable', reason: 'organization_managed' });
        expect(entry(body.providers, 'github')?.connect).toBeUndefined();
    });

    it('an active healthy connection is connected, with a manage action; several count', async () => {
        const rows = { alice: [view('c1'), view('c2', { site: 'other.example' })] };
        const { body } = await catalog(await boot({ rows }));
        expect(entry(body.providers, 'jira')).toMatchObject({
            state: 'connected',
            connections: 2,
            manage: { path: '/settings/integrations' },
        });
    });

    it('a lapsed grant alone is needs_reconnect; a healthy one beside it is connected', async () => {
        const lapsed = view('c1', { needsReconnect: true });
        const alone = await catalog(await boot({ rows: { alice: [lapsed] } }));
        expect(entry(alone.body.providers, 'jira')).toMatchObject({
            state: 'needs_reconnect',
            connect: { path: '/settings/integrations/available' },
        });
        const beside = await catalog(await boot({ rows: { alice: [lapsed, view('c2')] } }));
        expect(entry(beside.body.providers, 'jira')?.state).toBe('connected');
    });

    it('a disconnected row is no connection', async () => {
        const { body } = await catalog(await boot({ rows: { alice: [view('c1', { status: 'disconnected' })] } }));
        expect(entry(body.providers, 'jira')).toMatchObject({ state: 'connectable', connections: 0 });
    });

    it("never counts or shows another member's connection, nor any site or account", async () => {
        const booted = await boot({ rows: { bob: [view('c1')] } });
        const alice = await catalog(booted);
        expect(entry(alice.body.providers, 'jira')).toMatchObject({ state: 'connectable', connections: 0 });
        const bob = await catalog(booted, '', booted.bobCookie);
        expect(entry(bob.body.providers, 'jira')).toMatchObject({ state: 'connected', connections: 1 });
        const text = JSON.stringify([alice.body, bob.body]);
        for (const secret of ['private-site', 'private-person', 'c1']) expect(text).not.toContain(secret);
    });
});

describe('GET /api/integrations/catalog reads', () => {
    it('answers 503 when the connections cannot be read, never a state guessed without them', async () => {
        expect((await catalog(await boot({ failList: true }))).response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect((await catalog(await boot({ noStore: true }))).response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
    });

    it('answers 401 without a session', async () => {
        const booted = await boot();
        const response = await booted.app.inject({ method: 'GET', url: '/api/integrations/catalog' });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('filters by q over name, id and description, and by category', async () => {
        const booted = await boot();
        expect((await catalog(booted, '?q=JIRA')).body.providers.map((p) => p.provider)).toEqual(['jira']);
        expect((await catalog(booted, '?q=follow%20tasks')).body.providers.map((p) => p.provider)).toEqual([
            'discord',
            'slack',
        ]);
        const category = await catalog(booted, `?category=${encodeURIComponent('CI / DevOps')}`);
        expect(category.body.providers.map((p) => p.provider)).toEqual(['github', 'gitlab']);
    });

    it('pages in a stable order until the cursor is null', async () => {
        const booted = await boot();
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
            const { body } = await catalog(booted, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            expect(body.providers.length).toBeLessThanOrEqual(2);
            seen.push(...body.providers.map((p) => p.provider));
            cursor = body.cursor;
        } while (cursor);
        expect(seen).toEqual(['discord', 'github', 'gitlab', 'jira', 'mcp', 'slack']);
    });

    it('refuses an unknown category, a bad limit and a cursor it did not issue', async () => {
        const booted = await boot();
        for (const query of ['?category=nope', '?limit=0', '?limit=101', '?limit=x', '?cursor=zzz']) {
            const { response, body } = await catalog(booted, query);
            expect(response.statusCode, query).toBe(HTTP_BAD_REQUEST);
            expect(body).toHaveProperty('code');
        }
    });
});
