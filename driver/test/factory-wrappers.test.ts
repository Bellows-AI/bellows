import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * `factory-gate` and `factory-control`, the two commands the baked skills use for the
 * gate server and the run-control socket, so the managed allowlist can name them instead of a `curl`
 * whose `*` would take any URL. Driven as real processes against a loopback gate server and a unix
 * socket; the destination is fixed, the arguments only fill a JSON an encoder builds.
 */
const GATE = join(ROOT, 'docker/executor-common/factory-gate.cjs');
const CONTROL = join(ROOT, 'docker/executor-common/factory-control.cjs');

interface Seen {
    method: string;
    url: string;
    authorization: string | undefined;
    body: string;
}
interface Ran {
    code: number | null;
    stdout: string;
    stderr: string;
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A server on a loopback port or a unix socket that records each request and answers with `status` and `reply`. */
async function serve(status: number, reply: string, onSocket = false): Promise<{ listen: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += String(chunk)));
        req.on('end', () => {
            seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
            res.statusCode = status;
            res.end(reply);
        });
    });
    servers.push(server);
    let listen: string;
    if (onSocket) {
        const dir = mkdtempSync(join(tmpdir(), 'factory-ctl-'));
        dirs.push(dir);
        listen = join(dir, 'control.sock');
        await new Promise<void>((resolve) => server.listen(listen, resolve));
    } else {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        listen = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    }
    return { listen, seen };
}

const run = (script: string, args: string[], env: Record<string, string>): Promise<Ran> =>
    new Promise((resolve) => {
        execFile(
            process.execPath,
            [script, ...args],
            { env: { PATH: process.env.PATH ?? '', ...env } },
            (error, stdout, stderr) => {
                const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
                resolve({ code, stdout, stderr });
            }
        );
    });

/** A unix-socket HTTP server whose handler writes the raw reply itself, to hang up or cut an answer short. */
async function serveRaw(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    const dir = mkdtempSync(join(tmpdir(), 'factory-ctl-'));
    dirs.push(dir);
    const socket = join(dir, 'control.sock');
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    return socket;
}

describe('factory-gate', () => {
    const env = (socket: string) => ({ FACTORY_CONTROL_SOCKET: socket });
    /** The exit of a transport failure: retryable, apart from the gate's own failure (22), no gates (3) and usage (2). */
    const RETRYABLE = 75;

    it('POSTs the gate name to /gate/run on the control socket, no bearer, and prints the answer unchanged', async () => {
        const answer = '{"exitCode":0,"output":"ok","executionId":"e-1"}';
        const gate = await serve(200, answer, true);
        const ran = await run(GATE, ['test'], env(gate.listen));
        expect(ran).toMatchObject({ code: 0, stdout: answer });
        expect(gate.seen).toEqual([
            { method: 'POST', url: '/gate/run', authorization: undefined, body: '{"gate":"test"}' },
        ]);
    });

    it('never reads the gate pair from its environment: a stale BELLOWS_GATE_URL goes nowhere', async () => {
        const gate = await serve(200, '{"exitCode":0}', true);
        const decoy = await serve(200, '{"decoy":true}');
        const ran = await run(GATE, ['test'], {
            ...env(gate.listen),
            BELLOWS_GATE_URL: decoy.listen,
            BELLOWS_GATE_TOKEN: 'tok-1',
        });
        expect(ran).toMatchObject({ code: 0, stdout: '{"exitCode":0}' });
        expect(decoy.seen).toEqual([]);
    });

    it('sends --filter as the filter field and nothing else', async () => {
        const gate = await serve(200, '{"exitCode":0}', true);
        await run(GATE, ['unit', '--filter', 'src/a.test.ts'], env(gate.listen));
        expect(JSON.parse(gate.seen[0]?.body ?? '')).toEqual({ gate: 'unit', filter: 'src/a.test.ts' });
    });

    it('encodes shell-hostile input as data: nothing is interpolated or run', async () => {
        const gate = await serve(200, '{}', true);
        const hostile = `a"}'; $(touch /tmp/pwned) \`id\` \\n`;
        await run(GATE, ['test', '--filter', hostile], env(gate.listen));
        expect(JSON.parse(gate.seen[0]?.body ?? '')).toEqual({ gate: 'test', filter: hostile });
    });

    it('keeps the answer of a refused run: the 503 body with its executionId, and the HTTP exit', async () => {
        const body = '{"error":"not recorded","retryable":true,"executionId":"e-2"}';
        const gate = await serve(503, body, true);
        const ran = await run(GATE, ['test'], env(gate.listen));
        expect(ran.stdout).toBe(body);
        expect(ran.code).toBe(22);
        expect(ran.stderr).toContain('503');
    });

    it('keeps the answer of a gate the driver refuses (422) with the HTTP exit', async () => {
        const body = '{"error":"filter not allowed"}';
        const gate = await serve(422, body, true);
        const ran = await run(GATE, ['test', '--filter', 'x'], env(gate.listen));
        expect(ran).toMatchObject({ code: 22, stdout: body });
    });

    it("says there are no gates only on the driver's explicit 404 no-gates answer", async () => {
        const gate = await serve(404, '{"error":"no gates"}', true);
        const ran = await run(GATE, ['test'], env(gate.listen));
        expect(ran.code).toBe(3);
        expect(ran.stderr).toContain('no gates');
    });

    it('does not take any other 404 for "no gates"', async () => {
        const gate = await serve(404, '{"error":"not found"}', true);
        const ran = await run(GATE, ['test'], env(gate.listen));
        expect(ran.code).toBe(22);
    });

    it('a missing control socket is a transport failure, never "no gates"', async () => {
        const ran = await run(GATE, ['test'], env('/nonexistent/control.sock'));
        expect(ran).toMatchObject({ code: RETRYABLE, stdout: '' });
        expect(ran.stderr).toContain('retry');
        expect(ran.stderr).not.toContain('no gates');
    });

    it('a socket nobody listens on (ECONNREFUSED) is a transport failure', async () => {
        const socket = await serveRaw(() => undefined);
        servers.pop()?.close();
        const ran = await run(GATE, ['test'], env(socket));
        expect(ran).toMatchObject({ code: RETRYABLE, stdout: '' });
    });

    it.each([
        ['a 502 from the proxy', 502, '{"error":"control relay unavailable"}'],
        [
            'a retryable 503 before the gate run is open',
            503,
            '{"error":"the gate run is not open yet","retryable":true}',
        ],
    ])('%s is a retryable transport failure, never "passed" and never "no gates"', async (_name, status, body) => {
        const gate = await serve(status, body, true);
        const ran = await run(GATE, ['test'], env(gate.listen));
        expect(ran.code).toBe(RETRYABLE);
        expect(ran.stderr).toContain('retry');
        expect(ran.stderr).not.toContain('no gates');
    });

    it('a relay that hangs up on the request is a retryable transport failure', async () => {
        const socket = await serveRaw((req) => req.socket.destroy());
        const ran = await run(GATE, ['test'], env(socket));
        expect(ran).toMatchObject({ code: RETRYABLE, stdout: '' });
    });

    it('a 200 answer cut short is a transport failure and prints no partial result', async () => {
        const socket = await serveRaw((req, res) => {
            req.resume();
            req.on('end', () => {
                res.writeHead(200, { 'content-length': 500 });
                res.write('{"exitCode":0,"output":"par');
                setTimeout(() => res.destroy(), 20);
            });
        });
        const ran = await run(GATE, ['test'], env(socket));
        expect(ran).toMatchObject({ code: RETRYABLE, stdout: '' });
    });

    it('a 200 answer that is not JSON is a transport failure, not a pass', async () => {
        const gate = await serve(200, '<html>proxy error</html>', true);
        const ran = await run(GATE, ['test'], env(gate.listen));
        expect(ran.code).toBe(RETRYABLE);
        expect(ran.stdout).toBe('');
    });

    it.each([[[]], [['--filter', 'x']], [['test', 'extra']], [['test', '--filter']], [['test', '--url', 'http://x']]])(
        'refuses the arguments %j without sending anything',
        async (args) => {
            const gate = await serve(200, '{}', true);
            const ran = await run(GATE, args, env(gate.listen));
            expect(ran.code).toBe(2);
            expect(gate.seen).toEqual([]);
        }
    );
});

describe('factory-control', () => {
    const env = (socket: string) => ({ FACTORY_CONTROL_SOCKET: socket });

    it('publish POSTs /publish with no body and prints the answer', async () => {
        const answer = '{"published":true,"prUrl":"https://github.com/o/r/pull/1","prNumber":1}';
        const control = await serve(201, answer, true);
        const ran = await run(CONTROL, ['publish'], env(control.listen));
        expect(ran).toMatchObject({ code: 0, stdout: answer });
        expect(control.seen).toEqual([{ method: 'POST', url: '/publish', authorization: undefined, body: '' }]);
    });

    it('review POSTs the key and the profile as JSON, encoded', async () => {
        const control = await serve(201, '{"done":false}', true);
        await run(CONTROL, ['review', 'security-1', 'sec"; $(id)'], env(control.listen));
        expect(control.seen).toHaveLength(1);
        expect(control.seen[0]).toMatchObject({ method: 'POST', url: '/review' });
        expect(JSON.parse(control.seen[0]?.body ?? '')).toEqual({ key: 'security-1', profile: 'sec"; $(id)' });
    });

    it('review-result GETs /review/<key>', async () => {
        const control = await serve(200, '{"done":true,"verdict":"clean"}', true);
        const ran = await run(CONTROL, ['review-result', 'security-1'], env(control.listen));
        expect(ran.stdout).toBe('{"done":true,"verdict":"clean"}');
        expect(control.seen[0]).toMatchObject({ method: 'GET', url: '/review/security-1' });
    });

    it('prints the body of a refusal and exits nonzero', async () => {
        const control = await serve(409, '{"error":"a request is already running"}', true);
        const ran = await run(CONTROL, ['publish'], env(control.listen));
        expect(ran).toMatchObject({ code: 22, stdout: '{"error":"a request is already running"}' });
        expect(ran.stderr).toContain('409');
    });

    it.each([
        [['status']],
        [['publish', 'x']],
        [['review', 'k']],
        [['review-result']],
        [['review-result', '../publish']],
        [['review', 'a/b', 'p']],
        [['constructor']],
        [[]],
    ])('refuses %j without reaching the socket', async (args) => {
        const control = await serve(200, '{}', true);
        const ran = await run(CONTROL, args, env(control.listen));
        expect(ran.code).toBe(2);
        expect(control.seen).toEqual([]);
    });

    it('exits nonzero when the socket does not exist', async () => {
        const ran = await run(CONTROL, ['publish'], env('/nonexistent/control.sock'));
        expect(ran.code).toBe(1);
        expect(ran.stderr).toContain('control.sock');
    });
});

describe('in the images', () => {
    const IMAGES = ['claude-executor', 'opencode-executor'];

    it.each(['factory-gate', 'factory-control'])('%s is one shared file, in neither image directory', (name) => {
        expect(readFileSync(join(ROOT, `docker/executor-common/${name}.cjs`), 'utf8')).toBeTruthy();
        for (const image of IMAGES) expect(existsSync(join(ROOT, `docker/${image}/${name}.cjs`)), image).toBe(false);
    });

    it.each(IMAGES)('%s installs both root-owned and executable on the PATH, with no extension', (image) => {
        const dockerfile = readFileSync(join(ROOT, `docker/${image}/Dockerfile`), 'utf8');
        for (const name of ['factory-gate', 'factory-control']) {
            expect(dockerfile).toContain(`COPY --from=common ${name}.cjs /usr/local/bin/${name}\n`);
            expect(dockerfile).toMatch(new RegExp(`chmod 0755 [^\\n]*/usr/local/bin/${name}\\b`));
        }
        expect(dockerfile).not.toMatch(/--chown[^\n]*factory-(gate|control)/);
    });
});
