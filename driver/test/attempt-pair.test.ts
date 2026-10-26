import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * The attempt pair a runner's helpers present (#1045), shipped in both executor images: the lease the
 * supervisor relays when it follows a newer holder, else the env the container started with, and
 * never a verdict of its own. Driven against a real unix socket.
 */
const MODULE = join(ROOT, 'docker/claude-executor/attempt-pair.cjs');
const pairing = createRequire(import.meta.url)(MODULE) as {
    currentPair: (
        env: Record<string, string | undefined>,
        options?: { socket?: string; deadlineMs?: number }
    ) => Promise<{ jobId: string; leaseToken: string }>;
};

const JOB = 'job-1';
const OLD = 'lease-old';
const NEW = 'lease-relayed';
const ENV = { RUNNER_JOB_ID: JOB, RUNNER_LEASE_TOKEN: OLD };

const servers: Server[] = [];
const sockets: Socket[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function relay(
    answer: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ socket: string; seen: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'attempt-pair-'));
    dirs.push(dir);
    const socket = join(dir, 'control.sock');
    const seen: string[] = [];
    const server = createServer((request, response) => {
        seen.push(`${request.method} ${request.url}`);
        answer(request, response);
    });
    server.on('connection', (connection) => sockets.push(connection));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    return { socket, seen };
}

const json = (status: number, body: string) => (_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
};

describe('the attempt pair', () => {
    it('is the relayed lease with the env job id when the supervisor answers 200', async () => {
        const { socket, seen } = await relay(json(200, JSON.stringify({ leaseToken: NEW })));
        expect(await pairing.currentPair(ENV, { socket })).toEqual({ jobId: JOB, leaseToken: NEW });
        expect(seen).toEqual(['GET /attempt']);
    });

    it.each([
        ['a 404', json(404, '')],
        ['a 500', json(500, '{"leaseToken":"lease-relayed"}')],
        ['a body that is not JSON', json(200, 'not json')],
        ['a body with no lease', json(200, '{}')],
        ['a lease with whitespace', json(200, '{"leaseToken":"has space"}')],
        ['a lease that is not a string', json(200, '{"leaseToken":7}')],
        ['an empty lease', json(200, '{"leaseToken":""}')],
        ['a lease past 256 characters', json(200, JSON.stringify({ leaseToken: 'x'.repeat(257) }))],
        ['a hang-up', (_request: IncomingMessage, response: ServerResponse) => response.destroy()],
        [
            'an answer cut off mid-body',
            (_request: IncomingMessage, response: ServerResponse) => {
                response.writeHead(200, { 'content-length': '100' });
                response.write('{"leaseToken":');
                setImmediate(() => response.destroy());
            },
        ],
    ])('is the env pair on %s', async (_what, answer) => {
        const { socket } = await relay(answer);
        expect(await pairing.currentPair(ENV, { socket })).toEqual({ jobId: JOB, leaseToken: OLD });
    });

    it('is the env pair when no socket exists', async () => {
        const socket = join(tmpdir(), 'no-such-attempt-relay.sock');
        expect(await pairing.currentPair(ENV, { socket })).toEqual({ jobId: JOB, leaseToken: OLD });
    });

    it('is the env pair once one absolute deadline passes, whether the answer never starts or never ends', async () => {
        const silent = await relay(() => {});
        const started = Date.now();
        expect(await pairing.currentPair(ENV, { socket: silent.socket, deadlineMs: 150 })).toEqual({
            jobId: JOB,
            leaseToken: OLD,
        });
        const dribbling = await relay((_request, response) => {
            response.writeHead(200, { 'content-length': '100' });
            response.write('{"leaseToken":"');
        });
        expect(await pairing.currentPair(ENV, { socket: dribbling.socket, deadlineMs: 150 })).toEqual({
            jobId: JOB,
            leaseToken: OLD,
        });
        expect(Date.now() - started).toBeLessThan(2000);
    });

    it('asks nothing of a container with no job id', async () => {
        const { socket, seen } = await relay(json(200, JSON.stringify({ leaseToken: NEW })));
        expect(await pairing.currentPair({}, { socket })).toEqual({ jobId: '', leaseToken: '' });
        expect(seen).toEqual([]);
    });

    it('reads every call afresh: a lease the supervisor changes is the next call’s lease', async () => {
        let lease = 'lease-a';
        const { socket } = await relay((_request, response) =>
            json(200, JSON.stringify({ leaseToken: lease }))(_request, response)
        );
        expect((await pairing.currentPair(ENV, { socket })).leaseToken).toBe('lease-a');
        lease = 'lease-b';
        expect((await pairing.currentPair(ENV, { socket })).leaseToken).toBe('lease-b');
    });
});

describe('the attempt pair as a curl config', () => {
    it('prints the two headers on stdout and nothing on stderr, the lease never in argv', async () => {
        const run = (env: Record<string, string>) =>
            new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
                execFile(
                    process.execPath,
                    [MODULE],
                    { env: { PATH: process.env.PATH ?? '', ...env } },
                    (error, stdout, stderr) => resolve({ stdout, stderr, code: error ? 1 : 0 })
                );
            });
        const out = await run({ RUNNER_JOB_ID: JOB, RUNNER_LEASE_TOKEN: 'lease"quoted\\' });
        expect(out).toEqual({
            stdout: `header = "x-factory-job-id: ${JOB}"\nheader = "x-factory-job-lease-token: lease\\"quoted\\\\"\n`,
            stderr: '',
            code: 0,
        });
    });

    it('drops a CR or LF from the pair, so it cannot add a curl config line', async () => {
        const out = await new Promise<string>((resolve) => {
            execFile(
                process.execPath,
                [MODULE],
                { env: { PATH: process.env.PATH ?? '', RUNNER_JOB_ID: JOB, RUNNER_LEASE_TOKEN: 'a\nurl = "x"\r' } },
                (_error, stdout) => resolve(stdout)
            );
        });
        expect(out.split('\n')).toHaveLength(3);
    });

    it('prints the relayed lease where FACTORY_CONTROL_SOCKET names a supervisor that answers', async () => {
        const { socket } = await relay(json(200, JSON.stringify({ leaseToken: NEW })));
        const out = await new Promise<string>((resolve) => {
            execFile(
                process.execPath,
                [MODULE],
                { env: { PATH: process.env.PATH ?? '', ...ENV, FACTORY_CONTROL_SOCKET: socket } },
                (_error, stdout) => resolve(stdout)
            );
        });
        expect(out).toBe(`header = "x-factory-job-id: ${JOB}"\nheader = "x-factory-job-lease-token: ${NEW}"\n`);
    });
});
