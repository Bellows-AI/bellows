import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { McpCaller, OAuthStore } from '../src/auth/oauth-store.js';
import { hashToken } from '../src/auth/session.js';
import type { ConnectionStore, ConnectionView } from '../src/db/connection-store.js';
import type { Resolution } from '../src/db/connection-bindings.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { AuthorizationFlow } from '../src/integrations/authorization-flow.js';
import type { OrgRegistry } from '../src/orgs.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryUserExecutorStore,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from './helpers.js';
import { trackApps } from './helpers-http.js';

/**
 * Each discovery tool through the real auth plugin and bridge, driven by a v2 client over `POST /api/mcp`:
 * scope, org isolation, the board's refusals and an unconfirmed answer.
 */

const track = trackApps();
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const TOKENS = {
    alice: 'mat_disc-alice-token-0123456789',
    carol: 'mat_disc-carol-token-0123456789',
    bob: 'mat_disc-bob-token-0123456789',
    dave: 'mat_disc-dave-token-0123456789',
} as const;
type Who = keyof typeof TOKENS;

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, LOCALHOST, () => {
            const address = probe.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });

const view = (id: string, extra: Partial<ConnectionView> = {}): ConnectionView => ({
    id,
    provider: 'jira',
    credential: 'oauth_grant',
    ownership: 'personal',
    principal: 'self',
    site: `${id}.example`,
    account: `${id}@example.test`,
    access: 'write',
    status: 'active',
    needsReconnect: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
});

interface Scenario {
    repos?: { owner: string; name: string }[];
    repoError?: string | null;
    repoThrows?: boolean;
    /** Connections by login. */
    rows?: Partial<Record<Who, ConnectionView[]>>;
    configured?: readonly string[];
    resolution?: Resolution;
    connectionsThrow?: boolean;
    withFlow?: boolean;
    /** Boot org A with no executor store at all. */
    noExecutorStore?: boolean;
}

async function boot(scenario: Scenario = {}) {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const store = memoryAuthStore();
    const people = {
        alice: store.seedMember('org-a', 'alice', 'admin'),
        carol: store.seedMember('org-a', 'carol', 'member'),
        bob: store.seedMember('org-b', 'bob', 'member'),
        dave: store.seedMember('org-a', 'dave', 'member'),
    };
    const scopes: Record<Who, McpCaller['scopes']> = {
        alice: ['factory:read'],
        carol: ['factory:read'],
        bob: ['factory:read'],
        dave: ['factory:write'],
    };
    const tokens = new Map<string, McpCaller>(
        (Object.keys(TOKENS) as Who[]).map((who) => [
            hashToken(TOKENS[who]).toString('hex'),
            { ...people[who], scopes: scopes[who], clientId: 'c', resource, familyId: `f-${who}` },
        ])
    );
    const oauth: Pick<OAuthStore, 'findAccessToken'> = {
        findAccessToken: async (hash) => tokens.get(hash.toString('hex')) ?? null,
    };
    const config = testConfig({
        auth: githubAuth({ publicUrl }),
        port,
        mcp: { enabled: true, resource, trustedOrigins: [] },
    });
    const base = staticRepoSource(scenario.repos ?? [{ owner: 'acme', name: 'web' }], {
        error: scenario.repoError ?? null,
    });
    const repos = scenario.repoThrows
        ? { ...base, detail: async () => Promise.reject(new Error('github down')) }
        : base;
    const byUser = new Map<string, ConnectionView[]>(
        (Object.keys(people) as Who[]).map((who) => [people[who].user.id, scenario.rows?.[who] ?? []])
    );
    const connections = {
        async list(userId: string) {
            if (scenario.connectionsThrow) throw new Error('read failed');
            return byUser.get(userId) ?? [];
        },
        async preview() {
            return scenario.resolution ?? { ok: true, bindings: [], requirements: [] };
        },
    } as unknown as ConnectionStore;
    const executors = memoryUserExecutorStore();
    await executors.replace(people.alice.user.id, [{ name: 'mine', type: 'claude-code', config: { token: 'SECRET' } }]);
    await executors.createOrg({
        name: 'shared',
        type: 'claude-code',
        config: { token: 'ORG-SECRET' },
        createdBy: people.alice.user.id,
    });
    const orgA = staticRegistry({
        config,
        telemetry: stubTelemetryClient(),
        repos,
        connections,
        ...(scenario.noExecutorStore ? {} : { userExecutors: executors }),
    });
    const orgB = staticRegistry({
        config,
        telemetry: stubTelemetryClient(),
        repos: staticRepoSource([{ owner: 'other', name: 'zeta' }]),
        connections: { list: async () => [view('b1')] } as unknown as ConnectionStore,
        userExecutors: memoryUserExecutorStore(),
    });
    const orgs: OrgRegistry = { ...orgA, for: (id) => (id === 'org-b' ? orgB.for(id) : orgA.for(id)) };
    const app = track(
        await buildApp({
            config,
            orgs,
            store: telemetryStoreStub(),
            auth: store,
            oauth: oauth as OAuthStore,
            ...(scenario.withFlow === false
                ? {}
                : {
                      integrations: {
                          resolverOf: () => ({
                              resolveCredential: async () => {
                                  throw new Error('unused');
                              },
                          }),
                          flowOf: () => ({}) as AuthorizationFlow,
                          configured: scenario.configured ?? ['jira'],
                      },
                  }),
        })
    );
    await app.listen({ port, host: LOCALHOST });
    return new URL(resource);
}

const connect = async (url: URL, who: Who) => {
    const client = new Client({ name: 'disc', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKENS[who]}` } } })
    );
    return client;
};

const call = async (url: URL, who: Who, name: string, args: Record<string, unknown> = {}) => {
    const client = await connect(url, who);
    try {
        const result = await client.callTool({ name, arguments: args });
        // biome-ignore lint/suspicious/noExplicitAny: structured content is asserted field by field below
        return { ...result, data: result.structuredContent as Record<string, any> };
    } finally {
        await client.close();
    }
};

const NAMES = [
    'list_available_integrations',
    'list_connections',
    'list_executors',
    'list_repos',
    'list_skills',
    'preflight_task',
    'whoami',
];

describe('the discovery tools over POST /api/mcp', () => {
    it('are listed read-only with an output schema', async () => {
        const client = await connect(await boot(), 'alice');
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(NAMES);
        for (const tool of tools) {
            expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
            expect(tool.outputSchema?.type, tool.name).toBe('object');
        }
        await client.close();
    });

    it('refuse a caller without factory:read before reaching the board', async () => {
        const url = await boot();
        for (const name of NAMES.filter((n) => n !== 'whoami')) {
            const result = await call(url, 'dave', name);
            expect(result.isError, name).toBe(true);
            expect(result.data, name).toMatchObject({ outcome: 'refused', code: 'insufficient_scope' });
        }
    });
});

describe('list_repos', () => {
    const many = ['d', 'a', 'c', 'b', 'e'].map((name) => ({ owner: 'acme', name }));

    it("lists the caller's org repositories only, sorted, as owner/name", async () => {
        const url = await boot({ repos: many });
        const a = await call(url, 'alice', 'list_repos');
        expect(a.data.repos.map((r: { repo: string }) => r.repo)).toEqual([
            'acme/a',
            'acme/b',
            'acme/c',
            'acme/d',
            'acme/e',
        ]);
        expect(a.data).toMatchObject({ stale: false, error: null, cursor: null });
        const b = await call(url, 'bob', 'list_repos');
        expect(b.data.repos.map((r: { repo: string }) => r.repo)).toEqual(['other/zeta']);
    });

    it('pages with a cursor until it is null', async () => {
        const url = await boot({ repos: many });
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard += 1) {
            const { data } = await call(url, 'alice', 'list_repos', { limit: 2, ...(cursor ? { cursor } : {}) });
            seen.push(...data.repos.map((r: { repo: string }) => r.repo));
            if (data.cursor === null) break;
            cursor = data.cursor;
        }
        expect(seen).toEqual(['acme/a', 'acme/b', 'acme/c', 'acme/d', 'acme/e']);
    });

    it('keeps a cached list beside its refresh error as stale, never a clean success', async () => {
        const url = await boot({ repoError: 'rate limited' });
        const { data, isError } = await call(url, 'alice', 'list_repos');
        expect(isError).toBeFalsy();
        expect(data).toMatchObject({ stale: true, error: 'rate limited' });
        expect(data.repos).toHaveLength(1);
    });

    it('is inconclusive when the board cannot answer', async () => {
        const { isError, data } = await call(await boot({ repoThrows: true }), 'alice', 'list_repos');
        expect(isError).toBe(true);
        expect(data).toMatchObject({ outcome: 'inconclusive' });
    });
});

describe('list_executors', () => {
    it('lists personal then organization profiles with scope and default, and never a configuration', async () => {
        const result = await call(await boot(), 'alice', 'list_executors');
        expect(result.data.executors).toMatchObject([
            { scope: 'user', name: 'mine', type: 'claude-code', suspended: false },
            { scope: 'org', name: 'shared', type: 'claude-code', suspended: false },
        ]);
        expect(result.data.executors.filter((e: { default: boolean }) => e.default)).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain('SECRET');
    });

    it("shows another member only the organization's profiles, and another org none of them", async () => {
        const url = await boot();
        const carol = await call(url, 'carol', 'list_executors');
        expect(carol.data.executors.map((e: { scope: string }) => e.scope)).toEqual(['org']);
        const bob = await call(url, 'bob', 'list_executors');
        expect(bob.data.executors).toEqual([]);
    });
});

describe('list_executors without an executor store', () => {
    it('is inconclusive, never a confirmed empty list', async () => {
        const { data } = await call(await boot({ noExecutorStore: true }), 'alice', 'list_executors');
        expect(data).toMatchObject({ outcome: 'inconclusive' });
    });
});

describe('list_connections', () => {
    it("lists only the caller's own connections with a derived state and no credential field", async () => {
        const rows = {
            alice: [view('a1'), view('a2', { needsReconnect: true }), view('a3', { status: 'disconnected' })],
            carol: [view('c1')],
        };
        const url = await boot({ rows });
        const alice = await call(url, 'alice', 'list_connections');
        expect(alice.data.connections.map((c: { id: string; state: string }) => [c.id, c.state])).toEqual([
            ['a1', 'connected'],
            ['a2', 'needs_reconnect'],
            ['a3', 'disconnected'],
        ]);
        const carol = await call(url, 'carol', 'list_connections');
        expect(carol.data.connections.map((c: { id: string }) => c.id)).toEqual(['c1']);
        expect(JSON.stringify(carol)).not.toContain('a1');
        const bob = await call(url, 'bob', 'list_connections');
        expect(bob.data.connections.map((c: { id: string }) => c.id)).toEqual(['b1']);
    });

    it('is inconclusive when the connections cannot be read', async () => {
        const { isError, data } = await call(await boot({ connectionsThrow: true }), 'alice', 'list_connections');
        expect(isError).toBe(true);
        expect(data).toMatchObject({ outcome: 'inconclusive' });
    });
});

describe('list_skills', () => {
    it("marks a skill that needs a connection as provider, with the caller's own standing", async () => {
        const url = await boot({ rows: { alice: [view('a1')], carol: [view('c1', { needsReconnect: true })] } });
        const states = async (who: Who) => {
            const { data } = await call(url, who, 'list_skills');
            const skill = data.skills.find((s: { name: string }) => s.name === 'jira');
            return skill?.connections.map((c: { provider: string; state: string }) => [c.provider, c.state]);
        };
        expect(await states('alice')).toEqual([['jira', 'connected']]);
        expect(await states('carol')).toEqual([['jira', 'needs_reconnect']]);
        expect(await states('bob')).toEqual([['jira', 'connected']]);
        const none = await call(await boot(), 'alice', 'list_skills');
        const jira = none.data.skills.find((skill: { name: string }) => skill.name === 'jira');
        expect(jira.connections).toMatchObject([{ provider: 'jira', state: 'missing' }]);
    });

    it('is inconclusive when the standing cannot be read: no guessed state', async () => {
        const { isError, data } = await call(await boot({ connectionsThrow: true }), 'alice', 'list_skills');
        expect(isError).toBe(true);
        expect(data).toMatchObject({ outcome: 'inconclusive' });
    });
});

describe('list_available_integrations', () => {
    it('states each provider from real state and offers a connect path only where one exists', async () => {
        const { data } = await call(await boot(), 'alice', 'list_available_integrations');
        const by = (id: string) => data.providers.find((p: { provider: string }) => p.provider === id);
        expect(by('jira')).toMatchObject({
            state: 'connectable',
            connect: { path: '/settings/integrations/available' },
        });
        expect(by('slack')).toMatchObject({ state: 'planned' });
        expect(by('slack').connect).toBeUndefined();
        expect(by('github')).toMatchObject({ state: 'unavailable', reason: 'organization_managed' });
    });

    it('keeps two members of one org apart: connected, lapsed, and none', async () => {
        const url = await boot({
            rows: { alice: [view('a1'), view('a2')], carol: [view('c1', { needsReconnect: true })] },
        });
        const jira = async (who: Who) =>
            (await call(url, who, 'list_available_integrations', { q: 'jira' })).data.providers[0];
        expect(await jira('alice')).toMatchObject({ state: 'connected', connections: 2 });
        expect(await jira('carol')).toMatchObject({ state: 'needs_reconnect', connections: 1 });
        expect(await jira('bob')).toMatchObject({ state: 'connected', connections: 1 });
        expect(JSON.stringify(await jira('carol'))).not.toMatch(/example/);
    });

    it("filters, pages to the end, and refuses a bad category with the board's code", async () => {
        const url = await boot();
        const first = await call(url, 'alice', 'list_available_integrations', { limit: 4 });
        expect(first.data.providers).toHaveLength(4);
        const second = await call(url, 'alice', 'list_available_integrations', { limit: 4, cursor: first.data.cursor });
        expect(second.data).toMatchObject({ cursor: null });
        expect(second.data.providers).toHaveLength(2);
        const filtered = await call(url, 'alice', 'list_available_integrations', { category: 'Communication' });
        expect(filtered.data.providers.map((p: { provider: string }) => p.provider)).toEqual(['discord', 'slack']);
        const bad = await call(url, 'alice', 'list_available_integrations', { category: 'Nope' });
        expect(bad.isError).toBe(true);
        expect(bad.data).toMatchObject({ outcome: 'refused', code: 'BAD_QUERY' });
    });

    it('reads every OAuth provider as unavailable, not absent, where no OAuth client is wired', async () => {
        const { data } = await call(await boot({ withFlow: false }), 'alice', 'list_available_integrations', {
            q: 'jira',
        });
        expect(data.providers).toMatchObject([{ provider: 'jira', state: 'unavailable', reason: 'not_configured' }]);
    });

    it("still counts the caller's active connections where no OAuth client is wired", async () => {
        const { data } = await call(
            await boot({ withFlow: false, rows: { alice: [view('a1')] } }),
            'alice',
            'list_available_integrations',
            { q: 'jira' }
        );
        expect(data.providers).toMatchObject([
            { provider: 'jira', state: 'unavailable', reason: 'not_configured', connections: 1 },
        ]);
    });

    it('is inconclusive when the connections cannot be read', async () => {
        const { data } = await call(await boot({ connectionsThrow: true }), 'alice', 'list_available_integrations');
        expect(data).toMatchObject({ outcome: 'inconclusive' });
    });
});

describe('preflight_task', () => {
    const selection = { repo: 'acme/web', executor: 'mine', skills: [] as string[] };

    it('is ready only when every check passed', async () => {
        const { data, isError } = await call(await boot(), 'alice', 'preflight_task', selection);
        expect(isError).toBeFalsy();
        expect(data).toMatchObject({ verdict: 'ready', ready: true, integrationRequired: [] });
    });

    it('keeps blocked apart: an untracked repo is blocked, not integration_required', async () => {
        const { data } = await call(await boot(), 'alice', 'preflight_task', { ...selection, repo: 'acme/other' });
        expect(data).toMatchObject({ verdict: 'blocked', ready: false });
    });

    it('types a missing, lapsed and ambiguous connection as integration_required', async () => {
        const open = (reason: 'missing' | 'ambiguous'): Resolution => ({
            ok: true,
            bindings: [],
            requirements: [{ provider: 'jira', reason }],
        });
        const withJira = { ...selection, skills: ['jira'] };
        const missing = await call(await boot({ resolution: open('missing') }), 'alice', 'preflight_task', withJira);
        expect(missing.data).toMatchObject({
            verdict: 'integration_required',
            ready: false,
            integrationRequired: [{ provider: 'jira', reason: 'missing' }],
        });
        const ambiguous = await call(
            await boot({ resolution: open('ambiguous') }),
            'alice',
            'preflight_task',
            withJira
        );
        expect(ambiguous.data.integrationRequired).toMatchObject([{ reason: 'ambiguous' }]);
        const lapsed = await call(
            await boot({ resolution: open('missing'), rows: { alice: [view('a1', { needsReconnect: true })] } }),
            'alice',
            'preflight_task',
            withJira
        );
        expect(lapsed.data.integrationRequired).toMatchObject([{ reason: 'reconnect' }]);
    });

    it('does not type a blocker as missing when the connection list could not be read', async () => {
        const resolution: Resolution = {
            ok: true,
            bindings: [],
            requirements: [{ provider: 'jira', reason: 'missing' }],
        };
        const { data } = await call(await boot({ resolution, connectionsThrow: true }), 'alice', 'preflight_task', {
            ...selection,
            skills: ['jira'],
        });
        expect(data).toMatchObject({
            verdict: 'integration_required',
            integrationRequired: [{ provider: 'jira', reason: 'unknown' }],
        });
    });

    it('is blocked, not integration_required, when a non-connection blocker sits beside a missing connection', async () => {
        const resolution: Resolution = {
            ok: true,
            bindings: [],
            requirements: [{ provider: 'jira', reason: 'missing' }],
        };
        const { data } = await call(await boot({ resolution }), 'alice', 'preflight_task', {
            ...selection,
            repo: 'acme/other',
            skills: ['jira'],
        });
        expect(data.verdict).toBe('blocked');
    });

    it('is unverified, never ready, when the board could not confirm a check', async () => {
        const { data } = await call(await boot({ repoError: 'rate limited' }), 'alice', 'preflight_task', selection);
        expect(data).toMatchObject({ verdict: 'unverified', ready: true });
    });

    it('is inconclusive when the board refuses the selection shape or cannot answer', async () => {
        const url = await boot();
        const refused = await call(url, 'alice', 'preflight_task', { ...selection, connections: ['not-a-uuid'] });
        expect(refused.data).toMatchObject({ outcome: 'refused', code: 'BAD_CONNECTION' });
        const down = await call(
            await boot({ connectionsThrow: true, repoThrows: true }),
            'alice',
            'preflight_task',
            selection
        );
        expect(down.data.verdict).toBe('unverified');
    });
});
