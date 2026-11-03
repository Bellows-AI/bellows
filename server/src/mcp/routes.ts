import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE } from '@factory-ai/core';
import { createBridge } from './bridge.js';
import type { McpToolMetrics } from './registry.js';
import { callerOfAuthInfo, createBoardMcpServer, type BoardMcpContext } from './server.js';
import { authInfoOf } from './auth-info.js';
import { pipeResponse } from './pipe.js';
import { MCP_PATH } from '../config-mcp.js';

/** A tool call's arguments are small; 1 MiB bounds what an unauthenticated-looking body can cost before parsing. */
const MCP_BODY_LIMIT_BYTES = 1_048_576;

/** Claude Code stops waiting for a tool at 60 s; the board answers (even inconclusively) before that. */
const TOOL_DEADLINE_MS = 55_000;

/** The one protocol revision the SDK still answers that this board refuses: it predates Streamable HTTP. */
const REFUSED_PROTOCOL_VERSION = '2024-11-05';

const HTTP_BAD_REQUEST = 400;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_SERVER_ERROR = 500;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL = -32603;

/** Headers the SDK has no use for: the credential travels in `AuthInfo`, and the body is re-serialised. */
const NOT_FORWARDED = new Set(['authorization', 'cookie', 'content-length', 'transfer-encoding', 'host', 'connection']);

const requestedVersions = (request: FastifyRequest): string[] => {
    const messages: unknown[] = Array.isArray(request.body) ? request.body : [request.body];
    const versions = messages.flatMap((message) => {
        const params = (message as { method?: unknown; params?: { protocolVersion?: unknown } } | null) ?? {};
        return params.method === 'initialize' && typeof params.params?.protocolVersion === 'string'
            ? [params.params.protocolVersion]
            : [];
    });
    const header = request.headers['mcp-protocol-version'];
    return typeof header === 'string' ? [...versions, header] : versions;
};

const idOf = (body: unknown): string | number | null => {
    const id = (Array.isArray(body) ? body[0] : body) as { id?: unknown } | null;
    return typeof id?.id === 'string' || typeof id?.id === 'number' ? id.id : null;
};

const jsonRpcError = (
    reply: FastifyReply,
    status: number,
    error: { id: string | number | null; code: number; message: string }
) => reply.code(status).send({ jsonrpc: '2.0', id: error.id, error: { code: error.code, message: error.message } });

const webRequestOf = (request: FastifyRequest, origin: string, signal: AbortSignal): Request => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        if (NOT_FORWARDED.has(name) || value === undefined) continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    return new Request(new URL(request.url, origin), {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
        signal,
    });
};

export interface McpRouteDeps {
    readonly version: string;
    /** The board's public origin; only the base of the Request the SDK is handed, never a trust decision. */
    readonly origin: string;
    /** Builds the per-request server; defaults to the board's own. A seam for tests that need a tool of their own. */
    readonly metrics?: McpToolMetrics | undefined;
    /** One tool call's wall-clock budget; it stays under Claude Code's 60 s hard stop. Tests compress it. */
    readonly toolDeadlineMs?: number;
    readonly buildServer?: (version: string, context: BoardMcpContext) => McpServer;
}

/**
 * `POST /api/mcp`: Streamable HTTP, stateless. The auth gate (`enforceMcp`) has already resolved the caller by the
 * time this runs, so the handler only moves bytes between Fastify and the SDK's fetch-style handler.
 */
export async function mcpRoutes(
    app: FastifyInstance,
    { version, origin, metrics, toolDeadlineMs = TOOL_DEADLINE_MS, buildServer = createBoardMcpServer }: McpRouteDeps
): Promise<void> {
    const tools = { bridge: createBridge(app), deadlineMs: toolDeadlineMs, metrics, active: new Map<string, number>() };
    const handler = createMcpHandler(
        (context) => buildServer(version, { era: context.era, caller: callerOfAuthInfo(context.authInfo), tools }),
        { legacy: 'stateless', onerror: (error) => app.log.error(error) }
    );
    app.addHook('onClose', async () => handler.close());

    app.post(MCP_PATH, { bodyLimit: MCP_BODY_LIMIT_BYTES }, async (request, reply) => {
        const authInfo = authInfoOf(request);
        if (!authInfo) {
            // The gate sets it on every request that gets here; a miss is a wiring fault, never a credential verdict.
            return jsonRpcError(reply, HTTP_SERVER_ERROR, {
                id: null,
                code: JSONRPC_INTERNAL,
                message: 'No caller resolved',
            });
        }
        if (requestedVersions(request).includes(REFUSED_PROTOCOL_VERSION)) {
            return jsonRpcError(reply, HTTP_BAD_REQUEST, {
                id: idOf(request.body),
                code: JSONRPC_INVALID_PARAMS,
                message: `Unsupported protocol version ${REFUSED_PROTOCOL_VERSION}`,
            });
        }

        // A client that disconnects before the response finished must stop the work behind it.
        const aborted = new AbortController();
        reply.raw.on('close', () => {
            if (!reply.raw.writableFinished) aborted.abort();
        });
        // 'close' may already have fired while the body was parsed; the listener above would never hear it.
        if (reply.raw.destroyed || reply.raw.closed) aborted.abort();
        reply.hijack();
        try {
            const response = await handler.fetch(webRequestOf(request, origin, aborted.signal), {
                authInfo,
                parsedBody: request.body,
            });
            await pipeResponse(response, reply.raw);
        } catch (error) {
            request.log.error(error);
            if (!reply.raw.headersSent) {
                reply.raw.writeHead(HTTP_SERVER_ERROR, { [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE });
                reply.raw.end(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: idOf(request.body),
                        error: { code: JSONRPC_INTERNAL, message: 'Internal error' },
                    })
                );
            } else {
                reply.raw.destroy();
            }
        }
    });

    // Stateless: there is no stream to open and no session to end.
    app.route({
        method: ['GET', 'DELETE'],
        url: MCP_PATH,
        handler: async (_request, reply) =>
            reply.code(HTTP_METHOD_NOT_ALLOWED).header('allow', 'POST').send({ error: 'Method not allowed' }),
    });
}
