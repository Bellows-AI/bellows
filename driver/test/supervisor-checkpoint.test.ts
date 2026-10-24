import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { SUPERVISOR_ENV, SUPERVISOR_EXIT } from '../src/supervisor-contract.js';
import { liveSupervisors, stopSupervisors, superviseTracked } from './fixtures/supervisor-tracker.js';

/**
 * The supervisor's finalize stage takes the attempt's checkpoint (issue #775) after the driver has
 * ordered the end — so after the publish — and before the report is final: it runs the checkpoint
 * script, uploads a header line then the script's parts as binary chunks through the driver's
 * control endpoint, and closes the stream with a manifest. The script is a fake here; its own
 * behaviour is `scripts-checkpoint.test.ts`.
 */
process.env.SUPERVISOR_NO_MAIN = '1';
const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as {
    supervise: (env: Record<string, string>, log: (line: string) => void) => Promise<number>;
};

const TOKEN = 'tok-supervisor-secret';

interface Call {
    kind: 'chunk' | 'manifest';
    offset?: number;
    bytes?: Buffer;
    manifest?: Record<string, unknown>;
    at: number;
}

interface Driver {
    url: string;
    calls: Call[];
    reports: number;
    /** How the n-th checkpoint request (from 1) is answered. */
    answer: (n: number, call: Call) => { status: number; body?: unknown };
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterEach(stopSupervisors);
afterEach(() => vi.restoreAllMocks());
afterAll(() => expect(liveSupervisors()).toBe(0));

const bodyOf = (request: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks)));
    });

/** A driver that releases nothing and orders `finish` once the supervisor has reported. */
async function startDriver(): Promise<Driver> {
    let finishOrdered = false;
    const driver: Driver = {
        url: '',
        calls: [],
        reports: 0,
        answer: () => ({ status: 200, body: { result: 'stored' } }),
    };
    const server = createServer((request, response) => {
        void (async () => {
            const send = (status: number, body: unknown) => {
                response.writeHead(status, { 'content-type': 'application/json' });
                response.end(JSON.stringify(body));
            };
            if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, {});
            const url = request.url ?? '';
            if (request.method === 'GET' && url === '/control') return send(200, { stop: false, kill: false });
            if (request.method === 'GET' && url.startsWith('/step?')) {
                if (driver.reports > 0 && !finishOrdered) {
                    finishOrdered = true;
                    return send(200, {
                        step: { id: 'finish', invocation: 'i-1', kind: 'finish', argv: [], env: {}, timeoutMs: 1000 },
                    });
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
                return send(200, {});
            }
            if (request.method === 'POST' && url === '/report') {
                await bodyOf(request);
                driver.reports += 1;
                return send(200, {});
            }
            if (request.method === 'PUT' && url.startsWith('/checkpoint/')) {
                const raw = await bodyOf(request);
                const call: Call = url.startsWith('/checkpoint/chunk')
                    ? {
                          kind: 'chunk',
                          offset: Number(new URL(url, 'http://x').searchParams.get('offset')),
                          bytes: raw,
                          at: Date.now(),
                      }
                    : {
                          kind: 'manifest',
                          manifest: JSON.parse(raw.toString()) as Record<string, unknown>,
                          at: Date.now(),
                      };
                driver.calls.push(call);
                const answer = driver.answer(driver.calls.length, call);
                return send(answer.status, answer.body ?? {});
            }
            return send(404, {});
        })();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    driver.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return driver;
}

/** A checkpoint script that writes `parts` into OUT_DIR and answers `verdict` (or raw stdout). */
function fakeScript(parts: Record<string, string>, verdict: string, before = ''): string {
    return `
        const fs = require('node:fs'); const path = require('node:path');
        fs.mkdirSync(process.env.OUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.OUT_DIR, 'seen-env.json'), JSON.stringify(process.env));
        const parts = ${JSON.stringify(parts)};
        for (const [name, text] of Object.entries(parts)) fs.writeFileSync(path.join(process.env.OUT_DIR, name), text);
        const dir = process.env.OUT_DIR;
        ${before}
        const verdict = ${verdict};
        process.stdout.write(JSON.stringify(verdict) + '\\n');
    `;
}

/** Verdict source writing the header file in the script's directory (`dir`); the verdict carries its path, not the header. */
const headerAt = (header: object): string =>
    `(fs.writeFileSync(dir + '/header.json', JSON.stringify(${JSON.stringify(header)})), dir + '/header.json')`;

/** The verdict source for a script that made `names` in its directory (`dir`), complete. */
const completeVerdict = (names: string[]): string =>
    `({ ok: true, state: 'complete', cause: null, headerFile: ${headerAt({ version: 1, tip: 'a' })},
        parts: ${JSON.stringify(names)}.map((n) => ({ path: dir + '/' + n, bytes: require('node:fs').statSync(dir + '/' + n).size })) })`;

function run(driver: Driver | null, script: string | null, env: Record<string, string> = {}, now?: () => number) {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-checkpoint-'));
    dirs.push(root);
    for (const name of ['in', 'out', 'export', 'supervisor', 'gate', 'review']) mkdirSync(join(root, name));
    const outDir = join(root, 'task-checkpoint');
    const logs: string[] = [];
    const done = superviseTracked(
        supervisor,
        {
            FACTORY_CTL_ROOT: root,
            SUPERVISOR_TICK_MS: '10',
            SUPERVISOR_CONTROL_MS: '10',
            SUPERVISOR_AGENTLESS: '1',
            ...(driver ? { SUPERVISOR_CONTROL_URL: driver.url, SUPERVISOR_CONTROL_TOKEN: TOKEN } : {}),
            ...(script === null
                ? {}
                : {
                      [SUPERVISOR_ENV.checkpointScript]: script,
                      [SUPERVISOR_ENV.checkpointCheckout]: '/task/factory',
                      [SUPERVISOR_ENV.checkpointBranch]: 'factory/root',
                      [SUPERVISOR_ENV.checkpointDir]: outDir,
                      [SUPERVISOR_ENV.checkpointOpencodeDb]: '/task/.factory/opencode/root/opencode/opencode.db',
                  }),
            ...env,
        },
        (line) => logs.push(line),
        now ? { now } : {}
    );
    return { done, logs, outDir };
}

describe('the supervisor’s finalize stage: the checkpoint', () => {
    it('uploads the header line then each part, in order, as binary chunks, and closes the stream complete', async () => {
        const driver = await startDriver();
        const script = fakeScript(
            { bundle: 'BUNDLE-BYTES', 'opencode.db': 'SQLITE' },
            completeVerdict(['bundle', 'opencode.db'])
        );

        const supervised = run(driver, script);

        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        const chunks = driver.calls.filter((c) => c.kind === 'chunk');
        const stream = Buffer.concat(chunks.map((c) => c.bytes!));
        const [header, ...rest] = stream.toString().split('\n');
        expect(JSON.parse(header!)).toMatchObject({ version: 1 });
        expect(rest.join('\n')).toBe('BUNDLE-BYTESSQLITE');
        // Each chunk sits at the offset the bytes before it add up to: a retry of one is the same bytes.
        let at = 0;
        for (const chunk of chunks) {
            expect(chunk.offset).toBe(at);
            at += chunk.bytes!.length;
        }
        const manifest = driver.calls.at(-1)!;
        expect(manifest.kind).toBe('manifest');
        expect(manifest.manifest).toMatchObject({ state: 'complete', terminalCause: null });
        expect(manifest.manifest).toEqual(
            expect.objectContaining({ startedAt: expect.any(String), finishedAt: expect.any(String) })
        );
        // The report was delivered before, the volume is left clean after.
        expect(driver.reports).toBe(1);
        expect(existsSync(supervised.outDir)).toBe(false);
    });

    it('cuts a part into bounded chunks', async () => {
        const driver = await startDriver();
        // Made by the script: a megabyte-sized part cannot ride an environment variable.
        const script = fakeScript(
            {},
            completeVerdict(['bundle']),
            "require('node:fs').writeFileSync(dir + '/bundle', 'x'.repeat(2500000));"
        );

        await run(driver, script).done;

        const chunks = driver.calls.filter((c) => c.kind === 'chunk');
        expect(chunks.length).toBeGreaterThanOrEqual(3);
        for (const chunk of chunks) expect(chunk.bytes!.length).toBeLessThanOrEqual(1_048_576);
        expect(Buffer.concat(chunks.map((c) => c.bytes!)).length).toBeGreaterThan(2_500_000);
    });

    it('uploads no bytes of a truncated checkpoint: the header alone, the stream closed truncated', async () => {
        const driver = await startDriver();
        const script = fakeScript(
            {},
            "({ ok: true, state: 'truncated', cause: 'checkpoint_cap', headerFile: " +
                headerAt({ version: 1, truncated: true }) +
                ', parts: [] })'
        );

        await run(driver, script).done;

        const chunks = driver.calls.filter((c) => c.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(JSON.parse(chunks[0]!.bytes!.toString())).toEqual({ version: 1, truncated: true });
        expect(driver.calls.at(-1)!.manifest).toMatchObject({ state: 'truncated', terminalCause: 'checkpoint_cap' });
    });

    it('hands the script its tree, branch, directory and database, and none of the supervisor’s credentials', async () => {
        const driver = await startDriver();
        let seen: Record<string, string> = {};
        const script = fakeScript({ bundle: 'b' }, completeVerdict(['bundle']));
        const supervised = run(driver, script);
        // The fake wrote its environment beside its parts; read it before the stage cleans up.
        const dir = supervised.outDir;
        for (let i = 0; i < 200 && !existsSync(join(dir, 'seen-env.json')); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (existsSync(join(dir, 'seen-env.json'))) seen = JSON.parse(readFileSync(join(dir, 'seen-env.json'), 'utf8'));
        await supervised.done;

        expect(seen).toMatchObject({
            CHECKOUT: '/task/factory',
            BRANCH: 'factory/root',
            OUT_DIR: dir,
            OPENCODE_DB: '/task/.factory/opencode/root/opencode/opencode.db',
        });
        expect(Object.keys(seen).filter((name) => name.startsWith('SUPERVISOR_'))).toEqual([]);
    });

    it('retries a chunk the board could not take until it is stored', async () => {
        const driver = await startDriver();
        driver.answer = (n) =>
            n <= 2 ? { status: 502, body: { error: 'board down' } } : { status: 200, body: { result: 'stored' } };

        await run(driver, fakeScript({ bundle: 'b' }, completeVerdict(['bundle']))).done;

        const chunks = driver.calls.filter((c) => c.kind === 'chunk');
        expect(chunks.slice(0, 3).map((c) => c.offset)).toEqual([0, 0, 0]);
        expect(driver.calls.at(-1)!.manifest).toMatchObject({ state: 'complete' });
    });

    it('stops at the board’s refusal and closes the stream truncated with the board’s cause', async () => {
        const driver = await startDriver();
        driver.answer = (_n, call) =>
            call.kind === 'chunk'
                ? { status: 413, body: { cause: 'stream_cap' } }
                : { status: 200, body: { result: 'stored' } };

        await run(driver, fakeScript({ bundle: 'b' }, completeVerdict(['bundle']))).done;

        expect(driver.calls.filter((c) => c.kind === 'chunk')).toHaveLength(1);
        expect(driver.calls.at(-1)!.manifest).toMatchObject({ state: 'truncated', terminalCause: 'stream_cap' });
    });

    it('gives up at an absolute wall-clock deadline when the driver keeps failing, and still finalizes', async () => {
        const driver = await startDriver();
        const deadlineMs = 400;
        // The deadline is a real timer (`AbortSignal.timeout`) plus the injected clock: both are held
        // open until the driver has refused two calls, then expire together — never by host load.
        const deadline = new AbortController();
        let expired = false;
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
            ms === deadlineMs ? deadline.signal : realTimeout(ms)
        );
        // The checkpoint child's own budget is the same bound as a real timer: park it, so load cannot
        // kill the child before the driver's refusals. (Timers of other lengths are untouched.)
        const realSetTimeout = globalThis.setTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
            realSetTimeout(fn, ms === deadlineMs ? 600_000 : ms)) as typeof setTimeout);
        driver.answer = (n) => {
            if (n >= 2) {
                expired = true;
                deadline.abort();
            }
            return { status: 502, body: { error: 'board down' } };
        };
        const startedAt = Date.now();

        const supervised = run(
            driver,
            fakeScript({ bundle: 'b' }, completeVerdict(['bundle'])),
            { [SUPERVISOR_ENV.checkpointMs]: String(deadlineMs) },
            () => (expired ? startedAt + 10 * deadlineMs : startedAt)
        );

        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        // Event-based: the deadline fired only after the driver refused twice, and finalize followed.
        expect(expired).toBe(true);
        expect(driver.calls.length).toBeGreaterThanOrEqual(2);
        expect(driver.calls.every((c) => c.kind === 'chunk' || c.kind === 'manifest')).toBe(true);
        expect(existsSync(supervised.outDir)).toBe(false);
    });

    it('a stop during the checkpoint script kills its child, so the supervisor settles promptly', async () => {
        const driver = await startDriver();
        const sleeping = `fs.writeFileSync(dir + '/sleeping', '1'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);`;
        const supervised = run(driver, fakeScript({ bundle: 'b' }, completeVerdict(['bundle']), sleeping), {
            [SUPERVISOR_ENV.checkpointMs]: '120000',
        });
        for (let i = 0; i < 600 && !existsSync(join(supervised.outDir, 'sleeping')); i++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(existsSync(join(supervised.outDir, 'sleeping'))).toBe(true);

        // Rejects if the supervisor has not settled within the tracker's bound of the stop.
        await stopSupervisors();
        await supervised.done;
        expect(supervised.logs.some((line) => line.includes('checkpoint: not taken'))).toBe(true);
    });

    it('uploads nothing where the script failed or found no tree, and nothing where none is configured', async () => {
        for (const script of [
            fakeScript({}, "({ ok: false, reason: 'git add failed' })"),
            fakeScript({}, "({ ok: true, state: 'none' })"),
            null,
        ]) {
            const driver = await startDriver();
            const supervised = run(driver, script);
            expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
            expect(driver.calls).toEqual([]);
        }
    });
});
