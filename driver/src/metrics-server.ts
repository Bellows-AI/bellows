import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CONTENT_TYPE_HEADER } from './http.js';
import { CONTENT_TYPE } from './prometheus.js';

/**
 * The driver's own scrape listener (issue #831): `GET /metrics`, behind `Authorization: Bearer
 * $JOB_BOARD_TOKEN` when one is configured. Separate from the gate server, which is ephemeral and
 * serves run control: a runner can reach this port, and holds no board token. `config.ts` refuses a
 * port with no token on a non-loopback host.
 */

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_ERROR = 500;
const BEARER = 'Bearer ';

export interface MetricsServer {
    /** Binds and answers the bound port. */
    listen(): Promise<number>;
    close(): Promise<void>;
}

export interface MetricsServerOptions {
    host: string;
    port: number;
    /** Empty means no credential is required. */
    token: string;
    render: () => Promise<string>;
}

const digest = (text: string): Buffer => Buffer.from(text);

/** Constant time over equal-length digests, so neither the token nor its length leaks through timing. */
function authorized(request: IncomingMessage, token: string): boolean {
    if (token === '') return true;
    const header = request.headers.authorization ?? '';
    const given = header.startsWith(BEARER) ? header.slice(BEARER.length) : '';
    const a = digest(given);
    const b = digest(token);
    const same = a.length === b.length && timingSafeEqual(a, b);
    // Compare against itself on a length mismatch so both outcomes cost one comparison.
    if (a.length !== b.length) timingSafeEqual(b, b);
    return same;
}

async function answer(
    options: MetricsServerOptions,
    request: IncomingMessage,
    response: ServerResponse
): Promise<void> {
    if (new URL(request.url ?? '/', 'http://driver.invalid').pathname !== '/metrics') {
        response.writeHead(HTTP_NOT_FOUND).end();
    } else if (request.method !== 'GET') {
        response.writeHead(HTTP_METHOD_NOT_ALLOWED, { allow: 'GET' }).end();
    } else if (!authorized(request, options.token)) {
        response.writeHead(HTTP_UNAUTHORIZED, { 'www-authenticate': 'Bearer' }).end();
    } else {
        const body = await options.render();
        response.writeHead(HTTP_OK, { [CONTENT_TYPE_HEADER]: CONTENT_TYPE }).end(body);
    }
}

export function createMetricsServer(options: MetricsServerOptions): MetricsServer {
    const server: Server = createServer((request, response) => {
        answer(options, request, response).catch(() => {
            if (!response.headersSent) response.writeHead(HTTP_ERROR);
            response.end();
        });
    });
    return {
        listen: () =>
            new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(options.port, options.host, () => {
                    const address = server.address();
                    resolve(typeof address === 'object' && address ? address.port : options.port);
                });
            }),
        close: () =>
            new Promise((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    };
}
