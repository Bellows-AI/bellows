import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlChannel } from '../src/control-channel.js';
import type { ExportManifestRequest, ExportReport } from '../src/export-control.js';
import { pathOf } from './fixtures/scripts-support.js';

/**
 * The continuous claude-code exporter (`claude-export.cjs`) run for real against the driver's own
 * control channel, with only the board behind the relay faked: what it uploads, when it holds a
 * record back, how it follows a rotation, what it does when the board is down, and how it drains.
 */

const SESSION = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'export-token';
const WAIT_MS = 15_000;

interface Chunk {
    session: string;
    offset: number;
    body: Buffer;
}

interface Harness {
    dir: string;
    chunks: Chunk[];
    manifests: ExportManifestRequest[];
    reports: ExportReport[];
    board: { down: boolean };
    drain: (state: 'complete' | 'partial', cause: string | null) => void;
    close: () => void;
    start: (env?: Record<string, string>) => ChildProcess;
    /** The bytes the board holds for one session, in offset order, with a check that offsets chain. */
    stored: (session: string) => Buffer;
    exited: () => Promise<number | null>;
}

const running: { server: Server | null; child: ChildProcess | null } = { server: null, child: null };

afterEach(() => {
    running.child?.kill('SIGKILL');
    running.server?.close();
});

const until = async (what: string, ready: () => boolean): Promise<void> => {
    const deadline = Date.now() + WAIT_MS;
    while (!ready()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

async function harness(): Promise<Harness> {
    const dir = mkdtempSync(join(tmpdir(), 'claude-export-'));
    const projects = join(dir, 'projects', '-work-tree');
    mkdirSync(projects, { recursive: true });
    const channel = createControlChannel();
    const chunks: Chunk[] = [];
    const manifests: ExportManifestRequest[] = [];
    const reports: ExportReport[] = [];
    const board = { down: false };
    channel.open(TOKEN);
    channel.attachExporter(TOKEN, {
        putChunk: async (session, offset, bytes) => {
            if (board.down) throw new Error('the board is down');
            chunks.push({ session, offset, body: Buffer.from(bytes) });
            return { result: 'stored' };
        },
        finalize: async (manifest) => {
            manifests.push(manifest);
            return 'stored';
        },
        report: (report) => {
            reports.push(report);
        },
    });
    const server = createServer((request, reply) => {
        const auth = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        void channel.serve(request, reply, auth).then((handled) => {
            if (!handled) {
                reply.statusCode = 404;
                reply.end();
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    running.server = server;
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let exit: Promise<number | null> = Promise.resolve(null);
    return {
        dir,
        chunks,
        manifests,
        reports,
        board,
        drain: (state, cause) => channel.drainExport(TOKEN, { state, cause }),
        close: () => channel.close(TOKEN),
        start: (env = {}) => {
            const child = spawn('node', [pathOf('claude-export.cjs')], {
                env: {
                    ...process.env,
                    CLAUDE_TRANSCRIPT_DIR: dir,
                    BELLOWS_CONTROL_URL: url,
                    BELLOWS_CONTROL_TOKEN: TOKEN,
                    EXPORT_POLL_MS: '30',
                    EXPORT_FLUSH_MS: '150',
                    ...env,
                },
                stdio: ['ignore', 'ignore', 'inherit'],
            });
            exit = new Promise((resolve) => child.on('exit', resolve));
            running.child = child;
            return child;
        },
        stored: (session) => {
            const own = chunks.filter((c) => c.session === session).sort((a, b) => a.offset - b.offset);
            let at = own[0]?.offset ?? 0;
            for (const chunk of own) {
                expect(chunk.offset).toBe(at);
                at += chunk.body.length;
            }
            return Buffer.concat(own.map((c) => c.body));
        },
        exited: () => exit,
    };
}

const fileOf = (h: Harness, name = `${SESSION}.jsonl`): string => join(h.dir, 'projects', '-work-tree', name);

const records = (count: number, from = 0): string =>
    Array.from({ length: count }, (_, i) => JSON.stringify({ n: from + i, pad: 'x'.repeat(60) })).join('\n') + '\n';

describe('the continuous claude-code exporter', () => {
    it('uploads cut at record boundaries while the file grows, and a normal exit is complete and byte-identical', async () => {
        const h = await harness();
        const file = fileOf(h);
        const first = records(40);
        writeFileSync(file, first);
        h.start({ EXPORT_FLUSH_BYTES: '1000' });
        // Uploaded while the agent is still running: nothing has drained yet.
        await until('the first chunks', () => h.stored(SESSION).length === Buffer.byteLength(first));
        expect(h.manifests).toEqual([]);
        for (const chunk of h.chunks) {
            expect(chunk.body.at(-1)).toBe(0x0a);
            expect(chunk.body.length).toBeLessThanOrEqual(1100);
        }
        const second = records(25, 40);
        appendFileSync(file, second);
        h.drain('complete', null);
        expect(await h.exited()).toBe(0);
        expect(h.stored(SESSION).equals(Buffer.from(first + second))).toBe(true);
        expect(h.manifests).toHaveLength(1);
        expect(h.manifests[0]).toMatchObject({ session: SESSION, state: 'complete', terminalCause: null });
        expect(h.reports.at(-1)).toMatchObject({ done: true, pendingBytes: 0, spoolFull: false });
    });

    it('holds a partial trailing record back until its newline arrives', async () => {
        const h = await harness();
        const file = fileOf(h);
        writeFileSync(file, `${records(2)}{"n":2,"half`);
        h.start({ EXPORT_FLUSH_MS: '50' });
        await until('the whole records', () => h.stored(SESSION).length === Buffer.byteLength(records(2)));
        // Well past the flush age, the fragment is still not uploaded.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(h.stored(SESSION).toString()).toBe(records(2));
        appendFileSync(file, ' record"}\n');
        await until('the completed record', () => h.stored(SESSION).toString().endsWith('half record"}\n'));
        h.drain('complete', null);
        expect(await h.exited()).toBe(0);
        expect(h.manifests[0]?.state).toBe('complete');
    });

    it('a fragment still unfinished at the drain is never uploaded and the manifest says partial', async () => {
        const h = await harness();
        writeFileSync(fileOf(h), `${records(3)}{"n":3,"cut`);
        h.start();
        await until('the whole records', () => h.stored(SESSION).length === Buffer.byteLength(records(3)));
        h.drain('partial', 'agent_killed');
        expect(await h.exited()).toBe(0);
        expect(h.stored(SESSION).toString()).toBe(records(3));
        expect(h.manifests[0]).toMatchObject({ state: 'partial', terminalCause: 'agent_killed' });
    });

    it('follows a rotation: the rotated file is read to its end and the new one continues the stream', async () => {
        const h = await harness();
        const file = fileOf(h);
        const before = records(10);
        writeFileSync(file, before);
        h.start();
        await until('the first generation', () => h.stored(SESSION).length === Buffer.byteLength(before));
        // The old file keeps a record the exporter has not read yet when it is moved away.
        const tail = records(2, 10);
        appendFileSync(file, tail);
        renameSync(file, `${file}.1`);
        const after = records(5, 12);
        writeFileSync(file, after);
        h.drain('complete', null);
        expect(await h.exited()).toBe(0);
        expect(h.stored(SESSION).toString()).toBe(before + tail + after);
        expect(h.manifests[0]).toMatchObject({ state: 'complete' });
    });

    it('a file truncated in place keeps what was read and exports what follows', async () => {
        const h = await harness();
        const file = fileOf(h);
        const before = records(8);
        writeFileSync(file, before);
        h.start();
        await until('the first generation', () => h.stored(SESSION).length === Buffer.byteLength(before));
        truncateSync(file, 0);
        const after = records(3, 8);
        appendFileSync(file, after);
        await until('the bytes after the cut', () => h.stored(SESSION).toString() === before + after);
        h.drain('complete', null);
        expect(await h.exited()).toBe(0);
    });

    it('at the spool cap it reports the attempt failed, drops nothing, and drains once the board is back', async () => {
        const h = await harness();
        h.board.down = true;
        const all = records(60);
        writeFileSync(fileOf(h), all);
        h.start({ EXPORT_SPOOL_MAX_BYTES: '2000', EXPORT_FLUSH_BYTES: '500' });
        await until('the spool-full report', () => h.reports.some((r) => r.spoolFull));
        const full = h.reports.findLast((r) => r.spoolFull);
        expect(full?.pendingBytes).toBeGreaterThan(2000);
        expect(h.chunks).toEqual([]);
        // Every byte is still there to send: the board comes back and the drain delivers all of it.
        h.board.down = false;
        h.drain('partial', 'artifact_spool_full');
        expect(await h.exited()).toBe(0);
        expect(h.stored(SESSION).toString()).toBe(all);
        expect(h.manifests[0]).toMatchObject({ state: 'partial', terminalCause: 'artifact_spool_full' });
    });

    it('reports the oldest unacknowledged age and bytes while the board is down', async () => {
        const h = await harness();
        h.board.down = true;
        writeFileSync(fileOf(h), records(4));
        h.start({ EXPORT_FLUSH_MS: '50' });
        await until('a backlog report', () => h.reports.some((r) => r.pendingBytes > 0 && r.oldestUnackedMs > 0));
        const report = h.reports.findLast((r) => r.pendingBytes > 0);
        expect(report?.pendingBytes).toBe(Buffer.byteLength(records(4)));
    });

    it('after an agent kill, every fully written record is uploaded and the manifest is partial', async () => {
        const h = await harness();
        const file = fileOf(h);
        h.start({ EXPORT_FLUSH_MS: '60000' });
        // The agent wrote records and was killed before the exporter flushed any of them.
        writeFileSync(file, `${records(6)}{"n":6,"killed mid-wri`);
        h.drain('partial', 'agent_killed');
        expect(await h.exited()).toBe(0);
        expect(h.stored(SESSION).toString()).toBe(records(6));
        expect(h.manifests[0]).toMatchObject({ session: SESSION, state: 'partial', terminalCause: 'agent_killed' });
    });

    it('exports only what a resumed session appends, at its own byte offsets, and a new session whole', async () => {
        const h = await harness();
        const file = fileOf(h);
        const earlier = records(5);
        writeFileSync(file, earlier);
        await new Promise((resolve) => setTimeout(resolve, 50));
        h.start({ RUN_STARTED_AT: new Date().toISOString() });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const appended = records(2, 5);
        appendFileSync(file, appended);
        const fresh = records(3, 100);
        writeFileSync(fileOf(h, 'brand-new.jsonl'), fresh);
        h.drain('complete', null);
        expect(await h.exited()).toBe(0);
        expect(h.stored(SESSION).toString()).toBe(appended);
        expect(h.chunks.find((c) => c.session === SESSION)?.offset).toBe(Buffer.byteLength(earlier));
        expect(h.stored('brand-new').toString()).toBe(fresh);
    });

    it('gives a subagent its own session', async () => {
        const h = await harness();
        const sub = join(h.dir, 'projects', '-work-tree', SESSION, 'subagents');
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, 'agent-a1.jsonl'), records(2));
        writeFileSync(fileOf(h), records(3));
        h.start();
        h.drain('complete', null);
        expect(await h.exited()).toBe(0);
        expect(h.stored('agent-a1').toString()).toBe(records(2));
        expect(h.stored(SESSION).toString()).toBe(records(3));
        expect(h.manifests.map((m) => m.session).sort()).toEqual([SESSION, 'agent-a1']);
    });

    it('leaves with its own exit code when the control token is closed', async () => {
        const h = await harness();
        writeFileSync(fileOf(h), records(1));
        h.start();
        await until('the first chunk', () => h.chunks.length > 0);
        h.close();
        expect(await h.exited()).toBe(3);
    });
});
