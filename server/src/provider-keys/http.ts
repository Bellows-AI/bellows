import type { ClientRequest, IncomingMessage } from 'node:http';
import { ERROR_CODES, JSON_CONTENT_TYPE } from '@factory-ai/core';
import { openPinnedGet, PinError, pinnedAddress, type Resolve } from '../net/pinned-request.js';

/**
 * The provider check's one outbound GET (docs/security.md): resolve-and-pin under the deployment's address rule, no
 * redirect, a size cap, and the check's one signal (the caller's close and the deadline) over lookup, connect and every
 * byte. A failure is a fixed code, never the transport's message: that may quote the URL.
 */
export type CheckCode =
    | typeof ERROR_CODES.INVALID_KEY
    | typeof ERROR_CODES.NO_CREDIT
    | typeof ERROR_CODES.UNREACHABLE
    | typeof ERROR_CODES.BAD_RESPONSE
    | typeof ERROR_CODES.REFUSED_IN_CLOUD;

export class CheckFailure extends Error {
    constructor(readonly code: CheckCode) {
        super(code);
        this.name = 'CheckFailure';
    }
}

export interface Outbound {
    signal: AbortSignal;
    resolve: Resolve;
    /** The address rule: special-use addresses in cloud, nothing self-hosted. */
    refused: (address: string) => boolean;
    maxBytes: number;
}

const HTTP_SUCCESS_FLOOR = 200;
const HTTP_SUCCESS_CEILING = 300;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;

/**
 * What a status says. Only 401/403 is a verdict on the key; a 429 or 5xx is the provider's trouble; a redirect (never
 * followed) or any other status is an answer the board cannot read.
 */
export const failureOfStatus = (status: number): CheckCode | null => {
    if (status >= HTTP_SUCCESS_FLOOR && status < HTTP_SUCCESS_CEILING) return null;
    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return ERROR_CODES.INVALID_KEY;
    if (status === HTTP_TOO_MANY || status >= HTTP_SERVER_ERROR) return ERROR_CODES.UNREACHABLE;
    return ERROR_CODES.BAD_RESPONSE;
};

type Finish = (error?: CheckFailure, value?: unknown) => void;

/** The capped body as JSON; settles on end, overflow, error and a close before the end. */
const readJson = (response: IncomingMessage, maxBytes: number, finish: Finish): void => {
    if (Number(response.headers['content-length'] ?? 0) > maxBytes) {
        finish(new CheckFailure(ERROR_CODES.BAD_RESPONSE));
        return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) finish(new CheckFailure(ERROR_CODES.BAD_RESPONSE));
        else chunks.push(chunk);
    });
    response.on('end', () => {
        try {
            finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
            finish(new CheckFailure(ERROR_CODES.BAD_RESPONSE));
        }
    });
    response.on('error', () => finish(new CheckFailure(ERROR_CODES.UNREACHABLE)));
    response.on('close', () => finish(new CheckFailure(ERROR_CODES.UNREACHABLE)));
};

/** GET `url` and parse its 2xx JSON body; any other outcome rejects with a `CheckFailure`. */
export const getJson = (url: URL, headers: Record<string, string>, out: Outbound): Promise<unknown> =>
    new Promise((resolvePromise, rejectPromise) => {
        let done = false;
        let outgoing: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        const finish: Finish = (error, value) => {
            if (done) return;
            done = true;
            out.signal.removeEventListener('abort', onAbort);
            if (!error) return resolvePromise(value);
            // Cancel the body and the socket: nothing outlives a settled check.
            response?.destroy();
            outgoing?.destroy();
            rejectPromise(error);
        };
        const onAbort = () => finish(new CheckFailure(ERROR_CODES.UNREACHABLE));
        if (out.signal.aborted) return onAbort();
        out.signal.addEventListener('abort', onAbort, { once: true });

        const onResponse = (answer: IncomingMessage) => {
            response = answer;
            const failure = failureOfStatus(answer.statusCode ?? 0);
            if (failure) finish(new CheckFailure(failure));
            else readJson(answer, out.maxBytes, finish);
        };
        const connect = (address: string) => {
            if (done) return;
            try {
                outgoing = openPinnedGet(url, address, { accept: JSON_CONTENT_TYPE, ...headers }, onResponse);
            } catch {
                return finish(new CheckFailure(ERROR_CODES.UNREACHABLE));
            }
            outgoing.on('error', () => finish(new CheckFailure(ERROR_CODES.UNREACHABLE)));
            outgoing.end();
        };
        pinnedAddress(url, out.resolve, out.refused).then(connect, (e: unknown) =>
            finish(
                new CheckFailure(
                    e instanceof PinError && e.failure === 'address'
                        ? ERROR_CODES.REFUSED_IN_CLOUD
                        : ERROR_CODES.UNREACHABLE
                )
            )
        );
    });
