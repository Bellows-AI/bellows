import * as fs from 'node:fs';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLISH_PATH, REVIEW_PATH } from '../src/control-channel.js';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * The agent's run-control proxy (issue #814), shipped in both executor images: the agent's tools run
 * as their own uid without the run-control token, and reach the two routes the baked skills call
 * through this socket, which adds it. Driven against a fake board over a scratch socket.
 */
const PROXY = join(ROOT, 'docker/claude-executor/control-proxy.cjs');
const TOKEN = 'agent-control-token';
const proxy = createRequire(import.meta.url)(PROXY) as {
    serve: (deps: { fs: unknown; fetch: typeof fetch; socket: string; url: string; token: string }) => Promise<Server>;
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

/** A fake board that records what reached it and answers 201 with a body naming the route. */
async function board(): Promise<{ url: string; seen: Seen[] }> {
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, seen };
}

async function startProxy(url: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'control-proxy-'));
    dirs.push(dir);
    const socket = join(dir, 'control.sock');
    servers.push(await proxy.serve({ fs, fetch, socket, url, token: TOKEN }));
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
    ])('forwards %s %s with the token added, and the board’s answer unchanged', async (method, path, body) => {
        const { url, seen } = await board();
        const socket = await startProxy(url);
        const answer = await call(socket, method, path, body);

        expect(answer.status).toBe(201);
        expect(JSON.parse(answer.body)).toEqual({ route: path });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ method, url: path, body: body ?? '' });
        expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(JSON.stringify(answer)).not.toContain(TOKEN);
    });

    it.each([
        ['GET', '/publish'],
        ['POST', '/question'],
        ['GET', '/control'],
        ['POST', '/step'],
        ['GET', '/review/../control'],
        ['GET', '/review/'],
        ['DELETE', '/review/security-1'],
        ['POST', '/export/chunk'],
    ])('answers %s %s 404 without reaching the board', async (method, path) => {
        const { url, seen } = await board();
        const socket = await startProxy(url);
        expect((await call(socket, method, path, '{}')).status).toBe(404);
        expect(seen).toEqual([]);
    });

    it('answers a board it cannot reach with 502, never with the token', async () => {
        const socket = await startProxy('http://127.0.0.1:9/');
        const answer = await call(socket, 'POST', '/publish', '{}');
        expect(answer.status).toBe(502);
        expect(answer.body).not.toContain(TOKEN);
    });

    it('serves on a socket only its owner and group may connect to', async () => {
        const { url } = await board();
        const socket = await startProxy(url);
        expect(statSync(socket).mode & 0o777).toBe(0o660);
    });

    it('allows exactly the routes the control channel grants the agent token', () => {
        expect(proxy.PUBLISH_PATH).toBe(PUBLISH_PATH);
        expect(proxy.REVIEW_PATH).toBe(REVIEW_PATH);
    });
});
