import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * The runner's task-title helper (docs/connections.md): the real helper against a fake board on a socket, the
 * deadline compressed. Only the board is fake; the pair helper is the real one where the relayed lease is the
 * point.
 */
const HELPER = join(ROOT, 'docker/skills/factory-task-title/task-title.cjs');
const PAIR_HELPER = join(ROOT, 'docker/executor-common/attempt-pair.cjs');
const require_ = createRequire(import.meta.url);

interface Deps {
    env: Record<string, string | undefined>;
    now: () => number;
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    pair: (
        env: Record<string, string | undefined>,
        options?: { deadlineMs?: number }
    ) => Promise<{ jobId: string; leaseToken: string }>;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    deadlineMs: number;
}
const helper = require_(HELPER) as { run: (argv: string[], deps: Deps) => Promise<number> };
const { currentPair } = require_(PAIR_HELPER) as { currentPair: Deps['pair'] };

const JOB = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const RELAYED = '33333333-3333-4333-8333-333333333333';
const DEADLINE_MS = 800;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_UNKNOWN = 4;

type Handler = (req: IncomingMessage, res: ServerResponse, body: string, n: number) => void;

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function board(handler: Handler) {
    const seen: { headers: IncomingMessage['headers']; url: string; body: string }[] = [];
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            seen.push({ headers: req.headers, url: req.url ?? '', body });
            handler(req, res, body, seen.length);
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
};

async function call(argv: string[], url: string | undefined, over: Partial<Deps> = {}) {
    let out = '';
    let err = '';
    const deps: Deps = {
        env: { ...(url ? { FACTORY_STATS_URL: url } : {}), RUNNER_JOB_ID: JOB, RUNNER_LEASE_TOKEN: LEASE },
        now: Date.now,
        fetch: globalThis.fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
        pair: async (env) => ({ jobId: env.RUNNER_JOB_ID ?? '', leaseToken: env.RUNNER_LEASE_TOKEN ?? '' }),
        stdout: (t) => (out += t),
        stderr: (t) => (err += t),
        deadlineMs: DEADLINE_MS,
        ...over,
    };
    const started = Date.now();
    const code = await helper.run(argv, deps);
    return { code, out, err, took: Date.now() - started };
}

describe('task-title helper', () => {
    it("prints the board's JSON and exits 0 on 200, sending the pair and only the title", async () => {
        const fake = await board((_req, res) => json(res, 200, { title: 'Fix login', updated: true, version: 1 }));
        const run = await call(['Fix login'], fake.url);
        expect(run.code).toBe(0);
        expect(JSON.parse(run.out)).toEqual({ title: 'Fix login', updated: true, version: 1 });
        const [request] = fake.seen;
        expect(request?.url).toBe(`/api/jobs/${JOB}/agent-title`);
        expect(request?.headers['x-factory-job-id']).toBe(JOB);
        expect(request?.headers['x-factory-job-lease-token']).toBe(LEASE);
        expect(JSON.parse(request?.body ?? '')).toEqual({ title: 'Fix login' });
    });

    it('updated:false with a reason is still exit 0 and printed as the board said it', async () => {
        const answer = { title: 'Mine', updated: false, reason: 'user_title', version: 2 };
        const fake = await board((_req, res) => json(res, 200, answer));
        const run = await call(['Other'], fake.url);
        expect(run.code).toBe(0);
        expect(JSON.parse(run.out)).toEqual(answer);
    });

    it('uses the relayed lease from the control socket', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'task-title-'));
        dirs.push(dir);
        const socket = join(dir, 'control.sock');
        const control = createServer((_req, res) => json(res, 200, { leaseToken: RELAYED }));
        servers.push(control);
        await new Promise<void>((resolve) => control.listen(socket, resolve));
        const fake = await board((_req, res) => json(res, 200, { title: 'T', updated: true, version: 1 }));
        const run = await call(['T'], fake.url, {
            pair: (env, options) => currentPair({ ...env, FACTORY_CONTROL_SOCKET: socket }, options),
        });
        expect(run.code).toBe(0);
        expect(fake.seen[0]?.headers['x-factory-job-lease-token']).toBe(RELAYED);
    });

    it('re-reads the pair on every attempt', async () => {
        const leases = [LEASE, RELAYED];
        const fake = await board((_req, res, _b, n) =>
            n === 1
                ? json(res, 503, { code: 'LEASE_PENDING' }, { 'retry-after': '0' })
                : json(res, 200, { title: 'T', updated: true, version: 1 })
        );
        const run = await call(['T'], fake.url, {
            pair: async () => ({ jobId: JOB, leaseToken: leases.shift() ?? RELAYED }),
        });
        expect(run.code).toBe(0);
        expect(fake.seen.map((s) => s.headers['x-factory-job-lease-token'])).toEqual([LEASE, RELAYED]);
    });

    it('503 + Retry-After is retried inside the deadline, then exits non-zero with guidance', async () => {
        const fake = await board((_req, res) => json(res, 503, { code: 'LEASE_PENDING' }, { 'retry-after': '0' }));
        let t = 0;
        const run = await call(['T'], fake.url, { now: () => (t += 100) });
        expect(run.code).toBe(EXIT_UNKNOWN);
        expect(JSON.parse(run.out)).toMatchObject({ outcome: 'unknown', reason: 'deadline' });
        expect(run.err).toContain('did not confirm');
        expect(fake.seen.length).toBeGreaterThan(1);
    });

    it('a Retry-After the remaining budget cannot cover is not slept', async () => {
        const fake = await board((_req, res) => json(res, 503, { code: 'LEASE_PENDING' }, { 'retry-after': '5' }));
        const slept: number[] = [];
        const run = await call(['T'], fake.url, { sleep: async (ms) => void slept.push(ms) });
        expect(run.code).toBe(EXIT_UNKNOWN);
        expect(slept).toEqual([]);
        expect(fake.seen).toHaveLength(1);
        expect(run.took).toBeLessThan(DEADLINE_MS);
    });

    it('a hung board ends at the deadline', async () => {
        const fake = await board(() => undefined);
        const run = await call(['T'], fake.url);
        expect(run.code).toBe(EXIT_UNKNOWN);
        expect(run.took).toBeLessThan(DEADLINE_MS + 500);
        expect(JSON.parse(run.out).outcome).toBe('unknown');
    });

    it('a body that stalls after the headers ends at the deadline too', async () => {
        const fake = await board((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('{"title":');
        });
        const run = await call(['T'], fake.url);
        expect(run.code).toBe(EXIT_UNKNOWN);
        expect(run.took).toBeLessThan(DEADLINE_MS + 500);
    });

    it.each([
        [
            'a body cut off mid-stream',
            (res: ServerResponse) => {
                res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
                res.write('{"title":"T"');
                res.destroy();
            },
        ],
        ['a reset socket', (res: ServerResponse) => res.socket?.destroy()],
        [
            'malformed JSON',
            (res: ServerResponse) => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{"ti');
            },
        ],
        ["a 200 that is not the board's shape", (res: ServerResponse) => json(res, 200, { ok: true })],
        ['a 404', (res: ServerResponse) => json(res, 404, { error: 'x' })],
    ])('%s is non-zero "unknown", never updated:false', async (_name, respond) => {
        const fake = await board((_req, res) => respond(res));
        const run = await call(['T'], fake.url);
        expect(run.code).toBe(EXIT_UNKNOWN);
        const printed = JSON.parse(run.out);
        expect(printed.outcome).toBe('unknown');
        expect(printed).not.toHaveProperty('updated');
    });

    it.each([
        [400, 'BAD_TITLE'],
        [403, 'CONNECTION_NOT_AUTHORIZED'],
        [409, 'CONFLICT'],
        [429, 'TITLE_LIMIT'],
    ])('%i is a final refusal, not retried', async (status, code) => {
        const fake = await board((_req, res) => json(res, status, { error: 'nope', code }));
        const run = await call(['T'], fake.url);
        expect(run.code).toBe(EXIT_REFUSED);
        expect(JSON.parse(run.out)).toMatchObject({ outcome: 'refused', reason: code });
        expect(fake.seen).toHaveLength(1);
    });

    it('no pair in env: exit 2 with guidance and no request', async () => {
        const fake = await board((_req, res) => json(res, 200, {}));
        const run = await call(['T'], fake.url, { pair: async () => ({ jobId: '', leaseToken: '' }) });
        expect(run.code).toBe(EXIT_USAGE);
        expect(run.err).toContain('no attempt credential');
        expect(fake.seen).toEqual([]);
        const noUrl = await call(['T'], undefined);
        expect(noUrl.code).toBe(EXIT_USAGE);
    });

    it('the title comes from argv only, never from env, and a bad argv makes no request', async () => {
        const fake = await board((_req, res) => json(res, 200, { title: 'x', updated: true, version: 1 }));
        const viaEnv = await call([], fake.url, {
            env: {
                FACTORY_STATS_URL: fake.url,
                RUNNER_JOB_ID: JOB,
                RUNNER_LEASE_TOKEN: LEASE,
                TASK_TITLE: 'from env',
                TITLE: 'from env',
            },
        });
        expect(viaEnv.code).toBe(EXIT_USAGE);
        expect((await call(['   '], fake.url)).code).toBe(EXIT_USAGE);
        expect((await call(['a', 'b'], fake.url)).code).toBe(EXIT_USAGE);
        expect(fake.seen).toEqual([]);
    });
});
