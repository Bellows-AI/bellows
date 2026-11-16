import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

/**
 * Resolve-and-pin for an outbound GET to a URL someone else named (docs/security.md): every resolved address is checked
 * by the caller's rule, and the connection goes to the address that was checked, never to a second lookup's answer
 * (DNS rebinding). The client metadata fetch and the provider key check share it.
 */
export type Resolve = (hostname: string) => Promise<string[]>;

export type PinFailure = 'lookup' | 'address';

export class PinError extends Error {
    constructor(
        readonly failure: PinFailure,
        message: string
    ) {
        super(message);
        this.name = 'PinError';
    }
}

export const systemResolve: Resolve = async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

export const bareHost = (url: URL): string => (url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname);

/**
 * The address to connect to: a literal as given, or the first answer of a lookup whose every answer `refused` allows.
 * A failed lookup is `lookup` (its message is the resolver's); a refused answer is `address`.
 */
export const pinnedAddress = async (
    url: URL,
    resolve: Resolve,
    refused: (address: string) => boolean
): Promise<string> => {
    const host = bareHost(url);
    let answers: string[] = [host];
    if (!isIP(host)) {
        try {
            answers = await resolve(host);
        } catch (e) {
            throw new PinError('lookup', (e as Error).message);
        }
    }
    const [first] = answers;
    if (first === undefined || answers.some(refused)) {
        throw new PinError('address', 'The host resolves to an address that is not allowed.');
    }
    return first;
};

/** Resolves the address a request may use, in place of the system lookup the socket would otherwise do. */
const lookupOf =
    (address: string): LookupFunction =>
    (_host, lookupOptions, callback) => {
        const entry = { address, family: isIP(address) };
        if ((lookupOptions as { all?: boolean }).all) {
            (callback as unknown as (e: null, all: (typeof entry)[]) => void)(null, [entry]);
        } else callback(null, address, entry.family);
    };

/** A GET to `url` over a connection to `address`, with no agent (no pooled socket outlives it). */
export const openPinnedGet = (
    url: URL,
    address: string,
    headers: Record<string, string>,
    onResponse: (response: IncomingMessage) => void
): ClientRequest => {
    const secure = url.protocol === 'https:';
    const host = bareHost(url);
    const outgoing = (secure ? httpsRequest : httpRequest)({
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { ...headers, host: url.host },
        lookup: lookupOf(address),
        agent: false,
        ...(secure && !isIP(host) ? { servername: host } : {}),
    });
    outgoing.on('response', onResponse);
    return outgoing;
};
