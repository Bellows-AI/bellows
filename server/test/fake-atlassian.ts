import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted Atlassian on 127.0.0.1: the only boundary the Jira tests fake. Every sites, account and token in it is a
 * synthetic value. A handler answers one route; the defaults answer a healthy single-site account, and a test swaps
 * in a fault: a refusal, a malformed answer, a response dropped after the request was read, or a body cut short.
 */
export type FakeReply =
    | { status: number; json?: unknown; text?: string; headers?: Record<string, string>; delayMs?: number }
    /** The socket is destroyed after the request was read: the caller sees a transport error. */
    | { drop: true }
    /** Headers and part of the body are sent, then the socket is destroyed. */
    | { truncate: true };

export interface FakeCall {
    method: string;
    path: string;
    body: unknown;
    authorization: string | null;
}

export type FakeHandler = (call: FakeCall, n: number) => FakeReply | Promise<FakeReply>;

export interface FakeAtlassian {
    /** The origin to give the hooks as `apiOrigin`, and to build the other URLs from. */
    origin: string;
    authorizeUrl: string;
    tokenUrl: string;
    calls: FakeCall[];
    /** Calls made so far to routes matching `method` and the path pattern. */
    count(method: string, path: RegExp): number;
    /** Replace the answer for a route. Later registrations win. */
    on(method: string, path: RegExp, handler: FakeHandler): void;
    close(): Promise<void>;
}

export const FAKE_CLOUD_ID = 'cloud-stub-a';
export const FAKE_SITE_HOST = 'stub-site-a.atlassian.net';
export const FAKE_ACCOUNT_ID = 'stub-account-a';
export const FAKE_ACCESS_TOKEN = 'stub-access-token-A';
export const FAKE_REFRESH_TOKEN = 'stub-refresh-token-A';
export const FAKE_CODE = 'stub-code-A';

export const fakeResource = (over: Partial<Record<string, unknown>> = {}) => ({
    id: FAKE_CLOUD_ID,
    url: `https://${FAKE_SITE_HOST}`,
    name: 'Stub Site A',
    scopes: ['read:jira-work', 'read:jira-user'],
    avatarUrl: 'https://example.test/a.png',
    ...over,
});

const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    if (text === '') return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

const send = async (res: ServerResponse, reply: FakeReply): Promise<void> => {
    if ('drop' in reply) {
        res.socket?.destroy();
        return;
    }
    if ('truncate' in reply) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
        res.write('{"access_to');
        setTimeout(() => res.socket?.destroy(), 10);
        return;
    }
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    const text = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(text);
};

export async function startFakeAtlassian(): Promise<FakeAtlassian> {
    const calls: FakeCall[] = [];
    const routes: { method: string; path: RegExp; handler: FakeHandler }[] = [];
    const fake: FakeAtlassian = {
        origin: '',
        authorizeUrl: '',
        tokenUrl: '',
        calls,
        count: (method, path) => calls.filter((c) => c.method === method && path.test(c.path)).length,
        on: (method, path, handler) => {
            routes.unshift({ method, path, handler });
        },
        close: () => closing(),
    };
    const server: Server = createServer((req, res) => {
        void (async () => {
            const call: FakeCall = {
                method: req.method ?? 'GET',
                path: req.url ?? '/',
                body: await readBody(req),
                authorization: req.headers.authorization ?? null,
            };
            calls.push(call);
            const route = routes.find((r) => r.method === call.method && r.path.test(call.path.split('?')[0] ?? ''));
            const n = fake.count(call.method, route?.path ?? /^$/);
            await send(res, route ? await route.handler(call, n) : { status: 404, json: {} });
        })();
    });
    const closing = () =>
        new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        });

    fake.on('POST', /^\/oauth\/token$/, () => ({
        status: 200,
        json: {
            access_token: FAKE_ACCESS_TOKEN,
            expires_in: 3600,
            refresh_token: FAKE_REFRESH_TOKEN,
            scope: 'read:jira-work read:jira-user offline_access',
        },
    }));
    fake.on('GET', /^\/oauth\/token\/accessible-resources$/, () => ({ status: 200, json: [fakeResource()] }));
    fake.on('GET', /^\/ex\/jira\/[^/]+\/rest\/api\/3\/myself$/, () => ({
        status: 200,
        json: { accountId: FAKE_ACCOUNT_ID, displayName: 'Stub Account A', emailAddress: 'stub-a@example.com' },
    }));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    fake.origin = `http://127.0.0.1:${port}`;
    fake.authorizeUrl = `${fake.origin}/authorize`;
    fake.tokenUrl = `${fake.origin}/oauth/token`;
    return fake;
}
