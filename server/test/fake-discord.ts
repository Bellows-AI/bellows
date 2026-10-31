import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** What the fake saw: the request's method, path, query, headers and parsed JSON body. */
export interface Recorded {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: IncomingHttpHeaders;
    json: unknown;
}

/** One scripted answer. `hang` sends the headers and one chunk, then never ends the body. */
export interface Reply {
    status: number;
    headers?: Record<string, string>;
    body?: string;
    hang?: boolean;
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const SNOWFLAKE = '1000000000000000001';

/** The shapes below are what Discord's webhook route answers, recorded from its documentation and the field. */
export const messageOk = (id = SNOWFLAKE): Reply => ({
    status: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ id, channel_id: '2000000000000000002', webhook_id: '3000000000000000003', embeds: [] }),
});
export const rateLimited: Reply = {
    status: 429,
    headers: { ...JSON_HEADERS, 'retry-after': '1' },
    body: '{"message":"You are being rate limited.","retry_after":0.529,"global":false}',
};
export const unknownWebhook: Reply = {
    status: 404,
    headers: JSON_HEADERS,
    body: '{"message":"Unknown Webhook","code":10015}',
};
export const invalidToken: Reply = {
    status: 401,
    headers: JSON_HEADERS,
    body: '{"message":"Invalid Webhook Token","code":50027}',
};
export const invalidForm: Reply = {
    status: 400,
    headers: JSON_HEADERS,
    body: '{"message":"Invalid Form Body","code":50035,"errors":{}}',
};
export const serverError: Reply = {
    status: 502,
    headers: { 'content-type': 'text/html' },
    body: '<html><body>Bad gateway</body></html>',
};
export const redirect: Reply = { status: 302, headers: { location: '/somewhere/else' } };
export const hang: Reply = { status: 200, headers: JSON_HEADERS, body: '{"id":', hang: true };
export const tooBig: Reply = {
    status: 200,
    headers: JSON_HEADERS,
    body: `{"id":"${SNOWFLAKE}","pad":"${'x'.repeat(100_000)}"}`,
};

export interface FakeDiscord {
    /** `http://127.0.0.1:<port>`: tests rewrite `https://discord.com` to it. */
    origin: string;
    requests: Recorded[];
    /** The answer for every request from now on. */
    reply(next: Reply): void;
    /** Connections the fake still holds open. */
    openSockets(): number;
    close(): Promise<void>;
}

/** A `node:http` server on `127.0.0.1:0` that records each request and answers from the script. */
export async function startFakeDiscord(): Promise<FakeDiscord> {
    const requests: Recorded[] = [];
    const sockets = new Set<Socket>();
    let next: Reply = messageOk();
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const url = new URL(req.url ?? '/', 'http://fake');
            let json: unknown;
            try {
                json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                json = undefined;
            }
            requests.push({
                method: req.method ?? '',
                path: url.pathname,
                query: Object.fromEntries(url.searchParams),
                headers: req.headers,
                json,
            });
            res.writeHead(next.status, next.headers);
            if (next.hang) res.write(next.body ?? '');
            else res.end(next.body);
        });
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        requests,
        reply(r) {
            next = r;
        },
        openSockets: () => sockets.size,
        close: () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => resolve());
            }),
    };
}
