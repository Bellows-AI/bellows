import { request as httpRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { setAuthInfo } from '../src/mcp/auth-info.js';
import { mcpRoutes } from '../src/mcp/routes.js';
import { withCaller } from '../src/mcp/server.js';
import { memoryAuthStore } from './helpers.js';
import { HTTP_OK, HTTP_TOO_MANY_REQUESTS, trackApps } from './helpers-http.js';

const track = trackApps();

const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const ORG = 'test-org';
const OTHER_ORG = 'other-org';

const callHang = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
        name: 'hang',
        arguments: {},
        _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientInfo': { name: 'probe', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
        },
    },
};

/** An MCP endpoint whose one tool holds its stream open until released; the caller's org rides the `x-test-org` header. */
async function boot(streamsPerOrg: number) {
    let started = 0;
    const waiters: (() => void)[] = [];
    let releaseAll!: () => void;
    const released = new Promise<void>((resolve) => (releaseAll = resolve));
    const app = track(Fastify());
    app.decorateRequest('closing', { getter: () => new AbortController().signal });
    const store = memoryAuthStore();
    const callers = new Map([
        [ORG, store.seedMember(ORG, 'octocat')],
        [OTHER_ORG, store.seedMember(OTHER_ORG, 'mallory')],
    ]);
    app.addHook('onRequest', async (request) => {
        const caller = callers.get(String(request.headers['x-test-org']))!;
        setAuthInfo(request, withCaller({ token: 't', clientId: 'c', scopes: [] }, caller));
    });
    await app.register(mcpRoutes, {
        version: '0.0.0',
        batches: false,
        origin: 'http://127.0.0.1',
        streamsPerOrg,
        buildServer: () => {
            const server = new McpServer({ name: 'probe', version: '0' }, { capabilities: { tools: {} } });
            server.registerTool('hang', { description: 'holds the stream' }, async () => {
                started += 1;
                for (const wake of waiters.splice(0)) wake();
                await released;
                return { content: [] };
            });
            return server;
        },
    });
    await app.listen({ port: 0, host: LOCALHOST });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const startedAtLeast = (n: number) =>
        new Promise<void>((resolve) => {
            const check = () => (started >= n ? resolve() : waiters.push(check));
            check();
        });
    return { app, port, releaseAll, startedAtLeast };
}

function post(port: number, org: string): Promise<{ status: number; retryAfter: string | undefined }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            {
                host: LOCALHOST,
                port,
                path: '/api/mcp',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    'mcp-protocol-version': MODERN,
                    'mcp-method': 'tools/call',
                    'mcp-name': 'hang',
                    'x-test-org': org,
                },
            },
            (res) => {
                res.resume();
                res.on('end', () =>
                    resolve({ status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'] as string })
                );
            }
        );
        req.on('error', reject);
        req.end(JSON.stringify(callHang));
    });
}

describe('the MCP stream cap per organization', () => {
    it('refuses a stream over the cap with 429 and Retry-After, counts orgs apart, and frees the slot on finish', async () => {
        const { port, releaseAll, startedAtLeast } = await boot(1);
        const held = post(port, ORG);
        await startedAtLeast(1);

        const refused = await post(port, ORG);
        expect(refused.status).toBe(HTTP_TOO_MANY_REQUESTS);
        expect(Number(refused.retryAfter)).toBeGreaterThan(0);

        const other = post(port, OTHER_ORG);
        await startedAtLeast(2);

        releaseAll();
        expect((await held).status).toBe(HTTP_OK);
        expect((await other).status).toBe(HTTP_OK);
        expect((await post(port, ORG)).status).toBe(HTTP_OK);
    });
});
