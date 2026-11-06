import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Sql } from 'postgres';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { McpCaller, OAuthStore } from '../src/auth/oauth-store.js';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore } from '../src/auth/store.js';
import { createConnectionStore } from '../src/db/connection-store.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { AuthorizationFlow } from '../src/integrations/authorization-flow.js';
import type { OrgRegistry } from '../src/orgs.js';
import { githubAuth, staticRegistry, stubTelemetryClient, telemetryStoreStub, testConfig } from '../test/helpers.js';
import { oauthConnection, randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { buildWorld } from './oauth-rig.js';

/**
 * The MCP discovery tools over real stores: repos, connections, the integration catalog and preflight, for members
 * of two organizations. `server/test/mcp.tools-discovery.test.ts` holds the fault cases with in-memory fakes.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const ORG = testOrg();
const OTHER_ORG = testOrg();
const db = useTestDb({ orgs: [ORG, OTHER_ORG] });

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const close of closers.splice(0)) await close();
});

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

/** A second member of an organization, signed in through the real auth store. */
const member = (orgId: string, login: string) =>
    createAuthStore({ sql }).signIn(
        { githubUserId: randomGithubId(), login, displayName: null, avatarUrl: null },
        orgId,
        [{ id: orgId, name: orgId }]
    );

async function boot() {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const alice = (await buildWorld(sql, ORG)).caller;
    const carol = await member(ORG, `carol-${ORG}`);
    const bob = (await buildWorld(sql, OTHER_ORG)).caller;
    const people = { alice, carol, bob };
    const tokens = new Map<string, McpCaller>(
        Object.entries(people).map(([who, caller]) => [
            hashToken(`mat_dbdisc-${who}-token-0123456789`).toString('hex'),
            { ...caller, scopes: ['factory:read'], clientId: 'c', resource, familyId: `f-${who}` } as McpCaller,
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
    const registryFor = (orgId: string, repos: { owner: string; name: string }[]) =>
        staticRegistry({
            config,
            telemetry: stubTelemetryClient(),
            repos: staticRepoSource(repos),
            connections: createConnectionStore({ sql, orgId }),
        });
    const orgA = registryFor(ORG, [{ owner: 'acme', name: 'web' }]);
    const orgB = registryFor(OTHER_ORG, [{ owner: 'other', name: 'zeta' }]);
    const orgs: OrgRegistry = { ...orgA, for: (id) => (id === OTHER_ORG ? orgB.for(id) : orgA.for(id)) };
    const app = await buildApp({
        config,
        orgs,
        store: telemetryStoreStub(),
        auth: createAuthStore({ sql }),
        oauth: oauth as OAuthStore,
        integrations: {
            resolverOf: () => ({
                resolveCredential: async () => {
                    throw new Error('unused');
                },
            }),
            flowOf: () => ({}) as AuthorizationFlow,
            configured: ['jira'],
        },
    });
    closers.push(() => app.close());
    await app.listen({ port, host: LOCALHOST });
    return { url: new URL(resource), people };
}

const call = async (url: URL, who: string, name: string, args: Record<string, unknown> = {}) => {
    const client = new Client({ name: 'dbdisc', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(url, {
            requestInit: { headers: { authorization: `Bearer mat_dbdisc-${who}-token-0123456789` } },
        })
    );
    try {
        const result = await client.callTool({ name, arguments: args });
        // biome-ignore lint/suspicious/noExplicitAny: structured content is asserted field by field below
        return result.structuredContent as Record<string, any>;
    } finally {
        await client.close();
    }
};

describe.skipIf(!enabled)('discovery tools over real stores, two organizations', () => {
    it("lists each organization's own repositories", async () => {
        const { url } = await boot();
        expect((await call(url, 'alice', 'list_repos')).repos).toMatchObject([{ repo: 'acme/web' }]);
        expect((await call(url, 'bob', 'list_repos')).repos).toMatchObject([{ repo: 'other/zeta' }]);
    });

    it("lists only the caller's own connections, never a colleague's or another organization's", async () => {
        const { url, people } = await boot();
        await oauthConnection(sql, ORG, people.alice.user.id, { site: 'alice.example' });
        await oauthConnection(sql, ORG, people.carol.user.id, { site: 'carol.example' });
        await oauthConnection(sql, OTHER_ORG, people.bob.user.id, { site: 'bob.example' });
        const alice = await call(url, 'alice', 'list_connections');
        expect(alice.connections).toHaveLength(1);
        expect(JSON.stringify(alice)).toContain('alice.example');
        expect(JSON.stringify(alice)).not.toMatch(/carol\.example|bob\.example/);
        expect(JSON.stringify(await call(url, 'bob', 'list_connections'))).toContain('bob.example');
    });

    it('counts each caller their own connections in the catalog', async () => {
        const { url, people } = await boot();
        await oauthConnection(sql, ORG, people.alice.user.id);
        const jira = async (who: string) =>
            (await call(url, who, 'list_available_integrations', { q: 'jira' })).providers[0];
        expect(await jira('alice')).toMatchObject({ provider: 'jira', state: 'connected', connections: 1 });
        expect(await jira('carol')).toMatchObject({ provider: 'jira', state: 'connectable', connections: 0 });
        expect(await jira('bob')).toMatchObject({ provider: 'jira', state: 'connectable', connections: 0 });
    });

    it('asks a member without a Jira connection to connect, and not the one who has it', async () => {
        const { url, people } = await boot();
        await oauthConnection(sql, ORG, people.alice.user.id);
        const selection = { repo: 'acme/web', skills: ['factory-jira'] };
        expect(await call(url, 'carol', 'preflight_task', selection)).toMatchObject({
            verdict: 'integration_required',
            integrationRequired: [{ provider: 'jira', reason: 'missing' }],
        });
        expect((await call(url, 'alice', 'preflight_task', selection)).verdict).not.toBe('integration_required');
    });
});
