import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { AttachmentCorrupt, AttachmentGone, attachmentCalls } from '../src/board/board-attachments.js';

/**
 * The board's worker read of one task input (`POST /api/jobs/:id/attachments/:attachmentId/content`): under the
 * live lease, the bytes checked against the digest the board sent before anyone trusts them.
 */
const job = { id: '22222222-2222-4222-8222-222222222222', leaseToken: 'lease-1' } as BoardJob;
const FILE = '33333333-3333-4333-8333-333333333333';
const bytes = new TextEncoder().encode('hello inputs');
const sha = createHash('sha256').update(bytes).digest('hex');

const calls = (response: Response) => {
    const posted: { path: string; body: unknown; allow404: boolean | undefined; allow: readonly number[] }[] = [];
    const api = attachmentCalls(async (path, body, allow404, options) => {
        posted.push({ path, body, allow404, allow: options?.allow ?? [] });
        return response;
    });
    return { api, posted };
};
const content = (headers: Record<string, string>, status = 200) => new Response(bytes, { status, headers });
const refusal = (status: number, code: string) => new Response(JSON.stringify({ code }), { status });

describe('the board attachment content read', () => {
    it('posts the lease alone and returns the bytes with their digest', async () => {
        const { api, posted } = calls(content({ 'x-content-sha256': sha }));

        const read = await api.attachmentContent(job, FILE);

        expect(read).toEqual({ bytes, sha256: sha });
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({
            path: `/api/jobs/${job.id}/attachments/${FILE}/content`,
            body: { leaseToken: 'lease-1' },
            allow404: true,
        });
    });

    it('verifies x-content-sha256 against the bytes it received', async () => {
        const lying = calls(content({ 'x-content-sha256': 'e'.repeat(64) }));
        await expect(lying.api.attachmentContent(job, FILE)).rejects.toMatchObject({ status: 200 });
        const missing = calls(content({}));
        await expect(missing.api.attachmentContent(job, FILE)).rejects.toThrow(/sha256/);
    });

    it('returns null for a file the board does not hold in the set', async () => {
        expect(await calls(refusal(404, 'ATTACHMENT_NOT_FOUND')).api.attachmentContent(job, FILE)).toBeNull();
    });

    it('reports 410 as gone and a corrupt 422 as corrupt', async () => {
        await expect(calls(refusal(410, 'ATTACHMENT_GONE')).api.attachmentContent(job, FILE)).rejects.toBeInstanceOf(
            AttachmentGone
        );
        await expect(calls(refusal(422, 'ARTIFACT_CORRUPT')).api.attachmentContent(job, FILE)).rejects.toBeInstanceOf(
            AttachmentCorrupt
        );
    });

    it('throws a board error on a lease the board no longer honours', async () => {
        await expect(calls(refusal(409, 'LEASE_LOST')).api.attachmentContent(job, FILE)).rejects.toMatchObject({
            status: 409,
        });
    });
});
