import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A `node:http` model provider on `127.0.0.1:0`: Anthropic, OpenAI, OpenRouter and LiteLLM answer the paths below, so
 * one fake stands in for each. The shapes are what each provider documents; tests never call a real provider.
 */

/** What the fake saw: method, path and headers. */
export interface Recorded {
    method: string;
    path: string;
    headers: IncomingHttpHeaders;
}

/**
 * One scripted answer. `stall` never sends the headers; `trickle` sends the headers and one byte at a time, never
 * ending the body.
 */
export interface Reply {
    status: number;
    headers?: Record<string, string>;
    body?: string;
    stall?: boolean;
    trickle?: boolean;
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const TRICKLE_MS = 20;

export const json = (body: unknown, status = 200): Reply => ({
    status,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
});

export const modelList = (...ids: string[]): Reply => json({ data: ids.map((id) => ({ id, object: 'model' })) });

/** OpenRouter's `GET /api/v1/key`: the remaining credit, the limit and the usage, in dollars. */
export const openRouterKey = (limitRemaining: number | null, limit: number | null = 10, usage = 2.5): Reply =>
    json({ data: { label: 'sk-or-v1-abc...xyz', limit, limit_remaining: limitRemaining, usage, is_free_tier: false } });

/** LiteLLM's `GET /key/info`: the key's budget and spend. */
export const liteLlmKeyInfo = (maxBudget: number | null, spend: number): Reply =>
    json({ key: 'hashed', info: { max_budget: maxBudget, spend, models: [] } });

export const unauthorized: Reply = json({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
export const forbidden: Reply = json({ error: { message: 'forbidden' } }, 403);
export const notFound: Reply = json({ detail: 'Not Found' }, 404);
export const serverError: Reply = {
    status: 502,
    headers: { 'content-type': 'text/html' },
    body: '<html>Bad gateway</html>',
};
export const redirect: Reply = { status: 302, headers: { location: '/elsewhere' } };
export const notJson: Reply = { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>hello</html>' };
export const tooBig = (bytes: number): Reply => ({
    status: 200,
    headers: JSON_HEADERS,
    body: `{"data":[],"pad":"${'x'.repeat(bytes)}"}`,
});
export const stall: Reply = { status: 200, stall: true };
export const trickle: Reply = { status: 200, headers: JSON_HEADERS, body: '{"data":[', trickle: true };

export interface FakeProvider {
    /** `http://127.0.0.1:<port>`. */
    origin: string;
    port: number;
    requests: Recorded[];
    /** The answer for one path from now on; a path never scripted answers 404. */
    reply(path: string, next: Reply): void;
    close(): Promise<void>;
}

const answer = (res: ServerResponse, next: Reply, timers: Set<NodeJS.Timeout>) => {
    if (next.stall) return;
    res.writeHead(next.status, next.headers);
    if (!next.trickle) {
        res.end(next.body);
        return;
    }
    const timer = setInterval(() => res.write(' '), TRICKLE_MS);
    timers.add(timer);
    res.on('close', () => {
        clearInterval(timer);
        timers.delete(timer);
    });
    res.write(next.body ?? '');
};

export async function startFakeProvider(): Promise<FakeProvider> {
    const requests: Recorded[] = [];
    const sockets = new Set<Socket>();
    const timers = new Set<NodeJS.Timeout>();
    const script = new Map<string, Reply>();
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://fake');
        requests.push({ method: req.method ?? '', path: url.pathname, headers: req.headers });
        req.resume();
        req.on('end', () => answer(res, script.get(url.pathname) ?? notFound, timers));
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        port,
        requests,
        reply(path, next) {
            script.set(path, next);
        },
        close: () =>
            new Promise<void>((resolve) => {
                for (const timer of timers) clearInterval(timer);
                for (const socket of sockets) socket.destroy();
                server.close(() => resolve());
            }),
    };
}
