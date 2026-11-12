import { request as httpRequest, createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/server';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AuthConfig } from '../src/config.js';
import type { McpCaller, OAuthStore } from '../src/auth/oauth-store.js';
import { hashToken } from '../src/auth/session.js';
import { LOCAL_ORG_ID } from '../src/identifiers.js';
import { setAuthInfo } from '../src/mcp/auth-info.js';
import { originPermitted } from '../src/mcp/origin.js';
import { pipeResponse } from '../src/mcp/pipe.js';
import { mcpRoutes } from '../src/mcp/routes.js';
import { withCaller } from '../src/mcp/server.js';
import {
    githubAuth,
    memoryAuthStore,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_OK,
    HTTP_PAYLOAD_TOO_LARGE,
    HTTP_SERVICE_UNAVAILABLE,
    HTTP_UNAUTHORIZED,
    trackApps,
} from './helpers-http.js';
import { storeOutage } from './helpers-outage.js';

const TOOL_NAMES = [
    'accept_batch_task',
    'answer_question',
    'batch_report',
    'cancel_batch',
    'create_attachment_upload',
    'create_task',
    'edit_task',
    'follow_up_task',
    'force_close_task',
    'get_batch_tasks',
    'get_task',
    'get_task_result',
    'import_batch',
    'inspect_batch',
    'investigate_job',
    'job_activity',
    'list_available_integrations',
    'list_batches',
    'list_connections',
    'list_executors',
    'list_job_streams',
    'list_jobs',
    'list_questions',
    'list_repos',
    'list_skills',
    'list_tasks',
    'mark_task_done',
    'preflight_task',
    'read_job_log',
    'remove_task',
    'reopen_task',
    'retry_batch_task',
    'retry_task',
    'start_batch',
    'stop_task',
    'update_batch',
    'validate_batch',
    'wait_batch',
    'wait_task',
    'whoami',
];

const track = trackApps();

const ORG = 'test-org';
const LOCALHOST = '127.0.0.1';
const HTTP_METHOD_NOT_ALLOWED = 405;
const MODERN = '2026-07-28';
const TOKEN = 'mat_transport-test-token-0123456789';
const WRONG_AUDIENCE_TOKEN = 'mat_wrong-audience-token-0123456789';
const EXPIRED_TOKEN = 'mat_expired-token-0123456789';
const REVOKED_TOKEN = 'mat_revoked-token-0123456789';
const TRUSTED = 'https://trusted.example';

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

interface Reply {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    text: string;
}

/** A raw POST, so a test controls `Host`, `Origin` and the protocol headers that a client library would set. */
const post = (
    port: number,
    body: unknown,
    headers: Record<string, string> = {},
    { path = '/api/mcp', method = 'POST' }: { path?: string; method?: string } = {}
): Promise<Reply> =>
    new Promise((resolve, reject) => {
        const payload = typeof body === 'string' ? body : JSON.stringify(body);
        const req = httpRequest(
            {
                host: LOCALHOST,
                port,
                path,
                method,
                headers: {
                    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
                    accept: 'application/json, text/event-stream',
                    ...headers,
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        text: Buffer.concat(chunks).toString(),
                    })
                );
            }
        );
        req.on('error', reject);
        req.end(method === 'POST' ? payload : undefined);
    });

/** The JSON-RPC message in a reply that is either a JSON body or one SSE `data:` event. */
const messageOf = (reply: Reply): { result?: Record<string, unknown>; error?: { code: number } } => {
    const data = reply.text.split('\n').find((line) => line.startsWith('data:'));
    return JSON.parse(data ? data.slice('data:'.length) : reply.text);
};

const legacyInitialize = (protocolVersion: string) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
});

const modernList = {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/list',
    params: {
        _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientInfo': { name: 'probe', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
        },
    },
};
const modernHeaders = { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' };

interface Board {
    port: number;
    url: URL;
    publicUrl: string;
    seen: { lookups: number };
}

/** The whole app, listening, with a stand-in OAuth store that knows two tokens: one for this resource and one for another. */
async function boot(
    mode: 'github' | 'none',
    { enabled = true, failLookup = false }: { enabled?: boolean; failLookup?: boolean } = {}
): Promise<Board> {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const store = memoryAuthStore();
    const caller = mode === 'github' ? store.seedMember(ORG, 'octocat', 'admin') : store.seedLocalUser(LOCAL_ORG_ID);
    const resource = `${publicUrl}/api/mcp`;
    const seen = { lookups: 0 };
    const known = new Map<string, string>([
        [hashToken(TOKEN).toString('hex'), resource],
        [hashToken(WRONG_AUDIENCE_TOKEN).toString('hex'), 'https://elsewhere.example/api/mcp'],
        [hashToken(EXPIRED_TOKEN).toString('hex'), resource],
        [hashToken(REVOKED_TOKEN).toString('hex'), resource],
    ]);
    // The real store's SQL filters these two rows out, so its answer for them is null.
    const lapsed = new Set([hashToken(EXPIRED_TOKEN).toString('hex'), hashToken(REVOKED_TOKEN).toString('hex')]);
    const oauth: Pick<OAuthStore, 'findAccessToken'> = {
        async findAccessToken(hash): Promise<McpCaller | null> {
            seen.lookups += 1;
            if (failLookup) throw storeOutage('connection refused');
            const audience = known.get(hash.toString('hex'));
            if (!audience || lapsed.has(hash.toString('hex'))) return null;
            return {
                ...caller,
                scopes: ['factory:read'],
                clientId: 'client-1',
                resource: audience,
                familyId: 'family-1',
            };
        },
    };
    const auth: AuthConfig = mode === 'github' ? githubAuth({ publicUrl }) : { mode: 'none', ingestToken: null };
    const config = testConfig({
        auth,
        port,
        mcp: enabled ? { enabled: true, resource, trustedOrigins: [TRUSTED] } : { enabled: false },
        // The tool-list pin below names the batch tools.
        batches: { enabled: true },
    });
    const app = track(
        await buildApp({
            config,
            orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
            store: telemetryStoreStub(),
            auth: store,
            oauth: oauth as OAuthStore,
        })
    );
    await app.listen({ port, host: LOCALHOST });
    return { port, url: new URL(resource), publicUrl, seen };
}

const bearer = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

describe('the endpoint, github mode', () => {
    it('answers a modern-era client (server/discover, then tools/list)', async () => {
        const board = await boot('github');
        const client = new ModernClient(
            { name: 'modern', version: '1' },
            { versionNegotiation: { mode: { pin: MODERN } } }
        );
        const versions: string[] = [];
        const fetchRecording: typeof fetch = (input, init) => {
            versions.push(new Headers(init?.headers).get('mcp-protocol-version') ?? '');
            return fetch(input, init);
        };
        await client.connect(
            new ModernTransport(board.url, { requestInit: { headers: bearer() }, fetch: fetchRecording })
        );
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
        // The registry is 40 tools: create_attachment_upload is the last addition (docs/mcp.md).
        expect(TOOL_NAMES).toHaveLength(40);
        expect(client.getServerVersion()?.name).toBe('factory');
        // The request headers of the modern era name the revision on every call, so none went out as 2025-11-25.
        expect(new Set(versions.filter(Boolean))).toEqual(new Set([MODERN]));
        await client.close();
    });

    it('negotiates automatically for a client that supports both eras', async () => {
        const board = await boot('github');
        const client = new ModernClient({ name: 'auto', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(new ModernTransport(board.url, { requestInit: { headers: bearer() } }));
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
        await client.close();
    });

    it('answers a legacy 2025-11-25 client, which gets no session', async () => {
        const board = await boot('github');
        const client = new LegacyClient({ name: 'legacy', version: '1' });
        const transport = new LegacyTransport(board.url, { requestInit: { headers: bearer() } });
        await client.connect(transport);
        expect(client.getServerVersion()?.name).toBe('factory');
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
        expect(transport.sessionId).toBeUndefined();
        await client.close();
    });

    it('answers a legacy 2025-06-18 initialize with that version', async () => {
        const board = await boot('github');
        const reply = await post(board.port, legacyInitialize('2025-06-18'), bearer());
        expect(reply.status).toBe(HTTP_OK);
        expect(messageOf(reply).result?.protocolVersion).toBe('2025-06-18');
    });

    it('does not advertise tools.listChanged', async () => {
        const board = await boot('github');
        const reply = await post(board.port, legacyInitialize('2025-11-25'), bearer());
        const capabilities = messageOf(reply).result?.capabilities as { tools?: { listChanged?: boolean } };
        expect(capabilities.tools?.listChanged).toBeFalsy();
    });

    it('refuses protocol 2024-11-05, in the body or in the header', async () => {
        const board = await boot('github');
        const byBody = await post(board.port, legacyInitialize('2024-11-05'), bearer());
        expect(byBody.status).toBe(HTTP_BAD_REQUEST);
        expect(messageOf(byBody).error?.code).toBe(-32602);
        const byHeader = await post(
            board.port,
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            { ...bearer(), 'mcp-protocol-version': '2024-11-05' }
        );
        expect(byHeader.status).toBe(HTTP_BAD_REQUEST);
    });

    it('refuses a modern request whose Mcp-Method header disagrees with the body, and takes it when they agree', async () => {
        const board = await boot('github');
        const agree = await post(board.port, modernList, { ...bearer(), ...modernHeaders });
        expect(agree.status).toBe(HTTP_OK);
        const mismatch = await post(board.port, modernList, {
            ...bearer(),
            ...modernHeaders,
            'mcp-method': 'tools/call',
        });
        expect(mismatch.status).toBe(HTTP_BAD_REQUEST);
        const missing = await post(board.port, modernList, { ...bearer(), 'mcp-protocol-version': MODERN });
        expect(missing.status).toBe(HTTP_BAD_REQUEST);
    });

    it('answers GET and DELETE with 405 and Allow: POST', async () => {
        const board = await boot('github');
        for (const method of ['GET', 'DELETE']) {
            const reply = await post(board.port, '', bearer(), { method });
            expect(reply.status).toBe(HTTP_METHOD_NOT_ALLOWED);
            expect(reply.headers.allow).toBe('POST');
        }
    });

    it('refuses a body over the route limit with 413', async () => {
        const board = await boot('github');
        const reply = await post(board.port, JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 1) }), bearer());
        expect(reply.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    });
});

describe('the auth gate, github mode', () => {
    const challenge = (board: Board) =>
        `Bearer scope="factory:read factory:write", resource_metadata="${board.publicUrl}/.well-known/oauth-protected-resource/api/mcp"`;

    it('answers a missing bearer with 401 and the resource-metadata challenge, without a database read', async () => {
        const board = await boot('github');
        const reply = await post(board.port, legacyInitialize('2025-11-25'));
        expect(reply.status).toBe(HTTP_UNAUTHORIZED);
        expect(reply.headers['www-authenticate']).toBe(challenge(board));
        expect(board.seen.lookups).toBe(0);
    });

    it('answers an unknown mat_ and a wrong-audience mat_ with the same 401', async () => {
        const board = await boot('github');
        for (const token of ['mat_unknown-token-0123456789', WRONG_AUDIENCE_TOKEN]) {
            const reply = await post(board.port, legacyInitialize('2025-11-25'), bearer(token));
            expect(reply.status).toBe(HTTP_UNAUTHORIZED);
            expect(reply.headers['www-authenticate']).toBe(challenge(board));
        }
    });

    it('answers an expired and a revoked mat_ with the same 401', async () => {
        const board = await boot('github');
        for (const token of [EXPIRED_TOKEN, REVOKED_TOKEN]) {
            const reply = await post(board.port, legacyInitialize('2025-11-25'), bearer(token));
            expect(reply.status).toBe(HTTP_UNAUTHORIZED);
            expect(reply.headers['www-authenticate']).toBe(challenge(board));
        }
        expect(board.seen.lookups).toBe(2);
    });

    it('accepts only a mat_: a personal token, an org token or a session cookie is a 401', async () => {
        const board = await boot('github');
        for (const headers of [
            bearer('fat_personal-token-0123456789'),
            bearer('oat_org-token-0123456789'),
            { cookie: 'factory_session=whatever' },
        ]) {
            const reply = await post(board.port, legacyInitialize('2025-11-25'), headers);
            expect(reply.status).toBe(HTTP_UNAUTHORIZED);
        }
        expect(board.seen.lookups).toBe(0);
    });

    it('answers a credential lookup that fails with 503, never 401', async () => {
        const board = await boot('github', { failLookup: true });
        const reply = await post(board.port, legacyInitialize('2025-11-25'), bearer());
        expect(reply.status).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(reply.headers['www-authenticate']).toBeUndefined();
        expect(board.seen.lookups).toBe(1);
    });
});

describe.each(['github', 'none'] as const)('Origin and Host, %s mode', (mode) => {
    const headersFor = (extra: Record<string, string> = {}) => (mode === 'github' ? { ...bearer(), ...extra } : extra);

    it('refuses a foreign Origin with 403 before any credential work', async () => {
        const board = await boot(mode);
        for (const origin of ['https://evil.example', 'null', `${TRUSTED}/`, 'https://trusted.example:444']) {
            const reply = await post(board.port, legacyInitialize('2025-11-25'), headersFor({ origin }));
            expect(reply.status).toBe(HTTP_FORBIDDEN);
        }
        expect(board.seen.lookups).toBe(0);
    });

    it('refuses a foreign Origin even with no credential', async () => {
        const board = await boot(mode);
        const reply = await post(board.port, legacyInitialize('2025-11-25'), { origin: 'https://evil.example' });
        expect(reply.status).toBe(HTTP_FORBIDDEN);
    });

    it("allows no Origin, the board's own Origin and an exactly trusted one", async () => {
        const board = await boot(mode);
        for (const origin of [undefined, board.publicUrl, TRUSTED]) {
            const reply = await post(board.port, legacyInitialize('2025-11-25'), headersFor(origin ? { origin } : {}));
            expect(reply.status).toBe(HTTP_OK);
        }
    });

    it('refuses a Host the board is not published under', async () => {
        const board = await boot(mode);
        for (const host of ['evil.example', 'rebind.example:80', `localhost.evil.example:${board.port}`]) {
            const reply = await post(board.port, legacyInitialize('2025-11-25'), headersFor({ host }));
            expect(reply.status).toBe(HTTP_FORBIDDEN);
        }
    });
});

describe('Host, none mode', () => {
    it('takes a loopback name only on the bound port', async () => {
        const board = await boot('none');
        for (const host of [`localhost:${board.port}`, `127.0.0.1:${board.port}`]) {
            expect((await post(board.port, legacyInitialize('2025-11-25'), { host })).status).toBe(HTTP_OK);
        }
        const wrongPort = await post(board.port, legacyInitialize('2025-11-25'), { host: 'localhost:1' });
        expect(wrongPort.status).toBe(HTTP_FORBIDDEN);
    });
});

describe('Host, github mode', () => {
    it('honours X-Forwarded-Host only when it is the public host', async () => {
        const board = await boot('github');
        const publicHost = new URL(board.publicUrl).host;
        const proxied = await post(board.port, legacyInitialize('2025-11-25'), {
            ...bearer(),
            host: 'internal.svc:8080',
            'x-forwarded-host': publicHost,
        });
        expect(proxied.status).toBe(HTTP_OK);
        const steered = await post(board.port, legacyInitialize('2025-11-25'), {
            ...bearer(),
            host: 'internal.svc:8080',
            'x-forwarded-host': 'evil.example',
        });
        expect(steered.status).toBe(HTTP_FORBIDDEN);
    });
});

describe('the endpoint, none mode', () => {
    it('is open: a client connects with no credential', async () => {
        const board = await boot('none');
        const client = new ModernClient({ name: 'auto', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(new ModernTransport(board.url));
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
        await client.close();
    });
});

describe('MCP_ENABLED off', () => {
    it.each(['github', 'none'] as const)('answers 404 in %s mode, with or without a credential', async (mode) => {
        const board = await boot(mode, { enabled: false });
        for (const headers of [{}, bearer()]) {
            const reply = await post(board.port, legacyInitialize('2025-11-25'), headers);
            expect(reply.status).toBe(HTTP_NOT_FOUND);
        }
        expect(board.seen.lookups).toBe(0);
    });

    it('registers no route at all', async () => {
        const config = testConfig();
        const app = track(
            await buildApp({
                config,
                orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
                store: telemetryStoreStub(),
                auth: memoryAuthStore(),
            })
        );
        expect(app.hasRoute({ method: 'POST', url: '/api/mcp' })).toBe(false);
    });
});

describe('a client that disconnects', () => {
    it('aborts the request signal the tool handler sees', async () => {
        let seen: AbortSignal | undefined;
        let release!: () => void;
        const started = new Promise<void>((resolve) => (release = resolve));
        const app = track(Fastify());
        // buildApp's decoration, which a bare instance lacks: the board is not closing.
        app.decorateRequest('closing', { getter: () => new AbortController().signal });
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat', 'admin');
        app.addHook('onRequest', async (request) => {
            setAuthInfo(request, withCaller({ token: 't', clientId: 'c', scopes: [] }, caller));
        });
        await app.register(mcpRoutes, {
            version: '0.0.0',
            batches: false,
            origin: 'http://127.0.0.1',
            buildServer: () => {
                const server = new McpServer({ name: 'probe', version: '0' }, { capabilities: { tools: {} } });
                server.registerTool('hang', { description: 'waits for an abort' }, async (ctx) => {
                    seen = ctx.mcpReq.signal;
                    release();
                    await new Promise<void>((resolve) => ctx.mcpReq.signal.addEventListener('abort', () => resolve()));
                    return { content: [] };
                });
                return server;
            },
        });
        await app.listen({ port: 0, host: LOCALHOST });
        const address = app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;

        const call = {
            ...modernList,
            method: 'tools/call',
            params: { ...modernList.params, name: 'hang', arguments: {} },
        };
        const req = httpRequest({
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
            },
        });
        req.on('error', () => undefined);
        req.end(JSON.stringify(call));
        await started;
        expect(seen?.aborted).toBe(false);
        req.destroy();
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('the signal never aborted')), 5000);
            seen?.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve();
            });
            if (seen?.aborted) resolve();
        });
        expect(seen?.aborted).toBe(true);
    });
});

describe('pipeResponse when the client is already gone', () => {
    it('settles and cancels the body when the connection closed before the response was ready', async () => {
        let cancelled = false;
        // An endless body: only a departed client can end the pipe.
        const response = new Response(
            new ReadableStream<Uint8Array>({
                pull(controller) {
                    controller.enqueue(new Uint8Array(65_536));
                },
                cancel() {
                    cancelled = true;
                },
            })
        );
        let settled!: Promise<void>;
        const server = createHttpServer((_req, res) => {
            // The fetch "resolves" only after the client disconnected: 'close' has already fired by now.
            res.once('close', () => {
                settled = pipeResponse(response, res);
            });
        });
        await new Promise<void>((resolve) => server.listen(0, LOCALHOST, resolve));
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        try {
            const req = httpRequest({ host: LOCALHOST, port, method: 'POST' });
            req.on('error', () => undefined);
            req.end('{}');
            await new Promise((resolve) => setTimeout(resolve, 50));
            req.destroy();
            await new Promise((resolve) => setTimeout(resolve, 100));
            await Promise.race([
                settled,
                new Promise((_, reject) => setTimeout(() => reject(new Error('pipeResponse never settled')), 2000)),
            ]);
            expect(cancelled).toBe(true);
        } finally {
            server.close();
        }
    });

    it('leaves no drain listener behind when the client leaves mid-backpressure', async () => {
        let listeners = -1;
        let settled!: Promise<void>;
        const endless = new Response(
            new ReadableStream<Uint8Array>({
                pull(controller) {
                    controller.enqueue(new Uint8Array(65_536));
                },
            })
        );
        const server = createHttpServer((_req, res) => {
            settled = pipeResponse(endless, res).then(() => {
                listeners = res.listenerCount('drain');
            });
        });
        await new Promise<void>((resolve) => server.listen(0, LOCALHOST, resolve));
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        try {
            const req = httpRequest({ host: LOCALHOST, port, method: 'POST' });
            req.on('error', () => undefined);
            // Never read the response: the server's socket buffer fills and the pipe waits for a drain.
            req.on('response', (res) => res.pause());
            req.end('{}');
            await new Promise((resolve) => setTimeout(resolve, 200));
            req.destroy();
            await Promise.race([
                settled,
                new Promise((_, reject) => setTimeout(() => reject(new Error('pipeResponse never settled')), 2000)),
            ]);
            expect(listeners).toBe(0);
        } finally {
            server.close();
        }
    });
});

describe('Bearer scheme', () => {
    it('is matched case-insensitively (RFC 6750)', async () => {
        const board = await boot('github');
        for (const scheme of ['bearer', 'BEARER']) {
            const reply = await post(board.port, legacyInitialize('2025-11-25'), {
                authorization: `${scheme} ${TOKEN}`,
            });
            expect(reply.status).toBe(HTTP_OK);
        }
    });
});

describe('Host default ports', () => {
    it('accepts the public host written with its scheme default port', async () => {
        const origin = {
            publicOrigin: 'https://board.example',
            trustedOrigins: [],
            mode: 'github',
            port: undefined,
        } as const;
        const base = { origin: undefined, forwardedHost: undefined };
        expect(originPermitted(origin, { ...base, host: 'board.example:443' })).toBe(true);
        expect(originPermitted(origin, { ...base, host: 'board.example' })).toBe(true);
        expect(originPermitted(origin, { ...base, host: 'board.example:8443' })).toBe(false);
        const plain = { ...origin, publicOrigin: 'http://board.example' } as const;
        expect(originPermitted(plain, { ...base, host: 'board.example:80' })).toBe(true);
        expect(originPermitted(plain, { ...base, host: 'board.example:443' })).toBe(false);
    });
});

describe('a client that left before the handler ran', () => {
    it('hands the SDK an already aborted signal', async () => {
        const abortedAtCall: boolean[] = [];
        const app = track(Fastify());
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat', 'admin');
        let gone!: Promise<void>;
        app.addHook('onRequest', async (request) => {
            setAuthInfo(request, withCaller({ token: 't', clientId: 'c', scopes: [] }, caller));
        });
        app.addHook('preHandler', async (_request, reply) => {
            // Hold the request until the client has gone, so 'close' fires before the route handler attaches.
            gone = new Promise<void>((resolve) => reply.raw.once('close', resolve));
            await gone;
        });
        await app.register(mcpRoutes, {
            version: '0.0.0',
            batches: false,
            origin: 'http://127.0.0.1',
            buildServer: () => {
                const server = new McpServer({ name: 'probe', version: '0' }, { capabilities: { tools: {} } });
                server.registerTool('probe', { description: 'records its signal' }, async (ctx) => {
                    abortedAtCall.push(ctx.mcpReq.signal.aborted);
                    return { content: [] };
                });
                return server;
            },
        });
        await app.listen({ port: 0, host: LOCALHOST });
        const address = app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const call = {
            ...modernList,
            method: 'tools/call',
            params: { ...modernList.params, name: 'probe', arguments: {} },
        };
        const req = httpRequest({
            host: LOCALHOST,
            port,
            path: '/api/mcp',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'mcp-protocol-version': MODERN,
                'mcp-method': 'tools/call',
                'mcp-name': 'probe',
            },
        });
        req.on('error', () => undefined);
        req.end(JSON.stringify(call));
        await new Promise((resolve) => setTimeout(resolve, 100));
        req.destroy();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) => setTimeout(resolve, 500));
        // A tool that ran with a live signal is the bug: it would keep working for a client that is gone.
        expect(abortedAtCall).not.toContain(false);
    });
});
