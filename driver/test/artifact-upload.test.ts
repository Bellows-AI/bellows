import { describe, expect, it } from 'vitest';
import {
    cutChunks,
    uploadRunArtifacts,
    uploadStream,
    UPLOAD_CAUSE,
    type StreamSource,
    type UploadTarget,
} from '../src/artifact-upload.js';
import { BOARD_CALL_ATTEMPTS } from '../src/board/board-retry.js';
import { createBoard, type ArtifactManifest, type Board, type BoardJob, type ChunkAnswer } from '../src/board/board.js';

const job = { id: '11111111-1111-4111-8111-111111111111', claimSeq: 4, leaseToken: 'lease-secret' } as BoardJob;
const REF = { executor: 'claude-code', session: 'sess-1', stream: 'log' };
const KIB = 1024;

/** Uploads `source` as the `log` stream of the test job. */
const uploadLog = (
    board: UploadTarget['board'],
    source: Omit<StreamSource, 'stream'>,
    io: Parameters<typeof uploadStream>[2]
) => uploadStream({ board, job, ref: REF }, { stream: 'log', ...source }, io);

const io = () => {
    const logs: string[] = [];
    return { logs, log: (m: string) => logs.push(m), sleep: async () => {} };
};

/** A board whose stored chunks are keyed by offset, answering `duplicate` for a repeat like the real one. */
function memoryBoard(over: Partial<Pick<Board, 'putArtifactChunk' | 'finalizeArtifact'>> = {}) {
    const chunks = new Map<number, string>();
    const manifests: ArtifactManifest[] = [];
    const board: Pick<Board, 'putArtifactChunk' | 'finalizeArtifact'> = {
        async putArtifactChunk(_job, _ref, offset, bytes) {
            const text = Buffer.from(bytes).toString('utf8');
            const held = chunks.get(offset);
            chunks.set(offset, text);
            return { result: held === undefined ? 'stored' : held === text ? 'duplicate' : 'conflict' };
        },
        async finalizeArtifact(_job, _ref, manifest) {
            manifests.push(manifest);
            return 'stored';
        },
        ...over,
    };
    return { board, chunks, manifests };
}

describe('cutChunks', () => {
    const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

    it('cuts at the last record boundary inside the window and numbers chunks by byte offset', () => {
        const chunks = cutChunks(Buffer.from('aaaa\nbbbb\ncccc\n'), 10);

        expect(chunks.map((c) => [c.offset, text(c.body)])).toEqual([
            [0, 'aaaa\nbbbb\n'],
            [10, 'cccc\n'],
        ]);
    });

    it('keeps a record larger than the window whole, as its own chunk', () => {
        const long = 'x'.repeat(20);
        const chunks = cutChunks(Buffer.from(`ab\n${long}\ncd\n`), 8);

        expect(chunks.map((c) => text(c.body))).toEqual(['ab\n', `${long}\n`, 'cd\n']);
    });

    it('covers every byte exactly once', () => {
        const source = Buffer.from(Array.from({ length: 300 }, (_, i) => `record ${i}`).join('\n'));
        const chunks = cutChunks(source, 64);

        expect(Buffer.concat(chunks.map((c) => c.body)).equals(source)).toBe(true);
        expect(chunks.map((c) => c.offset)).toEqual(
            chunks.map((_, i) => chunks.slice(0, i).reduce((sum, c) => sum + c.body.length, 0))
        );
    });

    it('answers no chunks for no bytes', () => {
        expect(cutChunks(new Uint8Array())).toEqual([]);
    });
});

describe('uploadStream', () => {
    it('uploads the chunks and closes the stream complete', async () => {
        const { board, chunks, manifests } = memoryBoard();
        const text = `${'a'.repeat(300 * KIB)}\n${'b'.repeat(10)}\n`;

        const complete = await uploadLog(board, { text, truncated: false }, io());

        expect(complete).toBe(true);
        expect([...chunks.keys()]).toEqual([0, 300 * KIB + 1]);
        expect(manifests).toEqual([expect.objectContaining({ state: 'complete', terminalCause: null })]);
    });

    it('stores a chunk once when the response was lost and the driver retries it', async () => {
        const memory = memoryBoard();
        let lost = 1;
        const board = {
            ...memory.board,
            async putArtifactChunk(...args: Parameters<Board['putArtifactChunk']>): Promise<ChunkAnswer> {
                const answer = await memory.board.putArtifactChunk(...args);
                // The board stored it, and the answer never came back.
                if (lost-- > 0) throw new Error('connection reset');
                return answer;
            },
        };
        const log = io();

        const complete = await uploadLog(board, { text: 'hello\n', truncated: false }, log);

        expect(complete).toBe(true);
        expect([...memory.chunks.entries()]).toEqual([[0, 'hello\n']]);
        expect(log.logs.some((m) => m.includes('retrying'))).toBe(true);
    });

    it('retries a lost manifest response with the same manifest', async () => {
        const memory = memoryBoard();
        let lost = 1;
        const sent: ArtifactManifest[] = [];
        const board = {
            ...memory.board,
            async finalizeArtifact(_job: BoardJob, _ref: unknown, manifest: ArtifactManifest) {
                sent.push(manifest);
                if (lost-- > 0) throw new Error('connection reset');
                return 'duplicate' as const;
            },
        };
        let tick = 0;
        const clock = { ...io(), now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) };

        const complete = await uploadLog(board, { text: 'x\n', truncated: false }, clock);

        expect(complete).toBe(true);
        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual(sent[0]);
    });

    it('gives up after the bounded retries and records a partial stream, never throwing', async () => {
        const attempts: number[] = [];
        const memory = memoryBoard({
            async putArtifactChunk(_job, _ref, offset) {
                attempts.push(offset);
                throw new Error('board unreachable');
            },
        });

        const complete = await uploadLog(
            memory.board,
            { text: `${'a'.repeat(300 * KIB)}\nb\n`, truncated: false },
            io()
        );

        expect(complete).toBe(false);
        // Bounded: one chunk's retries, then the stream stops instead of hammering every chunk.
        expect(attempts).toHaveLength(BOARD_CALL_ATTEMPTS);
        expect(memory.manifests).toEqual([
            expect.objectContaining({ state: 'partial', terminalCause: UPLOAD_CAUSE.uploadFailed }),
        ]);
    });

    it('answers false without throwing when the manifest cannot be stored either', async () => {
        const memory = memoryBoard({
            async putArtifactChunk() {
                throw new Error('down');
            },
            async finalizeArtifact() {
                throw new Error('down');
            },
        });

        await expect(uploadLog(memory.board, { text: 'x\n', truncated: false }, io())).resolves.toBe(false);
    });

    it('records the board’s refusal as a truncated stream with its cause', async () => {
        const memory = memoryBoard({ putArtifactChunk: async () => ({ result: 'refused', cause: 'stream_cap' }) });

        const complete = await uploadLog(memory.board, { text: 'x\n', truncated: false }, io());

        expect(complete).toBe(false);
        expect(memory.manifests).toEqual([
            expect.objectContaining({ state: 'truncated', terminalCause: 'stream_cap' }),
        ]);
    });

    it('does not call a tail-kept stream complete', async () => {
        const memory = memoryBoard();

        const complete = await uploadLog(memory.board, { text: 'x\n', truncated: true }, io());

        expect(complete).toBe(false);
        expect(memory.manifests).toEqual([
            expect.objectContaining({ state: 'truncated', terminalCause: UPLOAD_CAUSE.headDropped }),
        ]);
    });
});

describe('uploadRunArtifacts', () => {
    const outcome = { exitCode: 0, output: '', timedOut: false, started: true };

    it('uploads the log and the transcript as two streams under the run’s session', async () => {
        const seen: string[] = [];
        const memory = memoryBoard({
            async putArtifactChunk(_job, ref) {
                seen.push(`${ref.executor}/${ref.session}/${ref.stream}`);
                return { result: 'stored' };
            },
        });

        await uploadRunArtifacts(
            {
                board: memory.board,
                job,
                executorType: 'claude-code',
                outcome: { ...outcome, fullLog: 'log\n', transcript: 't\n', sessionId: 'sess-9' },
            },
            io()
        );

        expect(seen).toEqual(['claude-code/sess-9/log', 'claude-code/sess-9/transcript']);
    });

    // Issue #825: a cut runner log and a whole streamed transcript never share a completeness.
    it('keeps a truncated log and a complete transcript in manifests of their own', async () => {
        // Two streams, each from offset 0: the board stores each chunk under its own stream.
        const memory = memoryBoard({ putArtifactChunk: async () => ({ result: 'stored' }) });

        await uploadRunArtifacts(
            {
                board: memory.board,
                job,
                executorType: 'claude-code',
                outcome: { ...outcome, fullLog: 'log\n', logTruncated: true, transcript: 't\n', sessionId: 'sess-9' },
            },
            io()
        );

        expect(memory.manifests).toEqual([
            expect.objectContaining({ state: 'truncated', terminalCause: UPLOAD_CAUSE.headDropped }),
            expect.objectContaining({ state: 'complete' }),
        ]);
    });

    it('uploads nothing for a run that captured nothing', async () => {
        const memory = memoryBoard();

        await uploadRunArtifacts({ board: memory.board, job, executorType: 'claude-code', outcome }, io());

        expect(memory.chunks.size).toBe(0);
        expect(memory.manifests).toEqual([]);
    });
});

describe('the board’s artifact calls', () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answering = (status: number, body: unknown) =>
        createBoard({
            url: 'http://board.test',
            leaseSeconds: 60,
            token: 'worker-secret',
            fetch: (async (url: string, init: RequestInit) => {
                calls.push({ url, init });
                return new Response(JSON.stringify(body), { status });
            }) as typeof fetch,
        });

    it('puts the raw bytes with the claim sequence and the worker secret, and no lease token', async () => {
        calls.length = 0;
        const board = answering(200, { result: 'stored', offset: 12 });

        const answer = await board.putArtifactChunk(job, REF, 12, Buffer.from('hello'));

        expect(answer).toEqual({ result: 'stored' });
        const { url, init } = calls[0]!;
        expect(init.method).toBe('PUT');
        expect(url).toBe(
            'http://board.test/api/jobs/11111111-1111-4111-8111-111111111111/artifact/chunk' +
                '?claimSeq=4&executor=claude-code&session=sess-1&stream=log&offset=12'
        );
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer worker-secret');
        expect(url).not.toContain('lease');
        expect(JSON.stringify(init.headers)).not.toContain('lease-secret');
    });

    it('reads the answers the board gives on purpose', async () => {
        expect(await answering(200, { result: 'duplicate' }).putArtifactChunk(job, REF, 0, Buffer.from('x'))).toEqual({
            result: 'duplicate',
        });
        expect(
            await answering(409, { code: 'ARTIFACT_CONFLICT' }).putArtifactChunk(job, REF, 0, Buffer.from('x'))
        ).toEqual({ result: 'conflict' });
        expect(
            await answering(413, { code: 'ARTIFACT_REFUSED', cause: 'org_quota' }).putArtifactChunk(
                job,
                REF,
                0,
                Buffer.from('x')
            )
        ).toEqual({ result: 'refused', cause: 'org_quota' });
        expect(await answering(400, { code: 'BAD_CLAIM_SEQ' }).putArtifactChunk(job, REF, 0, Buffer.from('x'))).toEqual(
            {
                result: 'rejected',
            }
        );
    });

    it('throws on a 5xx so the caller retries', async () => {
        await expect(
            answering(503, { code: 'UNAVAILABLE' }).putArtifactChunk(job, REF, 0, Buffer.from('x'))
        ).rejects.toThrow(/503/);
    });

    it('finalizes with the claim sequence in the body', async () => {
        calls.length = 0;
        const manifest: ArtifactManifest = {
            producer: 'driver',
            schemaVersion: 1,
            startedAt: '2026-01-01T00:00:00.000Z',
            finishedAt: '2026-01-01T00:00:01.000Z',
            state: 'complete',
            terminalCause: null,
        };

        const answer = await answering(200, { result: 'stored' }).finalizeArtifact(job, REF, manifest);

        expect(answer).toBe('stored');
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ claimSeq: 4, ...REF, ...manifest });
    });
});
