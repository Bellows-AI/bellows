import { IncomingMessage } from 'node:http';
import type { Caller } from './store.js';

/**
 * The seam the MCP bridge (`POST /api/mcp`) calls the board's own routes through. A request is "bridged" when its
 * `IncomingMessage` class carries a caller under a module-private symbol: `app.inject({ Request: bridgedRequestClass(c) })`.
 * The symbol lives on the class prototype (a constructor assignment does not run under light-my-request), and a
 * network request is built by Node's own `IncomingMessage`, which has no such property, so nothing a client sends
 * (header, query, body) can create one. The symbol is not exported.
 */
const BOUND = Symbol('factory.bridge.caller');

/** A request class that binds `caller` to every request injected through it. */
export const bridgedRequestClass = (caller: Caller): typeof IncomingMessage => {
    class Bridged extends IncomingMessage {}
    Object.defineProperty(Bridged.prototype, BOUND, { value: caller, enumerable: false });
    return Bridged;
};

/** The bound caller of a raw request, or null for every request that arrived over the network. */
export const boundCallerOf = (raw: IncomingMessage): Caller | null =>
    (raw as IncomingMessage & { [BOUND]?: Caller })[BOUND] ?? null;
