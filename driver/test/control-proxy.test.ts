import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLISH_PATH, REVIEW_PATH } from '../src/control-channel.js';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * The agent's run-control proxy (issue #814), shipped in both executor images: the agent's tools run
 * as their own uid and hold no run-control credential, and reach the routes the baked skills call
 * through this socket, which forwards them to the supervisor's relay (#829 S3c), where the token is
 * added. Driven against a fake relay over scratch sockets.
 */
const PROXY = join(ROOT, 'docker/claude-executor/control-proxy.cjs');
const proxy = createRequire(import.meta.url)(PROXY) as {
    serve: (deps: { fs: unknown; socket: string; relay: string }) => Promise<Server>;
    PUBLISH_PATH: string;
    REVIEW_PATH: string;
};

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Seen {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
}

/** A fake relay on a scratch socket that records what reached it and answers 201 with a body naming the route. */
async function board(): Promise<{ relay: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ route: req.url }));
        });
    });
    const dir = mkdtempSync(join(tmpdir(), 'control-relay-'));
    dirs.push(dir);
    const relay = join(dir, 'relay.sock');
    await new Promise<void>((resolve) => server.listen(relay, resolve));
    servers.push(server);
    return { relay, seen };
}

async function startProxy(relay: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'control-proxy-'));
    dirs.push(dir);
    const socket = join(dir, 'control.sock');
    servers.push(await proxy.serve({ fs, socket, relay }));
    return socket;
}

/** One request over the socket, as `curl --unix-socket` sends it. */
function call(socket: string, method: string, path: string, body?: string) {
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = request(
            { socketPath: socket, method, path, headers: { 'content-type': 'application/json' } },
            (res) => {
                let text = '';
                res.on('data', (chunk: Buffer) => {
                    text += chunk.toString();
                });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

describe('the run-control proxy', () => {
    it.each([
        ['POST', '/publish', '{"title":"draft"}'],
        ['POST', '/review', '{"key":"security-1","profile":"security"}'],
        ['GET', '/review/security-1', undefined],
    ])(
        'forwards %s %s to the relay with no credential, and the relay’s answer unchanged',
        async (method, path, body) => {
            const { relay, seen } = await board();
            const socket = await startProxy(relay);
            const answer = await call(socket, method, path, body);

            expect(answer.status).toBe(201);
            expect(JSON.parse(answer.body)).toEqual({ route: path });
            expect(seen).toHaveLength(1);
            expect(seen[0]).toMatchObject({ method, url: path, body: body ?? '' });
            expect(seen[0]!.headers.authorization).toBeUndefined();
        }
    );

    it.each([
        ['GET', '/publish'],
        ['POST', '/question'],
        ['GET', '/control'],
        ['POST', '/step'],
        ['GET', '/review/../control'],
        ['GET', '/review/'],
        ['DELETE', '/review/security-1'],
        ['POST', '/export/chunk'],
    ])('answers %s %s 404 without reaching the relay', async (method, path) => {
        const { relay, seen } = await board();
        const socket = await startProxy(relay);
        expect((await call(socket, method, path, '{}')).status).toBe(404);
        expect(seen).toEqual([]);
    });

    it('answers a relay that is missing, or refuses connections, with 502', async () => {
        const socket = await startProxy(join(tmpdir(), 'no-such-relay.sock'));
        expect((await call(socket, 'POST', '/publish', '{}')).status).toBe(502);
    });

    it('answers a relay that hangs up on the request with 502', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'control-relay-'));
        dirs.push(dir);
        const relay = join(dir, 'relay.sock');
        const hungUp = createServer((req) => req.socket.destroy());
        await new Promise<void>((resolve) => hungUp.listen(relay, resolve));
        servers.push(hungUp);
        const socket = await startProxy(relay);
        expect((await call(socket, 'POST', '/publish', '{}')).status).toBe(502);
    });

    it('holds no credential: it reads no BELLOWS_CONTROL_* name and sets no authorization header', () => {
        const source = readFileSync(PROXY, 'utf8');
        expect(source).not.toMatch(/BELLOWS_CONTROL_|authorization/i);
        expect(source).toContain('FACTORY_CTL_OUT');
    });

    it('serves on a socket only its owner and group may connect to', async () => {
        const { relay } = await board();
        const socket = await startProxy(relay);
        expect(statSync(socket).mode & 0o777).toBe(0o660);
    });

    it('allows exactly the routes the control channel grants the agent token', () => {
        expect(proxy.PUBLISH_PATH).toBe(PUBLISH_PATH);
        expect(proxy.REVIEW_PATH).toBe(REVIEW_PATH);
    });
});
