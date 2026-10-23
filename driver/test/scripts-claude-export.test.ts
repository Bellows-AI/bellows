import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, createServer as createTcpServer, type Socket } from 'node:net';
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
/** The attempt's supervisor token, and the exporter's own export-only token beside it. */
const SUPERVISOR = 'supervisor-token';
const TOKEN = 'export-token';
const WAIT_MS = 15_000;

interface ExporterStatus {
    pendingBytes: number;
    oldestUnackedMs: number;
    spoolFull: boolean;
    done: boolean;
    gone: boolean;
}

interface Chunk {
    session: string;
    offset: number;
    body: Buffer;
}

interface Relay {
    /** The authorization header of every request that reached it, absent ones included. */
    authorization: (string | undefined)[];
    /** While set, every request is hung up on: a holder the supervisor cannot reach. */
    hangUp: boolean;
}

interface Harness {
    dir: string;
    chunks: Chunk[];
    manifests: ExportManifestRequest[];
    reports: ExportReport[];
    board: { down: boolean; delayMs: number };
    drain: (state: 'complete' | 'partial', cause: string | null) => void;
    /** The directory shared with the supervisor, and what the exporter wrote there last. */
    exportDir: string;
    status: () => ExporterStatus | null;
    close: () => void;
    /** The control endpoint goes away: the board, and the driver in front of it, are unreachable. */
    stopServer: () => void;
    start: (env?: Record<string, string>) => ChildProcess;
    /** The supervisor's relay as the exporter sees it: a socket that adds the token itself, or hangs up. */
    listenRelay: (socket: string) => Promise<Relay>;
    /** The bytes the board holds for one session, in offset order, with a check that offsets chain. */
    stored: (session: string) => Buffer;
    exited: () => Promise<number | null>;
}

const running: { server: Server | null; child: ChildProcess | null; relays: Server[] } = {
    server: null,
    child: null,
    relays: [],
};

afterEach(() => {
    running.child?.kill('SIGKILL');
    running.server?.close();
    for (const relay of running.relays.splice(0)) relay.close();
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
    const exportDir = mkdtempSync(join(tmpdir(), 'claude-export-mailbox-'));
    const channel = createControlChannel();
    const chunks: Chunk[] = [];
    const manifests: ExportManifestRequest[] = [];
    const reports: ExportReport[] = [];
    const board = { down: false, delayMs: 0 };
    channel.open(SUPERVISOR);
    channel.grantExporter(SUPERVISOR, TOKEN);
    channel.attachExporter(SUPERVISOR, {
        putChunk: async (session, offset, bytes) => {
            if (board.down) throw new Error('the board is down');
            await new Promise((resolve) => setTimeout(resolve, board.delayMs));
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
        // The supervisor's drain order: a file in the directory only it and the exporter mount.
        drain: (state, cause) => writeFileSync(join(exportDir, 'drain.json'), JSON.stringify({ state, cause })),
        exportDir,
        status: () => {
            try {
                return JSON.parse(readFileSync(join(exportDir, 'status.json'), 'utf8')) as ExporterStatus;
            } catch {
                return null;
            }
        },
        listenRelay: async (socket) => {
            const relay: Relay = { authorization: [], hangUp: false };
            const relayServer = createServer((request, reply) => {
                relay.authorization.push(request.headers.authorization);
                if (relay.hangUp) return request.socket.destroy();
                void channel.serve(request, reply, TOKEN).then((handled) => {
                    if (!handled) {
                        reply.statusCode = 404;
                        reply.end();
                    }
                });
            });
            await new Promise<void>((resolve) => relayServer.listen(socket, resolve));
            running.relays.push(relayServer);
            return relay;
        },
        close: () => channel.close(SUPERVISOR),
        stopServer: () => server.close(),
        start: (env = {}) => {
            const child = spawn('node', [pathOf('claude-export.cjs')], {
                env: {
                    ...process.env,
                    CLAUDE_TRANSCRIPT_DIR: dir,
                    FACTORY_EXPORT_DIR: exportDir,
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

    describe('a pod lost with its volume kept: the next claim’s exporter over the same volume', () => {
        const kill = async (child: ChildProcess): Promise<void> => {
            const gone = new Promise((resolve) => child.on('close', resolve));
            child.kill('SIGKILL');
            await gone;
        };

        it('uploads every record the lost one never had acknowledged, from the offset it reached', async () => {
            const h = await harness();
            const file = fileOf(h);
            const lost = h.start({ RUN_STARTED_AT: new Date().toISOString() });
            await new Promise((resolve) => setTimeout(resolve, 50));
            const acked = records(5);
            writeFileSync(file, acked);
            await until('the first records', () => h.stored(SESSION).length === Buffer.byteLength(acked));
            h.board.down = true;
            const unacked = `${records(7, 5)}{"n":12,"cut mid-wri`;
            appendFileSync(file, unacked);
            await until('a backlog on the volume', () => (h.status()?.pendingBytes ?? 0) > 0);
            await kill(lost);
            h.board.down = false;
            await new Promise((resolve) => setTimeout(resolve, 50));
            h.start({ RUN_STARTED_AT: new Date().toISOString() });
            h.drain('complete', null);
            expect(await h.exited()).toBe(0);
            expect(h.stored(SESSION).toString()).toBe(acked + records(7, 5));
            expect(h.chunks.filter((c) => c.session === SESSION)[0]?.offset).toBe(0);
        });

        it('exports a session born under the lost attempt whole, though that exporter never saw it', async () => {
            const h = await harness();
            const lost = h.start({ RUN_STARTED_AT: new Date().toISOString() });
            await until('the lost exporter running', () => h.status() !== null);
            await kill(lost);
            // The agent wrote its session after the exporter's last scan; then the pod was lost.
            const all = records(9);
            writeFileSync(fileOf(h), all);
            await new Promise((resolve) => setTimeout(resolve, 50));
            h.start({ RUN_STARTED_AT: new Date().toISOString() });
            h.drain('complete', null);
            expect(await h.exited()).toBe(0);
            expect(h.stored(SESSION).toString()).toBe(all);
        });

        it.each([
            ['cannot be parsed', '{"ino": 1, "ac'],
            ['is null', 'null'],
            ['has no offsets', '{}'],
        ])('exports a resumed session whole when its saved state %s, never skipping its tail', async (_name, state) => {
            const h = await harness();
            const file = fileOf(h);
            const earlier = records(3);
            writeFileSync(file, earlier);
            await new Promise((resolve) => setTimeout(resolve, 50));
            const lost = h.start({ RUN_STARTED_AT: new Date().toISOString() });
            await new Promise((resolve) => setTimeout(resolve, 300));
            h.board.down = true;
            appendFileSync(file, records(4, 3));
            await until('a backlog on the volume', () => (h.status()?.pendingBytes ?? 0) > 0);
            await kill(lost);
            writeFileSync(join(h.dir, 'export-state', `${SESSION}.json`), state);
            h.board.down = false;
            const before = h.chunks.length;
            h.start({ RUN_STARTED_AT: new Date().toISOString() });
            h.drain('complete', null);
            expect(await h.exited()).toBe(0);
            const resent = h.chunks.slice(before).sort((a, b) => a.offset - b.offset);
            expect(resent[0]?.offset).toBe(0);
            expect(Buffer.concat(resent.map((c) => c.body)).toString()).toBe(earlier + records(4, 3));
        });

        it('exports an unseen session whole when the volume’s floor cannot be read, never skipping it', async () => {
            const h = await harness();
            const all = records(4);
            writeFileSync(fileOf(h), all);
            writeFileSync(join(h.dir, 'export-floor.json'), '{"startedMs": tr');
            await new Promise((resolve) => setTimeout(resolve, 50));
            h.start({ RUN_STARTED_AT: new Date().toISOString() });
            h.drain('complete', null);
            expect(await h.exited()).toBe(0);
            expect(h.stored(SESSION).toString()).toBe(all);
        });
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
        // The next record it tries to upload meets a token the endpoint no longer knows.
        appendFileSync(fileOf(h), records(1, 1));
        expect(await h.exited()).toBe(3);
        expect(h.status()).toMatchObject({ done: true, gone: true });
    });

    it('tells the supervisor its vitals, and `done` once it drained', async () => {
        const h = await harness();
        writeFileSync(fileOf(h), records(3));
        h.start();
        await until('a status', () => h.status() !== null);
        expect(h.status()).toMatchObject({ done: false, gone: false, spoolFull: false });
        h.drain('complete', null);
        expect(await h.exited()).toBe(0);
        expect(h.status()).toMatchObject({ done: true, gone: false, pendingBytes: 0 });
    });

    it('tells the supervisor the spool is full, so it can end the agent itself', async () => {
        const h = await harness();
        h.board.down = true;
        writeFileSync(fileOf(h), records(60));
        h.start({ EXPORT_SPOOL_MAX_BYTES: '2000', EXPORT_FLUSH_BYTES: '500' });
        await until('a full spool in the status file', () => h.status()?.spoolFull === true);
    });

    // The supervisor died: nobody will order the drain. The exporter orders it itself, partial, so
    // what the agent wrote still reaches the board — and says why it is not whole.
    it('drains itself, partial, when the supervisor’s heartbeat stops', async () => {
        const h = await harness();
        writeFileSync(fileOf(h), records(4));
        writeFileSync(join(h.exportDir, 'supervisor.alive'), `${Date.now() - 120_000}\n`);
        h.start({ EXPORT_SUPERVISOR_LOST_MS: '60000' });
        expect(await h.exited()).toBe(0);
        expect(h.stored(SESSION).toString()).toBe(records(4));
        expect(h.manifests[0]).toMatchObject({ state: 'partial', terminalCause: 'supervisor_lost' });
    });

    it('a heartbeat that is fresh is no drain, and none at all is no drain either', async () => {
        const h = await harness();
        writeFileSync(fileOf(h), records(2));
        writeFileSync(join(h.exportDir, 'supervisor.alive'), `${Date.now()}\n`);
        h.start({ EXPORT_SUPERVISOR_LOST_MS: '60000' });
        await until('the records', () => h.stored(SESSION).length === Buffer.byteLength(records(2)));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(h.manifests).toEqual([]);
    });

    it('gives up with its own exit code when the endpoint stays unreachable past the window', async () => {
        const h = await harness();
        writeFileSync(fileOf(h), records(2));
        h.start({ EXPORT_GIVEUP_MS: '400' });
        await until('the first chunk', () => h.chunks.length > 0);
        h.stopServer();
        appendFileSync(fileOf(h), records(2, 2));
        expect(await h.exited()).toBe(4);
        expect(h.status()).toMatchObject({ done: true, gone: true });
    });
    describe('a driver that accepts but never answers, as a vanished pod IP does', () => {
        const held: Socket[] = [];
        let silent: ReturnType<typeof createTcpServer> | null = null;
        afterEach(() => {
            for (const socket of held.splice(0)) socket.destroy();
            silent?.close();
            silent = null;
        });
        const silentUrl = async (): Promise<string> => {
            silent = createTcpServer((socket) => held.push(socket));
            await new Promise<void>((resolve) => silent!.listen(0, '127.0.0.1', resolve));
            return `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
        };
        const unreachable = async (): Promise<Record<string, string>> => ({
            BELLOWS_CONTROL_URL: await silentUrl(),
            EXPORT_REQUEST_TIMEOUT_MS: '200',
            EXPORT_DRAIN_GIVEUP_MS: '500',
        });

        it('finishes a drain within its bound, leaving every byte on the volume for the next claim', async () => {
            const h = await harness();
            const all = records(4);
            writeFileSync(fileOf(h), all);
            h.start(await unreachable());
            h.drain('complete', null);
            const began = Date.now();
            expect(await h.exited()).toBe(0);
            expect(Date.now() - began).toBeLessThan(5_000);
            expect(h.status()).toMatchObject({ done: true, gone: true });
            expect(h.manifests).toEqual([]);
            expect(readFileSync(fileOf(h), 'utf8')).toBe(all);
        });

        it('finishes a drain with no transcript at all, its last report bounded by the request timeout', async () => {
            const h = await harness();
            h.start(await unreachable());
            h.drain('complete', null);
            const began = Date.now();
            expect(await h.exited()).toBe(0);
            expect(Date.now() - began).toBeLessThan(5_000);
            expect(h.status()).toMatchObject({ done: true, pendingBytes: 0 });
        });
    });

    it('gives a large chunk time in proportion to its size, so a slow board still stores it', async () => {
        const h = await harness();
        h.board.delayMs = 600;
        const big = `${JSON.stringify({ pad: 'x'.repeat(1024 * 1024) })}\n`;
        writeFileSync(fileOf(h), big);
        h.start({ EXPORT_REQUEST_TIMEOUT_MS: '200', EXPORT_DRAIN_GIVEUP_MS: '200' });
        h.drain('complete', null);
        expect(await h.exited()).toBe(0);
        expect(h.stored(SESSION).toString()).toBe(big);
        expect(h.manifests[0]).toMatchObject({ state: 'complete' });
    });

    it('never abandons a drain while the driver answers, even with the board behind it down', async () => {
        const h = await harness();
        h.board.down = true;
        const all = records(4);
        writeFileSync(fileOf(h), all);
        h.start({ EXPORT_DRAIN_GIVEUP_MS: '200' });
        h.drain('complete', null);
        await new Promise((resolve) => setTimeout(resolve, 800));
        h.board.down = false;
        expect(await h.exited()).toBe(0);
        expect(h.stored(SESSION).toString()).toBe(all);
        expect(h.manifests[0]).toMatchObject({ state: 'complete' });
    });

    // Issue #774 (B5): a review's close-time export is this same script run once, with no mailbox
    // and no drain order — the closing is the step's own env.
    it('in one-shot mode uploads what is there, closes the manifest as ordered, and exits', async () => {
        const h = await harness();
        writeFileSync(fileOf(h), `${records(3)}{"n":3,"cut`);
        h.start({ FACTORY_EXPORT_DIR: '', EXPORT_ONCE: 'partial', EXPORT_ONCE_CAUSE: 'review_failed' });
        expect(await h.exited()).toBe(0);
        expect(h.stored(SESSION).toString()).toBe(records(3));
        expect(h.manifests).toHaveLength(1);
        expect(h.manifests[0]).toMatchObject({ state: 'partial', terminalCause: 'review_failed' });
    });

    it('in one-shot mode closes a finished review complete', async () => {
        const h = await harness();
        writeFileSync(fileOf(h), records(2));
        h.start({ FACTORY_EXPORT_DIR: '', EXPORT_ONCE: 'complete' });
        expect(await h.exited()).toBe(0);
        expect(h.stored(SESSION).toString()).toBe(records(2));
        expect(h.manifests[0]).toMatchObject({ state: 'complete', terminalCause: null });
    });

    // #829 S3c: the exporter holds no credential. It talks to the supervisor's relay socket, which
    // attaches the token and follows whichever driver holds the run.
    describe('over the supervisor’s relay socket', () => {
        const NO_URL = { BELLOWS_CONTROL_URL: '', BELLOWS_CONTROL_TOKEN: '' };
        const socketIn = (h: Harness) => join(h.exportDir, 'control.sock');

        it('uploads, closes and exits through the socket with no authorization of its own', async () => {
            const h = await harness();
            const relay = await h.listenRelay(socketIn(h));
            const all = records(30);
            writeFileSync(fileOf(h), all);
            h.start({ ...NO_URL, EXPORT_CONTROL_SOCKET: socketIn(h), EXPORT_FLUSH_BYTES: '1000' });
            await until('the chunks', () => h.stored(SESSION).length === Buffer.byteLength(all));
            h.drain('complete', null);
            expect(await h.exited()).toBe(0);
            expect(h.stored(SESSION).toString()).toBe(all);
            expect(h.manifests[0]).toMatchObject({ state: 'complete' });
            expect(relay.authorization.length).toBeGreaterThan(0);
            expect(relay.authorization.every((value) => value === undefined)).toBe(true);
        });

        it('reads a relay that hangs up as an unreachable driver: the drain ends at its bound, bytes left on the volume', async () => {
            const h = await harness();
            const relay = await h.listenRelay(socketIn(h));
            relay.hangUp = true;
            const all = records(4);
            writeFileSync(fileOf(h), all);
            h.start({ ...NO_URL, EXPORT_CONTROL_SOCKET: socketIn(h), EXPORT_DRAIN_GIVEUP_MS: '500' });
            h.drain('complete', null);
            const began = Date.now();
            expect(await h.exited()).toBe(0);
            expect(Date.now() - began).toBeLessThan(5_000);
            expect(h.status()).toMatchObject({ done: true, gone: true });
            expect(h.manifests).toEqual([]);
            expect(readFileSync(fileOf(h), 'utf8')).toBe(all);
        });

        it('retries a socket that is not there yet instead of failing', async () => {
            const h = await harness();
            const all = records(3);
            writeFileSync(fileOf(h), all);
            h.start({ ...NO_URL, EXPORT_CONTROL_SOCKET: socketIn(h) });
            await new Promise((resolve) => setTimeout(resolve, 400));
            expect(running.child?.exitCode).toBeNull();
            await h.listenRelay(socketIn(h));
            await until('the chunks', () => h.stored(SESSION).length === Buffer.byteLength(all));
            h.drain('complete', null);
            expect(await h.exited()).toBe(0);
        });

        it('refuses to start with neither a socket nor an endpoint and token', async () => {
            const h = await harness();
            h.start({ ...NO_URL });
            expect(await h.exited()).toBe(1);
        });
    });
});
