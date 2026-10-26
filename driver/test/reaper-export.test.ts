import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createBoard, type BoardLease, type BoardThreadFacts } from '../src/board/board.js';
import { createGateServer, type GateServer } from '../src/gates.js';
import { createVolumeExportOpener, VOLUME_EXPORT_CAUSE } from '../src/loop/loop-export.js';
import { createReaper, type ReaperArm, type VolumeThread } from '../src/reaper.js';

/**
 * Issue #938, end to end below the container: the real reaper, the real gate server, the real
 * `claude-export.cjs` as a child process over a temp directory standing in for the task volume, and a
 * fake board endpoint behind the real board client. Only the outermost boundary is faked.
 */

const SCRIPT = fileURLToPath(new URL('../src/scripts/claude-export.cjs', import.meta.url));
const HOUR = 3_600_000;
const FINALIZED = 1_000 * HOUR;
const POLICY = { ttlMs: 24 * HOUR, boundMs: 7 * 24 * HOUR };
const SESSION = 'ses-1';
const CLAIM_SEQ = 3;

interface Stored {
    job: string;
    claimSeq: number;
    session: string;
    offset: number;
    bytes: Buffer;
}

/** The board's artifact routes: `ok` stores, `conflict` answers 409, `hang` never answers. */
const startBoard = async (): Promise<{
    url: string;
    chunks: Stored[];
    manifests: unknown[];
    mode: { chunk: 'ok' | 'conflict' | 'hang' };
    close: () => Promise<void>;
}> => {
    const chunks: Stored[] = [];
    const manifests: unknown[] = [];
    const mode = { chunk: 'ok' as 'ok' | 'conflict' | 'hang' };
    const sockets = new Set<import('node:net').Socket>();
    const server: Server = createServer((request, reply) => {
        const url = new URL(request.url ?? '/', 'http://board');
        const body: Buffer[] = [];
        request.on('data', (piece: Buffer) => body.push(piece));
        request.on('end', () => {
            const answer = (status: number, json: unknown) => {
                reply.writeHead(status, { 'content-type': 'application/json' });
                reply.end(JSON.stringify(json));
            };
            const [, , , job, , kind] = url.pathname.split('/');
            if (request.method !== 'PUT' || !job) return answer(404, {});
            if (kind === 'manifest') {
                manifests.push(JSON.parse(Buffer.concat(body).toString('utf8')));
                return answer(200, { result: 'stored' });
            }
            if (mode.chunk === 'hang') return;
            if (mode.chunk === 'conflict') return answer(409, { code: 'ARTIFACT_CONFLICT' });
            chunks.push({
                job,
                claimSeq: Number(url.searchParams.get('claimSeq')),
                session: url.searchParams.get('session') ?? '',
                offset: Number(url.searchParams.get('offset')),
                bytes: Buffer.concat(body),
            });
            answer(200, { result: 'stored' });
        });
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        chunks,
        manifests,
        mode,
        close: () => {
            for (const socket of sockets) socket.destroy();
            return new Promise((resolve) => server.close(() => resolve()));
        },
    };
};

const record = (n: number): string => `${JSON.stringify({ n, text: 'x'.repeat(40) })}\n`;
const records = (from: number, count: number): string =>
    Array.from({ length: count }, (_, i) => record(from + i)).join('');

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
});

/**
 * A thread whose exporter died with `acked` of its session file acknowledged: the board holds those
 * bytes, the volume holds the rest — complete records, then a record cut mid-write.
 */
async function scene(options: { deadlineMs?: number } = {}) {
    const root = randomUUID();
    const jobId = randomUUID();
    const volume = mkdtempSync(join(tmpdir(), 'reaper-export-'));
    cleanup.push(() => rmSync(volume, { recursive: true, force: true }));
    const projects = join(volume, 'projects', '-work-tree');
    mkdirSync(projects, { recursive: true });
    const file = join(projects, `${SESSION}.jsonl`);
    const acked = records(0, 2);
    const unacked = records(2, 5);
    const trailing = '{"n":7,"cut mid-wri';
    writeFileSync(file, acked + unacked + trailing);
    mkdirSync(join(volume, 'export-state'));
    writeFileSync(
        join(volume, 'export-state', `${SESSION}.json`),
        JSON.stringify({ ino: statSync(file).ino, base: 0, acked: Buffer.byteLength(acked), stopCause: null })
    );

    const board = await startBoard();
    cleanup.push(board.close);
    board.chunks.push({
        job: jobId,
        claimSeq: CLAIM_SEQ,
        session: SESSION,
        offset: 0,
        bytes: Buffer.from(acked),
    });
    const server: GateServer = createGateServer({ host: '127.0.0.1', manager: {} as never });
    cleanup.push(() => server.close());
    const opener = createVolumeExportOpener({
        board: createBoard({ url: board.url, leaseSeconds: 300, token: undefined }),
        gates: { manager: {} as never, server, advertiseUrl: (port) => `http://127.0.0.1:${port}` },
        log: () => undefined,
    });

    const events: string[] = [];
    const logs: string[] = [];
    const outcomes: string[] = [];
    const heldAtReap: Stored[][] = [];
    let aborted = false;
    const facts: BoardThreadFacts = {
        live: false,
        lastFinalizedAt: new Date(FINALIZED).toISOString(),
        artifactsComplete: false,
        checkpoint: 'complete',
        checkpointFinalizedAt: new Date(FINALIZED).toISOString(),
        lastJobId: jobId,
        lastClaimSeq: CLAIM_SEQ,
    };
    // The arm commit 2 builds in docker and kubernetes, with the volume a host directory and the
    // container a host process: the channel, the exporter over it, the proof, one close.
    const arm: ReaperArm = {
        scan: async () => [],
        reap: async () => [],
        scanVolumes: async () => ({ threads: [{ root, volumes: [{ name: 'vol' }] }], skipped: [] }),
        reapVolumes: async (thread: VolumeThread) => {
            events.push('reap');
            heldAtReap.push([...board.chunks]);
            return thread.volumes.map((v) => v.name);
        },
        exportVolume: async (_thread, attempt, signal) => {
            events.push('export');
            const channel = await opener(attempt);
            if (!channel) return { result: 'never_started', why: 'no control endpoint' };
            try {
                const child = spawn(process.execPath, [SCRIPT], {
                    env: {
                        PATH: process.env.PATH ?? '',
                        CLAUDE_TRANSCRIPT_DIR: volume,
                        BELLOWS_CONTROL_URL: channel.url,
                        BELLOWS_CONTROL_TOKEN: channel.token,
                        EXPORT_ONCE: 'partial',
                        EXPORT_ONCE_CAUSE: VOLUME_EXPORT_CAUSE,
                        EXPORT_GIVEUP_MS: '2000',
                        EXPORT_DRAIN_GIVEUP_MS: '2000',
                        EXPORT_POLL_MS: '50',
                    },
                    stdio: 'ignore',
                });
                const ended = new Promise<number | null>((resolve) => child.on('close', resolve));
                const stop = () => child.kill('SIGKILL');
                const timer = setTimeout(stop, options.deadlineMs ?? 15_000);
                signal.addEventListener('abort', () => {
                    aborted = true;
                    stop();
                });
                const code = await ended;
                clearTimeout(timer);
                const proof = channel.proof();
                if (code !== 0) return { result: 'inconclusive', why: `the exporter exited ${code}` };
                return proof.drained ? { result: 'drained' } : { result: 'inconclusive', why: proof.why };
            } finally {
                channel.close();
            }
        },
    };
    const reaper = createReaper({
        board: {
            leases: async (ids) =>
                ids.map((id) => ({ id, status: 'succeeded', leaseToken: null, thread: facts }) as BoardLease),
        },
        arm,
        intervalMs: 3_600_000,
        graceMs: 0,
        volumePolicy: POLICY,
        exportAttempts: 3,
        now: () => FINALIZED + 8 * 24 * HOUR,
        log: (m) => logs.push(m),
        observe: { sweep: (outcome) => void outcomes.push(outcome), scanned: () => undefined },
    });
    const uploaded = () =>
        Buffer.concat(
            board.chunks
                .filter((c) => c.session === SESSION)
                .sort((a, b) => a.offset - b.offset)
                .map((c) => c.bytes)
        ).toString('utf8');
    return {
        reaper,
        board,
        events,
        logs,
        outcomes,
        heldAtReap,
        jobId,
        acked,
        unacked,
        trailing,
        uploaded,
        isAborted: () => aborted,
    };
}

describe('the reaper re-exports a killed exporter’s unacknowledged records before deleting the volume (issue #938)', () => {
    it('uploads every complete record past the acknowledged offset, under the newest attempt, then deletes', async () => {
        const s = await scene();
        await s.reaper.sweep();
        expect(s.events).toEqual(['export', 'reap']);
        // Everything the dead exporter never had acknowledged is on the board before the delete ...
        expect(s.uploaded()).toBe(s.acked + s.unacked);
        expect(s.heldAtReap[0]!.length).toBeGreaterThan(1);
        expect(Buffer.concat(s.heldAtReap[0]!.sort((a, b) => a.offset - b.offset).map((c) => c.bytes)).toString()).toBe(
            s.acked + s.unacked
        );
        // ... under the attempt the board named, and the trailing half record was not uploaded.
        const fresh = s.board.chunks.slice(1);
        expect(fresh.every((c) => c.job === s.jobId && c.claimSeq === CLAIM_SEQ)).toBe(true);
        expect(fresh[0]!.offset).toBe(Buffer.byteLength(s.acked));
        expect(s.uploaded()).not.toContain('cut mid-wri');
        expect(s.board.manifests).toEqual([
            expect.objectContaining({ session: SESSION, state: 'partial', terminalCause: 'reaper_export' }),
        ]);
        expect(s.outcomes).toEqual(['ok']);
    });

    it('keeps the volume when the board refuses a chunk for good (409), and says why', async () => {
        const s = await scene();
        s.board.mode.chunk = 'conflict';
        await s.reaper.sweep();
        expect(s.events).toEqual(['export']);
        expect(s.outcomes).toEqual(['aborted']);
        expect(s.logs.join('\n')).toContain('refused');
        expect(s.uploaded()).toBe(s.acked);
    });

    it('keeps the volume when the board never answers, within the deadline', async () => {
        const s = await scene({ deadlineMs: 1_500 });
        s.board.mode.chunk = 'hang';
        const started = Date.now();
        await s.reaper.sweep();
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(s.events).toEqual(['export']);
        expect(s.outcomes).toEqual(['aborted']);
    });

    it('kills the export and keeps the volume when the reaper is stopped mid-export', async () => {
        const s = await scene();
        s.board.mode.chunk = 'hang';
        const sweeping = s.reaper.sweep();
        await new Promise((resolve) => setTimeout(resolve, 700));
        s.reaper.stop();
        await sweeping;
        expect(s.isAborted()).toBe(true);
        expect(s.events).toEqual(['export']);
    });

    it('retries on a later round: a board that hung the first export is drained by the second', async () => {
        const s = await scene({ deadlineMs: 1_500 });
        s.board.mode.chunk = 'hang';
        await s.reaper.sweep();
        expect(s.events).toEqual(['export']);
        s.board.mode.chunk = 'ok';
        await s.reaper.sweep();
        expect(s.events).toEqual(['export', 'export', 'reap']);
        expect(s.uploaded()).toBe(s.acked + s.unacked);
    });

    it('never calls a stream drained that an earlier refusal left stopped: its bytes are still only on the volume', async () => {
        const s = await scene();
        s.board.mode.chunk = 'conflict';
        await s.reaper.sweep();
        s.board.mode.chunk = 'ok';
        // The dead exporter's saved state says the stream stopped; the new exporter closes it as such.
        await s.reaper.sweep();
        expect(s.events).toEqual(['export', 'export']);
        expect(s.logs.join('\n')).toContain('upload_rejected');
        expect(s.uploaded()).toBe(s.acked);
    });
});
