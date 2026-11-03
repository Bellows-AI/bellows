import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { McpCaller, OAuthStore } from '../src/auth/oauth-store.js';
import { hashToken } from '../src/auth/session.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import {
    githubAuth,
    jobStoreSlice,
    memoryAuthStore,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from './helpers.js';
import { trackApps } from './helpers-http.js';

/** `wait_task` through the real auth plugin, bridge and job routes (the settle long-poll included), on a board fake. */

const track = trackApps();
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const TOKENS = { reader: 'mat_wait-reader-token-0123456789', writer: 'mat_wait-writer-token-0123456789' } as const;
type Who = keyof typeof TOKENS;
const JOB = '11111111-1111-4111-8111-111111111111';

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

const RUN = {
    id: JOB,
    rootJobId: JOB,
    command: 'task',
    status: 'succeeded',
    repo: 'acme/web',
    executor: null,
    mode: 'objective',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
    exitCode: 0,
    failureKind: null,
    failureCause: null,
    summary: 'shipped',
    output: null,
    gates: null,
    waitReason: null,
    publication: null,
    author: { login: 'reader' },
    questions: [],
    integrationRequirements: [],
};

async function boot(settle: { holds: number[]; result: string }) {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const auth = memoryAuthStore();
    const people = {
        reader: auth.seedMember('org-a', 'reader', 'member'),
        writer: auth.seedMember('org-a', 'writer', 'member'),
    };
    const scopes: Record<Who, McpCaller['scopes']> = { reader: ['factory:read'], writer: ['factory:write'] };
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
    const holdsAsked: number[] = [];
    const orgs = staticRegistry({
        config,
        telemetry: stubTelemetryClient(),
        repos: staticRepoSource([{ owner: 'acme', name: 'web' }]),
        jobs: jobStoreSlice({
            get: async () => RUN,
            thread: async () => [RUN],
            waitForSettle: async (_id: string, timeoutMs: number) => {
                holdsAsked.push(timeoutMs);
                const result = settle.holds.shift() === undefined ? settle.result : 'timeout';
                return { result, rootJobId: JOB, headJobId: JOB, headStatus: 'succeeded', waitReason: null };
            },
        }),
    });
    const app = track(await buildApp({ config, orgs, store: telemetryStoreStub(), auth, oauth: oauth as OAuthStore }));
    await app.listen({ port, host: LOCALHOST });
    return { url: new URL(resource), holdsAsked };
}

const callTool = async (url: URL, who: Who, args: Record<string, unknown>, onprogress?: () => void) => {
    const client = new Client({ name: 'wait', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKENS[who]}` } } })
    );
    try {
        const result = await client.callTool(
            { name: 'wait_task', arguments: args },
            onprogress ? { onprogress } : undefined
        );
        return { ...result, data: result.structuredContent as Record<string, unknown> };
    } finally {
        await client.close();
    }
};

describe('wait_task over the real bridge', () => {
    it('holds on the board settle long-poll as a read-scope caller and answers the head verdict', async () => {
        const { url, holdsAsked } = await boot({ holds: [], result: 'terminal' });
        const out = await callTool(url, 'reader', { taskId: JOB });
        expect(out.isError).toBeFalsy();
        expect(out.data).toMatchObject({ result: 'succeeded', state: 'succeeded', taskId: JOB, summary: 'shipped' });
        expect(holdsAsked).toEqual([42_000]);
    });

    it('re-issues a timed-out hold within the budget and sends progress to a client that asked', async () => {
        const { url, holdsAsked } = await boot({ holds: [1], result: 'terminal' });
        let progressed = 0;
        const out = await callTool(url, 'reader', { taskId: JOB }, () => {
            progressed += 1;
        });
        expect(out.data).toMatchObject({ result: 'succeeded' });
        expect(holdsAsked).toHaveLength(2);
        expect(progressed).toBe(1);
    });

    it('refuses a caller without the read scope', async () => {
        const { url, holdsAsked } = await boot({ holds: [], result: 'terminal' });
        const out = await callTool(url, 'writer', { taskId: JOB });
        expect(out.isError).toBe(true);
        expect(out.data).toMatchObject({ outcome: 'refused', code: 'insufficient_scope' });
        expect(holdsAsked).toEqual([]);
    });
});
