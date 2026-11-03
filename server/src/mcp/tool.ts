import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { Scope } from '../auth/route-class.js';
import type { Caller } from '../auth/store.js';
import type { BridgeOutcome, BridgeRequest } from './bridge.js';
import type { Tagged } from './result.js';

/** Annotation presets, so a tool states its kind in one word and the four hints never disagree with each other. */
export const READ_ONLY: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
export const WRITES: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};
export const DESTRUCTIVE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
};

/** What a tool body gets: the bridge bound to this request's caller, deadline and abort signal. */
export interface ToolContext {
    readonly caller: Caller;
    /** Aborts when the client leaves; the bridge already honours it. */
    readonly signal: AbortSignal;
    /** The clock the call's deadline is measured on. */
    readonly now: () => number;
    /** One board call, unjudged. Every call of a tool call shares one wall-clock deadline. */
    fetch(request: BridgeRequest): Promise<BridgeOutcome>;
    /** One board call whose 2xx data (checked by `schema`) is the whole result. */
    call<S extends z.ZodType<Record<string, unknown>>>(
        request: BridgeRequest,
        schema: S,
        summarize: (data: z.output<S>) => string
    ): Promise<Tagged>;
    /** A progress notification when the client asked for one (`_meta.progressToken`); otherwise a no-op. */
    progress(progress: number, total?: number, message?: string): Promise<void>;
}

/** A backing route as the router registered it (method and pattern), the form `route-class.ts` is keyed by. */
export type RouteRef = readonly [method: string, pattern: string];

export interface ToolSpec<I extends z.ZodObject = z.ZodObject> {
    readonly name: string;
    readonly description: string;
    /** The scope a caller must hold; it must equal the class of every backing route (`mcp.registry.test.ts`). */
    readonly scope: Scope;
    /** Every board route the tool calls. */
    readonly routes: readonly RouteRef[];
    readonly annotations: ToolAnnotations;
    /** A destructive tool sets this: an optional `confirm` argument is added and `confirm: true` is required to act. */
    readonly confirm?: true;
    readonly input: I;
    /** The shape of a success's structured content; required, so a tool cannot skip it. A result that fails it is inconclusive. */
    readonly output: z.ZodObject;
    run(args: z.output<I>, ctx: ToolContext): Promise<Tagged>;
}

/** The type-erased form the registry holds; `defineTool` is the one place the argument type is lost. */
export type Tool = ToolSpec<z.ZodObject>;

/** Declares a tool. Add it to `TOOLS` below; order does not matter, the list is sorted by name. */
export const defineTool = <I extends z.ZodObject>(spec: ToolSpec<I>): Tool => spec as unknown as Tool;
