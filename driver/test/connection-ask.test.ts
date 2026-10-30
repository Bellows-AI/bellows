import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * The runtime connection ask a helper makes (BEL-174), shipped in both executor images: one POST of the
 * provider to the agent's control socket, answered `bound`, `unavailable` or `waiting`. Anything else —
 * a hang-up, a 5xx, a body that is not an answer — is inconclusive and never reads as a verdict. Driven
 * against a real unix socket.
 */
const MODULE = join(ROOT, 'docker/claude-executor/connection-ask.cjs');
type Asked =
    | { kind: 'answer'; answer: 'bound' | 'unavailable' | 'waiting' }
    | { kind: 'absent' | 'refused' | 'inconclusive' };
const connection = createRequire(import.meta.url)(MODULE) as {
    askConnection: (provider: string, options: { socket: string; deadlineMs: number }) => Promise<Asked>;
};

const servers: Server[] = [];
const sockets: Socket[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function relay(
    answer: (request: IncomingMessage, response: ServerResponse, body: string) => void
): Promise<{ socket: string; seen: { line: string; body: string }[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'connection-ask-'));
    dirs.push(dir);
    const socket = join(dir, 'control.sock');
    const seen: { line: string; body: string }[] = [];
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk: Buffer) => {
            body += chunk.toString();
        });
        request.on('end', () => {
            seen.push({ line: `${request.method} ${request.url}`, body });
            answer(request, response, body);
        });
    });
    server.on('connection', (each) => sockets.push(each));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    return { socket, seen };
}

const json = (status: number, body: string) => (_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
};

describe('the connection ask', () => {
    it.each(['bound', 'unavailable', 'waiting'] as const)(
        'posts the provider and reads the %s answer',
        async (answer) => {
            const { socket, seen } = await relay(json(200, JSON.stringify({ answer })));
            expect(await connection.askConnection('jira', { socket, deadlineMs: 2000 })).toEqual({
                kind: 'answer',
                answer,
            });
            expect(seen).toEqual([{ line: 'POST /connection', body: JSON.stringify({ provider: 'jira' }) }]);
        }
    );

    it.each([
        ['a 401', json(401, '{}')],
        ['a 403', json(403, '{}')],
        ['a 409 (the attempt is gone)', json(409, '{}')],
    ])('reads %s as a refusal of the attempt', async (_name, answer) => {
        const { socket } = await relay(answer);
        expect(await connection.askConnection('jira', { socket, deadlineMs: 2000 })).toEqual({ kind: 'refused' });
    });

    it.each([
        ['a 500', json(500, '{"answer":"unavailable"}')],
        ['a 502', json(502, '{}')],
        ['a 400', json(400, '{}')],
        ['a body that is not JSON', json(200, 'not json')],
        ['a body with no answer', json(200, '{}')],
        ['an answer outside the three', json(200, '{"answer":"missing"}')],
        ['an answer that is not a string', json(200, '{"answer":true}')],
        ['an empty body', json(200, '')],
    ])('reads %s as inconclusive, never as a verdict', async (_name, answer) => {
        const { socket } = await relay(answer);
        expect(await connection.askConnection('jira', { socket, deadlineMs: 2000 })).toEqual({ kind: 'inconclusive' });
    });

    it('reads a connection that closes before the body ends as inconclusive', async () => {
        const { socket } = await relay((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json', 'content-length': '40' });
            response.write('{"answer":');
            setTimeout(() => response.destroy(), 20);
        });
        expect(await connection.askConnection('jira', { socket, deadlineMs: 2000 })).toEqual({ kind: 'inconclusive' });
    });

    it('reads a hang-up with no answer as inconclusive', async () => {
        const { socket } = await relay((request) => request.socket.destroy());
        expect(await connection.askConnection('jira', { socket, deadlineMs: 2000 })).toEqual({ kind: 'inconclusive' });
    });

    it('is inconclusive, not a verdict, when the relay never answers within the deadline', async () => {
        const { socket } = await relay(() => undefined);
        const started = Date.now();
        expect(await connection.askConnection('jira', { socket, deadlineMs: 150 })).toEqual({ kind: 'inconclusive' });
        expect(Date.now() - started).toBeLessThan(1500);
    });

    it('is absent where there is no proxy socket at all', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'connection-ask-'));
        dirs.push(dir);
        expect(await connection.askConnection('jira', { socket: join(dir, 'none.sock'), deadlineMs: 500 })).toEqual({
            kind: 'absent',
        });
        expect(
            await connection.askConnection('jira', { socket: join(dir, 'a', 'none.sock'), deadlineMs: 500 })
        ).toEqual({
            kind: 'absent',
        });
    });
});
