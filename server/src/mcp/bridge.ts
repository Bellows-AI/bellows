import type { FastifyInstance } from 'fastify';
import { bridgedRequestClass, type BridgedCaller } from '../auth/bridge-binding.js';
import { SCOPES } from '../auth/route-class.js';
import type { Caller } from '../auth/store.js';

/** The only client-supplied header a bridged call carries; the caller travels on the request class, never a header. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export interface BridgeRequest {
    readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** The path and query of a board route, as a client of that route would write it. */
    readonly url: string;
    readonly body?: unknown;
    readonly idempotencyKey?: string;
}

export interface BridgeLimits {
    /** Client disconnect or tool cancellation; aborts the inject. */
    readonly signal?: AbortSignal | undefined;
    /** Absolute wall-clock deadline (epoch ms), shared by every call of one tool call. */
    readonly deadlineAt: number;
}

/**
 * What came back from the board, before anyone has judged it. `inconclusive` means no verdict was reached: the
 * deadline passed, the caller left, or the route could not be run. `body` is the parsed JSON, or `undefined` when
 * the response was not JSON.
 */
export type BridgeOutcome =
    | { readonly kind: 'response'; readonly status: number; readonly body: unknown }
    | { readonly kind: 'inconclusive'; readonly reason: 'timeout' | 'aborted' | 'transport' };

export interface Bridge {
    call(caller: Caller, request: BridgeRequest, limits: BridgeLimits): Promise<BridgeOutcome>;
}

/** A caller the bridge can bind: an unscoped (`'all'`) credential acts with every scope the board knows. */
export const bridgedCallerOf = (caller: Caller): BridgedCaller => ({
    ...caller,
    scopes: caller.scopes === 'all' ? [...SCOPES] : caller.scopes,
});

const parsed = (payload: string): unknown => {
    if (payload === '') return undefined;
    try {
        return JSON.parse(payload);
    } catch {
        return undefined;
    }
};

/**
 * The in-process caller of the board's own routes: `app.inject` with a request class that carries the caller. No
 * cookie, bearer or any other header of the MCP request is forwarded, so a tool can reach exactly what its caller's
 * scopes allow and nothing a network credential would add.
 */
export function createBridge(app: Pick<FastifyInstance, 'inject'>, now: () => number = Date.now): Bridge {
    return {
        async call(caller, request, { signal, deadlineAt }) {
            const remaining = deadlineAt - now();
            if (remaining <= 0) return { kind: 'inconclusive', reason: 'timeout' };
            if (signal?.aborted) return { kind: 'inconclusive', reason: 'aborted' };

            const stop = new AbortController();
            const outcome = new Promise<BridgeOutcome>((resolve) => {
                const onAbort = () => {
                    resolve({ kind: 'inconclusive', reason: 'aborted' });
                    stop.abort();
                };
                signal?.addEventListener('abort', onAbort, { once: true });
                const timer = setTimeout(() => {
                    resolve({ kind: 'inconclusive', reason: 'timeout' });
                    stop.abort();
                }, remaining);
                stop.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
                void app
                    .inject({
                        method: request.method,
                        url: request.url,
                        Request: bridgedRequestClass(bridgedCallerOf(caller)),
                        signal: stop.signal,
                        ...(request.body === undefined ? {} : { payload: request.body as object }),
                        ...(request.idempotencyKey === undefined
                            ? {}
                            : { headers: { [IDEMPOTENCY_KEY_HEADER]: request.idempotencyKey } }),
                    })
                    .then(
                        (response) =>
                            resolve({ kind: 'response', status: response.statusCode, body: parsed(response.payload) }),
                        () => resolve({ kind: 'inconclusive', reason: 'transport' })
                    )
                    .finally(() => {
                        signal?.removeEventListener('abort', onAbort);
                        clearTimeout(timer);
                    });
            });
            return outcome;
        },
    };
}
