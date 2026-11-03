import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SCOPE_OF_CLASS, bridgeOpen, classOf } from '../src/auth/route-class.js';
import type { Caller } from '../src/auth/store.js';
import type { Bridge, BridgeLimits } from '../src/mcp/bridge.js';
import { MAX_CONCURRENT_CALLS_PER_CALLER, TOOLS, registerTools, type ToolRuntime } from '../src/mcp/registry.js';
import { DESTRUCTIVE, READ_ONLY, WRITES, defineTool } from '../src/mcp/tool.js';
import { memoryAuthStore } from './helpers.js';

describe('the static registry', () => {
    it('lists tools in a deterministic order with unique names', () => {
        const names = TOOLS.map((tool) => tool.name);
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
        expect(new Set(names).size).toBe(names.length);
    });

    it.each(TOOLS.map((tool) => [tool.name, tool] as const))(
        '%s: its scope agrees with the class of every backing route',
        (_name, tool) => {
            expect(tool.routes.length).toBeGreaterThan(0);
            for (const [method, pattern] of tool.routes) {
                const routeClass = classOf(method, pattern);
                if (routeClass === undefined) {
                    // Only the open identity routes the bridge is allowed through carry no class.
                    expect(bridgeOpen(method, pattern), `${method} ${pattern} has no class`).toBe(true);
                    expect(tool.scope).toBe('factory:read');
                } else {
                    expect(routeClass, `${method} ${pattern} is never reachable by a scoped caller`).not.toBe('none');
                    expect(tool.scope).toBe(SCOPE_OF_CLASS[routeClass as 'read' | 'write']);
                }
            }
        }
    );

    it.each(TOOLS.map((tool) => [tool.name, tool] as const))('%s: it declares an output schema', (_name, tool) => {
        expect(tool.output).toBeInstanceOf(z.ZodObject);
    });

    it.each(TOOLS.map((tool) => [tool.name, tool] as const))(
        '%s: its annotations state all four hints and agree with its scope',
        (_name, tool) => {
            const a = tool.annotations;
            expect(typeof a.readOnlyHint).toBe('boolean');
            expect(typeof a.destructiveHint).toBe('boolean');
            expect(typeof a.idempotentHint).toBe('boolean');
            expect(a.openWorldHint).toBe(false);
            expect(a.readOnlyHint).toBe(tool.scope === 'factory:read');
            if (a.destructiveHint) expect(tool.confirm).toBe(true);
        }
    );
});

// --- the runtime wrapper, driven through a stand-in server that captures the handler ---

type Handler = (
    args: Record<string, unknown>,
    ctx: ServerContext
) => Promise<{ isError?: boolean; structuredContent?: unknown }>;

const capture = () => {
    const handlers = new Map<string, Handler>();
    const configs = new Map<string, { inputSchema: z.ZodObject; outputSchema: z.ZodObject; annotations: unknown }>();
    const server = {
        registerTool: (
            name: string,
            config: { inputSchema: z.ZodObject; outputSchema: z.ZodObject; annotations: unknown },
            handler: Handler
        ) => {
            handlers.set(name, handler);
            configs.set(name, config);
        },
    } as unknown as McpServer;
    return { server, handlers, configs };
};

const callerWith = (scopes: Caller['scopes']): Caller => ({
    ...memoryAuthStore().seedMember('org-a', 'octocat', 'admin'),
    scopes,
});
const ctxOf = (signal = new AbortController().signal, progressToken?: string) =>
    ({
        mcpReq: {
            signal,
            _meta: progressToken === undefined ? undefined : { progressToken },
            notify: vi.fn(async () => undefined),
        },
    }) as unknown as ServerContext;

const runtimeOf = (bridge: Bridge): ToolRuntime & { observed: unknown[][] } => {
    const observed: unknown[][] = [];
    return {
        bridge,
        deadlineMs: 1000,
        active: new Map(),
        metrics: { mcpTool: (...args) => void observed.push(args) },
        observed,
    };
};

const okBridge: Bridge = { call: async () => ({ kind: 'response', status: 200, body: { n: 1 } }) };

const probe = defineTool({
    name: 'probe',
    description: 'test',
    scope: 'factory:write',
    routes: [['POST', '/api/workflows']],
    annotations: DESTRUCTIVE,
    confirm: true,
    input: z.object({ id: z.string() }),
    output: z.object({ n: z.number() }),
    run: async (args, ctx) => {
        await ctx.progress(1, 2, 'half');
        return ctx.call({ method: 'POST', url: `/x/${args.id}` }, z.object({ n: z.number() }), (d) => `n=${d.n}`);
    },
});

describe('the tool wrapper', () => {
    it('adds the confirm argument and refuses to act without confirm: true', async () => {
        const { server, handlers, configs } = capture();
        const bridge = { call: vi.fn(okBridge.call) };
        registerTools(server, callerWith('all'), runtimeOf(bridge), [probe]);
        expect(Object.keys(configs.get('probe')!.inputSchema.shape)).toEqual(['id', 'confirm']);
        const refused = await handlers.get('probe')!({ id: 'a' }, ctxOf());
        expect(refused.isError).toBe(true);
        expect(refused.structuredContent).toMatchObject({ outcome: 'refused', code: 'confirmation_required' });
        expect(bridge.call).not.toHaveBeenCalled();
        const done = await handlers.get('probe')!({ id: 'a', confirm: true }, ctxOf());
        expect(done.isError).toBeUndefined();
        expect(done.structuredContent).toEqual({ n: 1 });
    });

    it('refuses a caller without the tool scope before the bridge is touched', async () => {
        const { server, handlers } = capture();
        const bridge = { call: vi.fn(okBridge.call) };
        registerTools(server, callerWith(['factory:read']), runtimeOf(bridge), [probe]);
        const refused = await handlers.get('probe')!({ id: 'a', confirm: true }, ctxOf());
        expect(refused.structuredContent).toMatchObject({ code: 'insufficient_scope' });
        expect(bridge.call).not.toHaveBeenCalled();
    });

    it('passes the request signal and one shared deadline to every bridge call, and sends progress only on request', async () => {
        const { server, handlers } = capture();
        const seen: BridgeLimits[] = [];
        const bridge: Bridge = {
            call: async (_caller, _request, limits) => {
                seen.push(limits);
                return { kind: 'response', status: 200, body: { n: 1 } };
            },
        };
        registerTools(server, callerWith('all'), runtimeOf(bridge), [probe]);
        const aborter = new AbortController();
        const withToken = ctxOf(aborter.signal, 'tok');
        await handlers.get('probe')!({ id: 'a', confirm: true }, withToken);
        expect(seen[0]?.signal).toBe(aborter.signal);
        expect(seen[0]?.deadlineAt).toBeGreaterThan(Date.now());
        expect(withToken.mcpReq.notify).toHaveBeenCalledWith({
            method: 'notifications/progress',
            params: { progressToken: 'tok', progress: 1, total: 2, message: 'half' },
        });
        const without = ctxOf();
        await handlers.get('probe')!({ id: 'a', confirm: true }, without);
        expect(without.mcpReq.notify).not.toHaveBeenCalled();
    });

    it('caps one caller at MAX_CONCURRENT_CALLS_PER_CALLER and frees the slot afterwards', async () => {
        const { server, handlers } = capture();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const bridge: Bridge = {
            call: async () => {
                await gate;
                return { kind: 'response', status: 200, body: { n: 1 } };
            },
        };
        registerTools(server, callerWith('all'), runtimeOf(bridge), [probe]);
        const run = () => handlers.get('probe')!({ id: 'a', confirm: true }, ctxOf());
        const inFlight = Array.from({ length: MAX_CONCURRENT_CALLS_PER_CALLER }, run);
        const over = await run();
        expect(over.structuredContent).toMatchObject({ outcome: 'refused', code: 'too_many_calls' });
        release();
        expect((await Promise.all(inFlight)).every((r) => r.isError === undefined)).toBe(true);
        expect((await run()).isError).toBeUndefined();
    });

    it('advertises the output schema to the server', () => {
        const { server, configs } = capture();
        registerTools(server, callerWith('all'), runtimeOf(okBridge), [probe]);
        expect(configs.get('probe')?.outputSchema).toBe(probe.output);
    });

    it('a success whose structured content fails the output schema is inconclusive, not success', async () => {
        const { server, handlers } = capture();
        const drifted = defineTool({
            name: 'drifted',
            description: 'test',
            scope: 'factory:read',
            routes: [['GET', '/api/org/members']],
            annotations: READ_ONLY,
            input: z.object({}),
            output: z.object({ n: z.number() }),
            run: async (_args, ctx) => ctx.call({ method: 'GET', url: '/x' }, z.object({}).loose(), () => 'ok'),
        });
        const bridge: Bridge = { call: async () => ({ kind: 'response', status: 200, body: { n: 'one' } }) };
        const runtime = runtimeOf(bridge);
        registerTools(server, callerWith('all'), runtime, [drifted]);
        const result = await handlers.get('drifted')!({}, ctxOf());
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ outcome: 'inconclusive' });
        expect(runtime.observed[0]?.[1]).toBe('inconclusive');
    });

    it('turns a thrown tool into an inconclusive result and records the outcome', async () => {
        const { server, handlers } = capture();
        const boom = defineTool({
            name: 'boom',
            description: 'test',
            scope: 'factory:read',
            routes: [['GET', '/api/org/members']],
            annotations: READ_ONLY,
            input: z.object({}),
            output: z.object({}),
            run: async () => {
                throw new Error('secret detail');
            },
        });
        const runtime = runtimeOf(okBridge);
        registerTools(server, callerWith('all'), runtime, [boom]);
        const result = await handlers.get('boom')!({}, ctxOf());
        expect(result.structuredContent).toMatchObject({ outcome: 'inconclusive' });
        expect(JSON.stringify(result)).not.toContain('secret detail');
        expect(runtime.observed).toEqual([['boom', 'inconclusive', expect.any(Number)]]);
        expect(WRITES.readOnlyHint).toBe(false);
    });
});
