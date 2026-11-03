import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SCOPE_OF_CLASS, classOf, type Scope } from '../auth/route-class.js';
import type { Caller } from '../auth/store.js';
import type { Bridge, BridgeRequest } from './bridge.js';
import { mapResult, refusal, inconclusive, type Tagged, type ToolOutcome } from './result.js';
import { secondsSince } from '../prometheus.js';
import type { Tool, ToolContext } from './tool.js';
import { listAvailableIntegrations, listConnections } from './tools/connections.js';
import { listExecutors, listRepos } from './tools/discovery.js';
import { listJobStreams, readJobLog } from './tools/logs.js';
import { preflightTask } from './tools/preflight.js';
import { investigateJob, jobActivity, listQuestions } from './tools/runs.js';
import { listSkills } from './tools/skills.js';
import { listJobs, listTasks } from './tools/tasks.js';
import { getTask, getTaskResult } from './tools/task-detail.js';
import { TASK_WRITE_TOOLS } from './tools/task-writes.js';
import { whoami } from './tools/whoami.js';

/** Alphabetical by name: `tools/list` is the same on every replica and every call. */
export const TOOLS: readonly Tool[] = [
    whoami,
    listRepos,
    listExecutors,
    listSkills,
    listConnections,
    listAvailableIntegrations,
    preflightTask,
    listTasks,
    getTask,
    getTaskResult,
    listJobs,
    investigateJob,
    jobActivity,
    listJobStreams,
    readJobLog,
    listQuestions,
    ...TASK_WRITE_TOOLS,
].sort((a, b) => a.name.localeCompare(b.name));

/** In-process cap on one caller's simultaneous tool calls (per replica). */
export const MAX_CONCURRENT_CALLS_PER_CALLER = 8;

export interface McpToolMetrics {
    mcpTool(tool: string, outcome: ToolOutcome, seconds: number): void;
}

export interface ToolRuntime {
    readonly bridge: Bridge;
    /** Wall-clock budget of one tool call, every board call inside it included. */
    readonly deadlineMs: number;
    readonly metrics?: McpToolMetrics | undefined;
    readonly now?: () => number;
    readonly active: Map<string, number>;
}

const CONFIRM_FIELD = z
    .boolean()
    .optional()
    .describe('Must be true to perform this destructive action. Omit to be told what it would do.');

const holds = (caller: Caller, scope: Scope): boolean => caller.scopes === 'all' || caller.scopes.includes(scope);

/** The tool's own scope plus the scope of every route it declares: a tool is callable only by a caller who can pass each hop. */
export const requiredScopes = (tool: Tool): readonly Scope[] => {
    const scopes = new Set<Scope>([tool.scope]);
    for (const [method, pattern] of tool.routes) {
        const routeClass = classOf(method, pattern);
        if (routeClass !== undefined && routeClass !== 'none') scopes.add(SCOPE_OF_CLASS[routeClass]);
    }
    return [...scopes];
};

const callerKey = (caller: Caller): string => `${caller.org.id}:${caller.user.id}`;

/** Registers every tool on a per-request server. */
export function registerTools(
    server: McpServer,
    caller: Caller | null,
    runtime: ToolRuntime,
    tools: readonly Tool[] = TOOLS
): void {
    const now = runtime.now ?? Date.now;
    for (const tool of tools) {
        const inputSchema = tool.confirm ? tool.input.extend({ confirm: CONFIRM_FIELD }) : tool.input;
        server.registerTool(
            tool.name,
            { description: tool.description, inputSchema, outputSchema: tool.output, annotations: tool.annotations },
            async (args: Record<string, unknown>, ctx: ServerContext): Promise<CallToolResult> => {
                const started = performance.now();
                const tagged = await execute({ tool, args, ctx, caller, runtime, now });
                runtime.metrics?.mcpTool(tool.name, tagged.outcome, secondsSince(started));
                return tagged.result;
            }
        );
    }
}

const declares = (tool: Tool, request: BridgeRequest): boolean => {
    const path = request.url.split('?')[0] ?? '';
    return tool.routes.some(
        ([method, pattern]) =>
            method === request.method && new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`).test(path)
    );
};

interface Execution {
    readonly tool: Tool;
    readonly args: Record<string, unknown>;
    readonly ctx: ServerContext;
    readonly caller: Caller | null;
    readonly runtime: ToolRuntime;
    readonly now: () => number;
}

async function execute({ tool, args, ctx, caller, runtime, now }: Execution): Promise<Tagged> {
    if (!caller) return { outcome: 'refused', result: refusal('unauthorized', 'No caller was resolved') };
    const needed = requiredScopes(tool);
    if (!needed.every((scope) => holds(caller, scope))) {
        return { outcome: 'refused', result: refusal('insufficient_scope', `This tool needs ${needed.join(' and ')}`) };
    }
    if (tool.confirm && args.confirm !== true) {
        return {
            outcome: 'refused',
            result: refusal('confirmation_required', `${tool.name} is destructive: call it again with confirm: true`),
        };
    }
    const key = callerKey(caller);
    const running = runtime.active.get(key) ?? 0;
    if (running >= MAX_CONCURRENT_CALLS_PER_CALLER) {
        return {
            outcome: 'refused',
            result: refusal('too_many_calls', `At most ${MAX_CONCURRENT_CALLS_PER_CALLER} tool calls at once`),
        };
    }
    runtime.active.set(key, running + 1);
    try {
        const deadlineAt = now() + runtime.deadlineMs;
        const signal = ctx.mcpReq.signal;
        const fetch = (request: BridgeRequest) => {
            // A tool reaches only the routes it declares, so the scope gate above covers every hop.
            if (!declares(tool, request)) throw new Error(`${tool.name} called an undeclared route`);
            return runtime.bridge.call(caller, request, { signal, deadlineAt });
        };
        const toolCtx: ToolContext = {
            caller,
            signal,
            fetch,
            call: async (request, schema, summarize) => mapResult(await fetch(request), schema, summarize),
            progress: async (progress, total, message) => {
                const progressToken = ctx.mcpReq._meta?.progressToken;
                if (progressToken === undefined) return;
                await ctx.mcpReq.notify({
                    method: 'notifications/progress',
                    params: {
                        progressToken,
                        progress,
                        ...(total === undefined ? {} : { total }),
                        ...(message === undefined ? {} : { message }),
                    },
                });
            },
        };
        const { confirm: _confirm, ...rest } = args;
        const tagged = await tool.run(tool.confirm ? rest : args, toolCtx);
        if (tagged.outcome === 'ok' && !tool.output.safeParse(tagged.result.structuredContent).success) {
            return { outcome: 'inconclusive', result: inconclusive('the board answer did not match the tool output') };
        }
        return tagged;
    } catch {
        // A tool that threw reached no verdict about the board; the error text is not a result the caller can act on.
        return { outcome: 'inconclusive', result: inconclusive('the tool failed before it could finish') };
    } finally {
        const left = (runtime.active.get(key) ?? 1) - 1;
        if (left <= 0) runtime.active.delete(key);
        else runtime.active.set(key, left);
    }
}
