import { parseJsonObject } from './json-parse.js';

/**
 * The agent token's connection route: `POST /connection {provider}` is a helper telling the
 * board its task lacks a connection it needs (docs/connections.md). The route answers what the board
 * did — `bound`, `unavailable`, or `waiting` — and on `waiting` the loop has already begun to stop the
 * agent and hand the attempt back (`loop/loop-connection.ts`). Anything the board did not confirm is a
 * 502 the helper retries inside its deadline, never a verdict.
 */

export const CONNECTION_PATH = '/connection';
/** A provider id and nothing else travels here. */
export const CONNECTION_BODY_LIMIT = 1024;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UNAVAILABLE = 503;
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;

/** What the board decided about the ask; `gone` is a lease lost or a thread removed, `refused` a provider it does not bind. */
export type ConnectionVerdict = 'bound' | 'unavailable' | 'waiting' | 'gone' | 'refused';

/** The loop's end of the route: asks the board under the attempt's lease. Rejects when the board gave no answer. */
export interface ConnectionRelay {
    require(provider: string): Promise<ConnectionVerdict>;
}

/** The relay slot of one attempt; null until the loop attaches it. */
export interface ConnectionSlot {
    relay: ConnectionRelay | null;
}

export interface ConnectionAnswer {
    status: number;
    body: unknown;
}

/** `POST /connection`: validate the provider, ask the board once through the relay, answer its verdict. */
export async function serveConnection(slot: ConnectionSlot, raw: string): Promise<ConnectionAnswer> {
    const provider = parseJsonObject(raw)?.provider;
    if (typeof provider !== 'string' || !PROVIDER.test(provider)) {
        return { status: HTTP_BAD_REQUEST, body: { error: 'invalid provider' } };
    }
    if (!slot.relay) return { status: HTTP_UNAVAILABLE, body: { error: 'no connection relay yet' } };
    try {
        const verdict = await slot.relay.require(provider);
        if (verdict === 'gone') return { status: HTTP_CONFLICT, body: { error: 'the attempt is gone' } };
        if (verdict === 'refused') return { status: HTTP_BAD_REQUEST, body: { error: 'unknown provider' } };
        return { status: HTTP_OK, body: { answer: verdict } };
    } catch {
        return { status: HTTP_BAD_GATEWAY, body: { error: 'the board did not answer' } };
    }
}
