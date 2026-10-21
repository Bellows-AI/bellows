import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { CheckpointChunkCorrupt, checkpointCalls } from '../src/board-checkpoint.js';
import { syncFailureHalt } from '../src/loop-fence.js';

const job = { id: '22222222-2222-4222-8222-222222222222', leaseToken: 'lease-1' } as BoardJob;
const SHA = 'e'.repeat(64);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const calls = (response: Response | (() => Response)) => {
    const posted: { path: string; body: unknown; allow404: boolean | undefined }[] = [];
    const api = checkpointCalls(async (path, body, allow404) => {
        posted.push({ path, body, allow404 });
        return typeof response === 'function' ? response() : response;
    });
    return { api, posted };
};
const POINTER = { bytes: 3, truncated: false, chunks: [{ offset: 0, length: 3, sha256: SHA }] };

describe('the board checkpoint read', () => {
    it('posts the lease and returns a found pointer', async () => {
        const { api, posted } = calls(json({ state: 'found', checkpoint: POINTER }));
        expect(await api.checkpoint(job)).toEqual({ state: 'found', checkpoint: POINTER });
        expect(posted).toEqual([
            { path: `/api/jobs/${job.id}/checkpoint`, body: { leaseToken: 'lease-1' }, allow404: true },
        ]);
    });

    it.each(['none', 'gone'] as const)('returns the %s state', async (state) => {
        expect(await calls(json({ state })).api.checkpoint(job)).toEqual({ state });
    });

    it.each([409, 404])('throws on a %i: this attempt has nothing to restore into', async (status) => {
        await expect(calls(json({}, status)).api.checkpoint(job)).rejects.toMatchObject({ status });
    });

    it.each([
        ['an unknown state', { state: 'maybe' }],
        [
            'a pointer with a bad chunk sha',
            { state: 'found', checkpoint: { ...POINTER, chunks: [{ offset: 0, length: 3, sha256: 'x' }] } },
        ],
        ['a pointer with a negative size', { state: 'found', checkpoint: { ...POINTER, bytes: -1 } }],
        ['a pointer with no chunk list', { state: 'found', checkpoint: { bytes: 1, truncated: false } }],
    ])('throws on %s: an unreadable answer is never a verdict', async (_what, body) => {
        await expect(calls(json(body)).api.checkpoint(job)).rejects.toThrow(/unreadable/);
    });
});

describe('the board checkpoint chunk read', () => {
    const bytes = new TextEncoder().encode('abc');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const chunk =
        (headers: Record<string, string>, status = 200) =>
        () =>
            new Response(bytes, { status, headers });

    it('returns the bytes with their digest after checking it', async () => {
        const { api, posted } = calls(chunk({ 'x-chunk-sha256': sha }));
        const read = await api.checkpointChunk(job, 7);
        expect(read && [...read.bytes]).toEqual([...bytes]);
        expect(read?.sha256).toBe(sha);
        expect(posted[0]).toMatchObject({
            path: `/api/jobs/${job.id}/checkpoint/chunk`,
            body: { leaseToken: 'lease-1', offset: 7 },
        });
    });

    it('answers null for a chunk the board no longer has', async () => {
        expect(await calls(chunk({}, 404)).api.checkpointChunk(job, 0)).toBeNull();
    });

    it('throws on a 409', async () => {
        await expect(calls(chunk({}, 409)).api.checkpointChunk(job, 0)).rejects.toMatchObject({ status: 409 });
    });

    const corruptBody = () => new Response(JSON.stringify({ error: 'x', code: 'ARTIFACT_CORRUPT' }), { status: 422 });

    it('throws CheckpointChunkCorrupt when the board reports its stored chunk corrupt (422 ARTIFACT_CORRUPT)', async () => {
        await expect(calls(corruptBody).api.checkpointChunk(job, 0)).rejects.toBeInstanceOf(CheckpointChunkCorrupt);
        await expect(
            calls(corruptBody).api.transcriptChunk(job, { jobId: job.id, claimSeq: 2, session: 'alpha' }, 0)
        ).rejects.toBeInstanceOf(CheckpointChunkCorrupt);
    });

    it('treats any other 422 as an ordinary board error, not a corrupt chunk', async () => {
        const other = () => new Response(JSON.stringify({ error: 'x', code: 'VALIDATION_ERROR' }), { status: 422 });
        const error = await calls(other)
            .api.checkpointChunk(job, 0)
            .catch((e: unknown) => e);
        expect(error).not.toBeInstanceOf(CheckpointChunkCorrupt);
        expect(error).toMatchObject({ status: 422 });
        await expect(calls(chunk({}, 422)).api.checkpointChunk(job, 0)).rejects.not.toBeInstanceOf(
            CheckpointChunkCorrupt
        );
    });

    it('throws on a missing or mismatched digest', async () => {
        await expect(calls(chunk({})).api.checkpointChunk(job, 0)).rejects.toThrow(/without its sha256/);
        await expect(calls(chunk({ 'x-chunk-sha256': SHA })).api.checkpointChunk(job, 0)).rejects.toThrow(
            /does not match/
        );
    });
});

describe('the board transcript reads', () => {
    const STREAM = {
        jobId: job.id,
        claimSeq: 2,
        executor: 'claude-code',
        session: 'alpha',
        bytes: 3,
        chunks: [{ offset: 0, length: 3, sha256: SHA }],
    };

    it('lists the thread streams under the lease', async () => {
        const { api, posted } = calls(json({ streams: [STREAM] }));
        expect(await api.transcripts(job)).toEqual([STREAM]);
        expect(posted).toEqual([
            { path: `/api/jobs/${job.id}/transcripts`, body: { leaseToken: 'lease-1' }, allow404: true },
        ]);
    });

    it.each([409, 404])('throws on a %i', async (status) => {
        await expect(calls(json({}, status)).api.transcripts(job)).rejects.toMatchObject({ status });
    });

    it.each([
        ['no stream list', {}],
        ['a stream with a bad session', { streams: [{ ...STREAM, session: 7 }] }],
        [
            'a stream with a bad chunk sha',
            { streams: [{ ...STREAM, chunks: [{ offset: 0, length: 3, sha256: 'x' }] }] },
        ],
    ])('throws on %s: an unreadable answer is never a verdict', async (_what, body) => {
        await expect(calls(json(body)).api.transcripts(job)).rejects.toThrow(/unreadable/);
    });

    const bytes = new TextEncoder().encode('abc');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const ref = { jobId: job.id, claimSeq: 2, session: 'alpha' };

    it('reads one chunk of one stream, checking its digest', async () => {
        const { api, posted } = calls(() => new Response(bytes, { headers: { 'x-chunk-sha256': sha } }));
        const read = await api.transcriptChunk(job, ref, 5);
        expect(read && [...read.bytes]).toEqual([...bytes]);
        expect(posted[0]).toMatchObject({
            path: `/api/jobs/${job.id}/transcripts/chunk`,
            body: { leaseToken: 'lease-1', ...ref, offset: 5 },
        });
    });

    it('answers null for a chunk the board no longer has, and throws on a mismatched digest', async () => {
        expect(await calls(() => new Response('{}', { status: 404 })).api.transcriptChunk(job, ref, 0)).toBeNull();
        await expect(
            calls(() => new Response(bytes, { headers: { 'x-chunk-sha256': SHA } })).api.transcriptChunk(job, ref, 0)
        ).rejects.toThrow(/does not match/);
    });
});

describe('syncFailureHalt', () => {
    it('ends an unrestorable thread with its own failure kind', () => {
        expect(syncFailureHalt({ ok: false, reason: 'no checkpoint', kind: 'checkpoint_unrestorable' })).toMatchObject({
            halt: 'fault',
            verdict: { status: 'failed', failureKind: 'checkpoint_unrestorable' },
        });
    });

    it('keeps an unnamed failure a runner error', () => {
        expect(syncFailureHalt({ ok: false, reason: 'boom' })).toMatchObject({
            verdict: { failureKind: 'runner_error' },
        });
    });
});
