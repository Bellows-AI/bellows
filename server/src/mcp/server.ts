import { McpServer, type AuthInfo, type McpRequestContext } from '@modelcontextprotocol/server';
import type { Caller } from '../auth/store.js';
import { registerTools, type ToolRuntime } from './registry.js';

/** The server name clients show; there is no per-deployment naming. */
const SERVER_NAME = 'factory';

/** What a request-scoped server is built from: the SDK's request context plus the caller the auth gate resolved. */
export interface BoardMcpContext {
    readonly era: McpRequestContext['era'];
    /** Null only when the request carried no resolved caller, which the gate never lets through. */
    readonly caller: Caller | null;
    /** The bridge and budgets the tools run with; absent in a test that registers no board tool. */
    readonly tools?: ToolRuntime;
}

/** The caller the auth gate resolved travels in `AuthInfo.extra`, the SDK's slot for data about the token. */
export const withCaller = (info: Omit<AuthInfo, 'extra'>, caller: Caller): AuthInfo => ({
    ...info,
    extra: { caller },
});

export const callerOfAuthInfo = (info: AuthInfo | undefined): Caller | null => {
    const caller = info?.extra?.caller;
    return caller ? (caller as Caller) : null;
};

/**
 * A fresh server per request, so nothing is shared between callers. It advertises no `tools.listChanged`: the
 * endpoint is stateless and multi-replica, so there is no stream to push a change down. Tools are registered here.
 */
export function createBoardMcpServer(version: string, context: BoardMcpContext): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version }, { capabilities: { tools: { listChanged: false } } });
    if (context.tools) registerTools(server, context.caller, context.tools);
    return server;
}
