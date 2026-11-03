import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { McpCaller, OAuthStore } from '../src/auth/oauth-store.js';
import { hashToken } from '../src/auth/session.js';
import type { AuthConfig } from '../src/config.js';
import { createServerMetrics, type ServerMetrics } from '../src/metrics.js';
import { LOCAL_ORG_ID } from '../src/identifiers.js';
import {
    githubAuth,
    memoryAuthStore,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from './helpers.js';
import { trackApps } from './helpers-http.js';

const track = trackApps();
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const TOKEN_A = 'mat_whoami-alice-token-0123456789';
const TOKEN_B = 'mat_whoami-bob-token-0123456789';
const VERSION = '9.9.9-test';

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

async function boot(mode: 'github' | 'none', metrics?: ServerMetrics) {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const store = memoryAuthStore();
    const alice = mode === 'github' ? store.seedMember('org-a', 'alice', 'admin') : store.seedLocalUser(LOCAL_ORG_ID);
    const bob = mode === 'github' ? store.seedMember('org-b', 'bob', 'member') : alice;
    const tokens = new Map<string, McpCaller>([
        [
            hashToken(TOKEN_A).toString('hex'),
            { ...alice, scopes: ['factory:read'], clientId: 'c', resource, familyId: 'f1' },
        ],
        [
            hashToken(TOKEN_B).toString('hex'),
            { ...bob, scopes: ['factory:read', 'factory:write'], clientId: 'c', resource, familyId: 'f2' },
        ],
    ]);
    const oauth: Pick<OAuthStore, 'findAccessToken'> = {
        findAccessToken: async (hash) => tokens.get(hash.toString('hex')) ?? null,
    };
    const auth: AuthConfig = mode === 'github' ? githubAuth({ publicUrl }) : { mode: 'none', ingestToken: null };
    const config = testConfig({ auth, port, mcp: { enabled: true, resource, trustedOrigins: [] } });
    const app = track(
        await buildApp({
            config,
            orgs: staticRegistry({
                config,
                telemetry: stubTelemetryClient(),
                orgsFor: ['org-a', 'org-b', LOCAL_ORG_ID],
            }),
            store: telemetryStoreStub(),
            auth: store,
            oauth,
            version: VERSION,
            ...(metrics ? { metrics } : {}),
        })
    );
    await app.listen({ port, host: LOCALHOST });
    return new URL(resource);
}

const connect = async (url: URL, token: string | null) => {
    const client = new Client({ name: 'whoami', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(url, {
            requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
        })
    );
    return client;
};

describe('whoami through POST /api/mcp', () => {
    it('lists whoami with its annotations', async () => {
        const url = await boot('github');
        const client = await connect(url, TOKEN_A);
        const { tools } = await client.listTools();
        expect(tools.map((tool) => ({ name: tool.name, annotations: tool.annotations }))).toEqual([
            {
                name: 'whoami',
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            },
        ]);
        await client.close();
    });

    it('answers the account, org, role, granted scopes and version of a minted mat_ in github mode', async () => {
        const url = await boot('github');
        const client = await connect(url, TOKEN_A);
        const result = await client.callTool({ name: 'whoami', arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
            account: { login: 'alice' },
            organization: { id: 'org-a' },
            role: 'admin',
            scopes: ['factory:read'],
            mode: 'github',
            version: VERSION,
        });
        await client.close();
    });

    it('keeps two callers in different orgs apart under concurrency', async () => {
        const url = await boot('github');
        const a = await connect(url, TOKEN_A);
        const b = await connect(url, TOKEN_B);
        const answers = await Promise.all(
            Array.from({ length: 6 }, (_v, i) => (i % 2 === 0 ? a : b).callTool({ name: 'whoami', arguments: {} }))
        );
        answers.forEach((answer, i) => {
            const text = JSON.stringify(answer.structuredContent);
            expect(text).toContain(i % 2 === 0 ? '"org-a"' : '"org-b"');
            expect(text).not.toContain(i % 2 === 0 ? '"org-b"' : '"org-a"');
        });
        expect(JSON.stringify(answers[1]?.structuredContent)).toContain('"scopes":["factory:read","factory:write"]');
        await a.close();
        await b.close();
    });

    it('answers the local caller in none mode', async () => {
        const url = await boot('none');
        const client = await connect(url, null);
        const result = await client.callTool({ name: 'whoami', arguments: {} });
        expect(result.structuredContent).toMatchObject({
            organization: { id: LOCAL_ORG_ID },
            scopes: ['factory:read', 'factory:write'],
            mode: 'none',
        });
        await client.close();
    });

    it('counts the call by tool and outcome, with no caller or argument in the labels', async () => {
        const metrics = createServerMetrics({
            admission: {},
            occupancy: async () => ({ global: 0, orgMax: 0, repoMax: 0 }),
        });
        const url = await boot('github', metrics);
        const client = await connect(url, TOKEN_A);
        await client.callTool({ name: 'whoami', arguments: {} });
        const scrape = await metrics.render();
        expect(scrape).toContain('factory_mcp_tool_duration_seconds_count{tool="whoami",outcome="ok"} 1');
        expect(scrape).not.toContain('alice');
        await client.close();
    });
});
