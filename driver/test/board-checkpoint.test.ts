import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { checkpointCalls } from '../src/board-checkpoint.js';
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

    it('throws on a missing or mismatched digest', async () => {
        await expect(calls(chunk({})).api.checkpointChunk(job, 0)).rejects.toThrow(/without its sha256/);
        await expect(calls(chunk({ 'x-chunk-sha256': SHA })).api.checkpointChunk(job, 0)).rejects.toThrow(
            /does not match/
        );
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
