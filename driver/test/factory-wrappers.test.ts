import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * `factory-gate` and `factory-control` (issue #1061), the two commands the baked skills use for the
 * gate server and the run-control socket, so the managed allowlist can name them instead of a `curl`
 * whose `*` would take any URL. Driven as real processes against a loopback gate server and a unix
 * socket; the destination is fixed, the arguments only fill a JSON an encoder builds.
 */
const GATE = join(ROOT, 'docker/claude-executor/factory-gate.cjs');
const CONTROL = join(ROOT, 'docker/claude-executor/factory-control.cjs');

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

describe('factory-gate', () => {
    const env = (url: string) => ({ BELLOWS_GATE_URL: url, BELLOWS_GATE_TOKEN: 'tok-1' });

    it('POSTs the gate name to $BELLOWS_GATE_URL/run with the bearer and prints the answer unchanged', async () => {
        const answer = '{"exitCode":0,"output":"ok","executionId":"e-1"}';
        const gate = await serve(200, answer);
        const ran = await run(GATE, ['test'], env(gate.listen));
        expect(ran).toMatchObject({ code: 0, stdout: answer });
        expect(gate.seen).toEqual([
            { method: 'POST', url: '/run', authorization: 'Bearer tok-1', body: '{"gate":"test"}' },
        ]);
    });

    it('sends --filter as the filter field and nothing else', async () => {
        const gate = await serve(200, '{"exitCode":0}');
        await run(GATE, ['unit', '--filter', 'src/a.test.ts'], env(gate.listen));
        expect(JSON.parse(gate.seen[0]?.body ?? '')).toEqual({ gate: 'unit', filter: 'src/a.test.ts' });
    });

    it('encodes shell-hostile input as data: nothing is interpolated or run', async () => {
        const gate = await serve(200, '{}');
        const hostile = `a"}'; $(touch /tmp/pwned) \`id\` \\n`;
        await run(GATE, ['test', '--filter', hostile], env(gate.listen));
        expect(JSON.parse(gate.seen[0]?.body ?? '')).toEqual({ gate: 'test', filter: hostile });
    });

    it('keeps the answer of a refused run: the retryable 503 body with its executionId, and a nonzero exit', async () => {
        const body = '{"error":"not recorded","retryable":true,"executionId":"e-2"}';
        const gate = await serve(503, body);
        const ran = await run(GATE, ['test'], env(gate.listen));
        expect(ran.stdout).toBe(body);
        expect(ran.code).toBe(22);
        expect(ran.stderr).toContain('503');
    });

    it('exits nonzero when nothing answers', async () => {
        const gate = await serve(200, '{}');
        const url = gate.listen;
        servers.pop()?.close();
        const ran = await run(GATE, ['test'], env(url));
        expect(ran.code).toBe(1);
        expect(ran.stdout).toBe('');
    });

    it('says there are no gates when BELLOWS_GATE_URL is unset', async () => {
        const ran = await run(GATE, ['test'], {});
        expect(ran.code).toBe(3);
        expect(ran.stderr).toContain('BELLOWS_GATE_URL');
    });

    it.each([[[]], [['--filter', 'x']], [['test', 'extra']], [['test', '--filter']], [['test', '--url', 'http://x']]])(
        'refuses the arguments %j without sending anything',
        async (args) => {
            const gate = await serve(200, '{}');
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

    it.each(['factory-gate', 'factory-control'])('%s is byte-identical in both images', (name) => {
        const [a, b] = IMAGES.map((image) => readFileSync(join(ROOT, `docker/${image}/${name}.cjs`), 'utf8'));
        expect(a).toBeTruthy();
        expect(a).toBe(b);
    });

    it.each(IMAGES)('%s installs both root-owned and executable on the PATH, with no extension', (image) => {
        const dockerfile = readFileSync(join(ROOT, `docker/${image}/Dockerfile`), 'utf8');
        for (const name of ['factory-gate', 'factory-control']) {
            expect(dockerfile).toContain(`COPY ${name}.cjs /usr/local/bin/${name}\n`);
            expect(dockerfile).toMatch(new RegExp(`chmod 0755 [^\\n]*/usr/local/bin/${name}\\b`));
        }
        expect(dockerfile).not.toMatch(/--chown[^\n]*factory-(gate|control)/);
    });
});
