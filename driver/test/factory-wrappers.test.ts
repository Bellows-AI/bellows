import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
const EXEC = join(ROOT, 'docker/executor-common/factory-exec.cjs');

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

// `factory-exec '<command>'` runs one command in the environment image through the same relay.
describe('factory-exec', () => {
    const env = (socket: string) => ({ FACTORY_CONTROL_SOCKET: socket });
    const RETRYABLE = 75;

    it('POSTs the one argument as {"exec"} to /gate/run and prints the answer unchanged', async () => {
        const answer = '{"exitCode":0,"output":"hi"}';
        const gate = await serve(200, answer, true);
        const ran = await run(EXEC, ['echo hi && ls "$HOME"'], env(gate.listen));
        expect(ran).toMatchObject({ code: 0, stdout: answer });
        expect(gate.seen).toEqual([
            {
                method: 'POST',
                url: '/gate/run',
                authorization: undefined,
                body: '{"exec":"echo hi && ls \\"$HOME\\""}',
            },
        ]);
        expect(JSON.parse(gate.seen[0]?.body ?? '')).toEqual({ exec: 'echo hi && ls "$HOME"' });
    });

    it('a command that exited nonzero is still a 2xx answer: exit 0, its exit code in the JSON', async () => {
        const answer = '{"exitCode":1,"output":"boom"}';
        const gate = await serve(200, answer, true);
        expect(await run(EXEC, ['false'], env(gate.listen))).toMatchObject({ code: 0, stdout: answer });
    });

    it("says there is no environment image only on the driver's explicit 404 no-gates answer", async () => {
        const gate = await serve(404, '{"error":"no gates"}', true);
        const ran = await run(EXEC, ['ls'], env(gate.listen));
        expect(ran.code).toBe(3);
        expect(ran.stderr).toContain('no environment image');
    });

    it('a 502 from the relay is retryable and says the command may have run', async () => {
        const gate = await serve(502, '{"error":"control relay unavailable"}', true);
        const ran = await run(EXEC, ['ls'], env(gate.listen));
        expect(ran.code).toBe(RETRYABLE);
        expect(ran.stderr).toMatch(/may (or may not )?have run/);
        expect(ran.stderr).not.toContain('no environment');
    });

    it('a 200 answer cut short is retryable and prints no partial result', async () => {
        const socket = await serveRaw((req, res) => {
            req.resume();
            req.on('end', () => {
                res.writeHead(200, { 'content-length': 500 });
                res.write('{"exitCode":0,"output":"par');
                setTimeout(() => res.destroy(), 20);
            });
        });
        expect(await run(EXEC, ['ls'], env(socket))).toMatchObject({ code: RETRYABLE, stdout: '' });
    });

    it('a 200 answer that is not JSON is retryable', async () => {
        const gate = await serve(200, '<html>proxy error</html>', true);
        expect(await run(EXEC, ['ls'], env(gate.listen))).toMatchObject({ code: RETRYABLE, stdout: '' });
    });

    it('any other status keeps the body with the HTTP exit', async () => {
        const body = '{"error":"exec must be a non-blank command with no NUL byte"}';
        const gate = await serve(400, body, true);
        const ran = await run(EXEC, ['ls'], env(gate.listen));
        expect(ran).toMatchObject({ code: 22, stdout: body });
        expect(ran.stderr).toContain('400');
    });

    it.each([[[]], [['ls', '-la']], [['']]])('refuses the arguments %j without sending anything', async (args) => {
        const gate = await serve(200, '{}', true);
        const ran = await run(EXEC, args, env(gate.listen));
        expect(ran.code).toBe(2);
        expect(gate.seen).toEqual([]);
    });

    it('refuses a command whose request is over 4096 bytes without sending anything', async () => {
        const gate = await serve(200, '{}', true);
        const ran = await run(EXEC, ['x'.repeat(4096)], env(gate.listen));
        expect(ran.code).toBe(2);
        expect(ran.stderr).toContain('command too long');
        expect(gate.seen).toEqual([]);
    });
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

/** A unix-socket server that answers each request with the next `[status, body]`, the last one repeated. */
async function serveSequence(answers: [number, string][]): Promise<{ socket: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    const socket = await serveRaw((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += String(chunk)));
        req.on('end', () => {
            seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
            const [status, reply] = answers[Math.min(seen.length, answers.length) - 1]!;
            res.statusCode = status;
            res.end(reply);
        });
    });
    return { socket, seen };
}

/*
 * `factory-finish`, the finish pass's caller both executors share (the claude Stop hook, the opencode
 * entrypoint's loop). It blocks the stop ONLY on a `fail` answer: exit 10 with the driver's message on
 * stdout. Everything else lets the agent stop — exit 0, nothing on stdout — and the close-time verifier
 * judges the run. A no-usable-answer is re-asked every 5 s within BELLOWS_FINISH_RETRY_MS of wall clock.
 */
describe('factory-finish', () => {
    const FINISH = join(ROOT, 'docker/executor-common/factory-finish.cjs');
    const BLOCK = 10;
    /** The retry step the helper waits between asks. */
    const RETRY_STEP_MS = 5_000;
    const SLOW_CASE_MS = 30_000;
    const MESSAGE =
        'The "test" gate failed (round 1 of 3). Fix the cause so the gate passes, keeping the change as small as the fix allows, then finish again.\n\nGate output:\nexpected 1 to be 2';
    const FAIL = JSON.stringify({
        verdict: 'fail',
        gate: 'test',
        exitCode: 1,
        output: 'expected 1 to be 2',
        round: 1,
        limit: 3,
        message: MESSAGE,
    });
    /** The helper's env: the proxy socket, and the supervisor relay socket beside it that says a relay exists. */
    const env = (socket: string, extra: Record<string, string> = {}) => ({
        FACTORY_CONTROL_SOCKET: socket,
        FACTORY_CTL_OUT: dirname(socket),
        ...extra,
    });

    it('blocks the stop on a fail answer: exit 10, the driver’s message on stdout, POST {} to /gate/finish', async () => {
        const finish = await serveSequence([[200, FAIL]]);
        const ran = await run(FINISH, [], env(finish.socket));
        expect(ran).toMatchObject({ code: BLOCK, stdout: MESSAGE });
        expect(finish.seen).toEqual([{ method: 'POST', url: '/gate/finish', authorization: undefined, body: '{}' }]);
    });

    it.each([
        ['pass', 200, '{"verdict":"pass"}'],
        ['skip', 200, '{"verdict":"skip","reason":"no change from base"}'],
        ['cap', 200, '{"verdict":"cap","rounds":3,"limit":3}'],
        ['unavailable', 200, '{"verdict":"unavailable","reason":"the round read failed"}'],
        ['a fail with no message', 200, '{"verdict":"fail","gate":"test"}'],
        ['a fail with an empty message', 200, '{"verdict":"fail","gate":"test","message":""}'],
        ['an unknown verdict', 200, '{"verdict":"maybe"}'],
        ['a JSON array', 200, '[]'],
        ['404 no gates', 404, '{"error":"no gates"}'],
        ['500', 500, '{"error":"finish pass failed: boom"}'],
        ['401', 401, '{"error":"unknown token"}'],
    ])('lets the stop through on %s, asking once', async (_label, status, reply) => {
        const finish = await serveSequence([[status, reply]]);
        const ran = await run(FINISH, [], env(finish.socket));
        expect(ran).toMatchObject({ code: 0, stdout: '' });
        expect(finish.seen).toHaveLength(1);
    });

    it(
        'asks again after a cut relay (502) and blocks on the answer that follows within the window',
        async () => {
            const finish = await serveSequence([
                [502, '{"error":"the control relay is unavailable"}'],
                [200, FAIL],
            ]);
            const ran = await run(FINISH, [], env(finish.socket, { BELLOWS_FINISH_RETRY_MS: '20000' }));
            expect(ran).toMatchObject({ code: BLOCK, stdout: MESSAGE });
            expect(finish.seen).toHaveLength(2);
        },
        SLOW_CASE_MS
    );

    it.each([
        ['a retryable 503', 503, '{"error":"the finish pass is not open yet","retryable":true}'],
        ['a 200 that is not JSON', 200, 'not json'],
    ])(
        'asks again after %s',
        async (_label, status, reply) => {
            const finish = await serveSequence([
                [status, reply],
                [200, FAIL],
            ]);
            const ran = await run(FINISH, [], env(finish.socket, { BELLOWS_FINISH_RETRY_MS: '20000' }));
            expect(ran).toMatchObject({ code: BLOCK, stdout: MESSAGE });
            expect(finish.seen).toHaveLength(2);
        },
        SLOW_CASE_MS
    );

    // An unset, empty, zero or malformed window is the default one, never "no retry".
    it.each([['0'], ['abc'], [''], ['-5']])(
        'keeps re-asking with BELLOWS_FINISH_RETRY_MS=%j',
        async (value) => {
            const finish = await serveSequence([
                [503, '{"error":"the finish pass is not open yet","retryable":true}'],
                [200, '{"verdict":"pass"}'],
            ]);
            const ran = await run(FINISH, [], env(finish.socket, { BELLOWS_FINISH_RETRY_MS: value }));
            expect(ran).toMatchObject({ code: 0, stdout: '' });
            expect(finish.seen).toHaveLength(2);
        },
        SLOW_CASE_MS
    );

    it(
        'gives up when the window of wall clock since its start has passed, letting the stop through',
        async () => {
            const finish = await serveSequence([[502, '{"error":"the control relay is unavailable"}']]);
            const window = 1_500;
            const started = Date.now();
            const ran = await run(FINISH, [], env(finish.socket, { BELLOWS_FINISH_RETRY_MS: String(window) }));
            const took = Date.now() - started;
            expect(ran).toMatchObject({ code: 0, stdout: '' });
            expect(took).toBeGreaterThanOrEqual(window);
            expect(took).toBeLessThan(RETRY_STEP_MS);
            expect(finish.seen.length).toBeGreaterThanOrEqual(2);
        },
        SLOW_CASE_MS
    );

    it(
        'gives up at the window when the proxy socket is missing',
        async () => {
            const relay = await serveSequence([[200, FAIL]]);
            const window = 1_500;
            const started = Date.now();
            const ran = await run(FINISH, [], {
                FACTORY_CONTROL_SOCKET: join(dirname(relay.socket), 'absent.sock'),
                FACTORY_CTL_OUT: dirname(relay.socket),
                BELLOWS_FINISH_RETRY_MS: String(window),
            });
            expect(ran).toMatchObject({ code: 0, stdout: '' });
            expect(Date.now() - started).toBeGreaterThanOrEqual(window);
        },
        SLOW_CASE_MS
    );

    // A container with no supervisor relay (an image run by hand, a reviewer) has nobody to ask: it
    // stops at once instead of waiting out the window.
    it.each([
        ['FACTORY_CTL_OUT unset', (_socket: string) => ({})],
        ['no relay socket in FACTORY_CTL_OUT', (socket: string) => ({ FACTORY_CTL_OUT: join(dirname(socket), 'x') })],
    ])('lets the stop through at once with %s', async (_label, relayEnv) => {
        const finish = await serveSequence([[200, FAIL]]);
        const started = Date.now();
        const ran = await run(FINISH, [], { FACTORY_CONTROL_SOCKET: finish.socket, ...relayEnv(finish.socket) });
        expect(ran).toMatchObject({ code: 0, stdout: '' });
        expect(finish.seen).toEqual([]);
        expect(Date.now() - started).toBeLessThan(RETRY_STEP_MS);
    });

    it('holds no control credential: it names no token and sends no authorization', () => {
        const source = readFileSync(FINISH, 'utf8');
        expect(source).not.toMatch(/token|authorization/i);
    });
});

describe('in the images', () => {
    const IMAGES = ['claude-executor', 'opencode-executor'];

    it.each(['factory-gate', 'factory-control', 'factory-exec', 'control-call', 'factory-finish'])(
        '%s is one shared file, in neither image directory',
        (name) => {
            expect(readFileSync(join(ROOT, `docker/executor-common/${name}.cjs`), 'utf8')).toBeTruthy();
            for (const image of IMAGES)
                expect(existsSync(join(ROOT, `docker/${image}/${name}.cjs`)), image).toBe(false);
        }
    );

    it.each(IMAGES)('%s installs every wrapper root-owned and executable on the PATH, with no extension', (image) => {
        const dockerfile = readFileSync(join(ROOT, `docker/${image}/Dockerfile`), 'utf8');
        for (const name of ['factory-gate', 'factory-control', 'factory-exec']) {
            expect(dockerfile).toContain(`COPY --from=common ${name}.cjs /usr/local/bin/${name}\n`);
            expect(dockerfile).toMatch(new RegExp(`chmod 0755 [^\\n]*/usr/local/bin/${name}\\b`));
        }
        expect(dockerfile).not.toMatch(/--chown[^\n]*factory-(gate|control|exec)/);
    });

    // The wrappers `require('./control-call.cjs')`: it sits beside them, root-owned.
    it.each(IMAGES)('%s installs the shared transport beside the wrappers', (image) => {
        const dockerfile = readFileSync(join(ROOT, `docker/${image}/Dockerfile`), 'utf8');
        expect(dockerfile).toContain('COPY --from=common control-call.cjs /usr/local/bin/control-call.cjs\n');
        expect(dockerfile).not.toMatch(/--chown[^\n]*control-call/);
    });
});
