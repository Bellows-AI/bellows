import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { attachCheckpoint, createCheckpointRelay } from '../src/loop/loop-export.js';
import type { LoopRuntime } from '../src/loop/loop-types.js';

/**
 * The loop's half of the checkpoint (issue #775): the supervisor's chunks and closing record reach
 * the board's `checkpoint` stream under the attempt's own claim sequence — the loop's, never one the
 * supervisor names — for every executor, not only the ones that stream a transcript.
 */
const job = {
    id: '55555555-5555-4555-8555-555555555555',
    leaseToken: '66666666-6666-4666-8666-666666666666',
    claimSeq: 7,
    executorType: 'opencode',
} as unknown as BoardJob;

const MANIFEST = {
    state: 'truncated' as const,
    terminalCause: 'checkpoint_cap',
    startedAt: '2026-10-21T10:00:00.000Z',
    finishedAt: '2026-10-21T10:00:05.000Z',
};

describe('the checkpoint relay', () => {
    const setup = () => {
        const board = {
            putArtifactChunk: vi.fn(async () => ({ result: 'stored' as const })),
            finalizeArtifact: vi.fn(async () => 'stored' as const),
        };
        const rt = { board, log: vi.fn() } as unknown as LoopRuntime;
        return { board, relay: createCheckpointRelay(rt, job) };
    };

    it('puts a chunk on the checkpoint stream of the job’s executor, bytes untouched', async () => {
        const { board, relay } = setup();
        const bytes = Uint8Array.from([0, 255, 10, 13]);

        await expect(relay.putChunk(1024, bytes)).resolves.toEqual({ result: 'stored' });

        expect(board.putArtifactChunk).toHaveBeenCalledWith(
            job,
            { executor: 'opencode', session: 'none', stream: 'checkpoint' },
            1024,
            bytes
        );
    });

    it('closes the stream with the supervisor’s state and cause, produced by the supervisor', async () => {
        const { board, relay } = setup();

        await expect(relay.finalize(MANIFEST)).resolves.toBe('stored');

        expect(board.finalizeArtifact).toHaveBeenCalledWith(
            job,
            { executor: 'opencode', session: 'none', stream: 'checkpoint' },
            { producer: 'supervisor', schemaVersion: 1, ...MANIFEST }
        );
    });
});

describe('attaching the checkpoint to a control token', () => {
    it.each(['claude-code', 'opencode'])('attaches for %s, which exports its transcript or not', (executorType) => {
        const attach = vi.fn();
        const rt = { gates: { server: { attachCheckpoint: attach } }, board: {}, log: vi.fn() } as never;

        attachCheckpoint({ rt, job: { ...job, executorType } as BoardJob }, 'token');

        expect(attach).toHaveBeenCalledWith('token', expect.objectContaining({ putChunk: expect.any(Function) }));
    });

    it('attaches nothing where the run has no control endpoint', () => {
        expect(() => attachCheckpoint({ rt: { board: {} } as never, job }, 'token')).not.toThrow();
    });
});
