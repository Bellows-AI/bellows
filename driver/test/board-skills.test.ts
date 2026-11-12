import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { SkillCorrupt, SkillGone, skillCalls, skillHiddenOf } from '../src/board/board-skills.js';

/**
 * The board's worker read of one pinned skill bundle (`POST /api/jobs/:id/skills/:versionId/content`): under the live
 * lease, the bytes checked against the digest the board sent. Only the board's 410 and 422 are verdicts.
 */
const job = { id: '22222222-2222-4222-8222-222222222222', leaseToken: 'lease-1' } as BoardJob;
const VERSION = '77777777-7777-4777-8777-777777777777';
const bytes = new TextEncoder().encode('a tar');
const sha = createHash('sha256').update(bytes).digest('hex');

const calls = (response: Response) => {
    const posted: { path: string; body: unknown; allow404: boolean | undefined; allow: readonly number[] }[] = [];
    const api = skillCalls(async (path, body, allow404, options) => {
        posted.push({ path, body, allow404, allow: options?.allow ?? [] });
        return response;
    });
    return { api, posted };
};
const refusal = (status: number, code: string) => new Response(JSON.stringify({ code }), { status });

describe('the board skill content read', () => {
    it('posts the lease alone to the skill route and returns the bytes with their digest', async () => {
        const { api, posted } = calls(new Response(bytes, { headers: { 'x-content-sha256': sha } }));
        expect(await api.skillContent(job, VERSION)).toEqual({ bytes, sha256: sha });
        expect(posted).toEqual([
            {
                path: `/api/jobs/${job.id}/skills/${VERSION}/content`,
                body: { leaseToken: 'lease-1' },
                allow404: true,
                allow: [410, 422],
            },
        ]);
    });

    it('verifies x-content-sha256 against the bytes it received', async () => {
        const lying = calls(new Response(bytes, { headers: { 'x-content-sha256': 'e'.repeat(64) } }));
        await expect(lying.api.skillContent(job, VERSION)).rejects.toMatchObject({ status: 200 });
        await expect(calls(new Response(bytes)).api.skillContent(job, VERSION)).rejects.toThrow(/sha256/);
    });

    it('returns null for a version that is not in the row’s pin', async () => {
        expect(await calls(refusal(404, 'SKILL_NOT_FOUND')).api.skillContent(job, VERSION)).toBeNull();
    });

    it('reports 410 as gone and a corrupt 422 as corrupt: the two verdicts', async () => {
        await expect(calls(refusal(410, 'SKILL_GONE')).api.skillContent(job, VERSION)).rejects.toBeInstanceOf(
            SkillGone
        );
        await expect(calls(refusal(422, 'ARTIFACT_CORRUPT')).api.skillContent(job, VERSION)).rejects.toBeInstanceOf(
            SkillCorrupt
        );
    });

    it.each([[409], [500], [503]])('throws an ordinary board error on %i, never a verdict', async (status) => {
        const error = await calls(refusal(status, 'X'))
            .api.skillContent(job, VERSION)
            .catch((e: unknown) => e);
        expect(error).toMatchObject({ status });
        expect(error).not.toBeInstanceOf(SkillGone);
        expect(error).not.toBeInstanceOf(SkillCorrupt);
    });
});

describe('skillHiddenOf', () => {
    const entry = (over: Record<string, unknown> = {}) => ({
        name: 'factory-jira',
        source: 'builtin',
        reason: 'needs_connection',
        connection: 'jira',
        ...over,
    });

    it('reads a well-formed list as its built-in names; org and workspace entries need no install-side handling', () => {
        expect(skillHiddenOf([entry(), entry({ name: 'org-style', source: 'org', reason: 'switched_off' })])).toEqual({
            hidden: ['factory-jira'],
        });
        expect(skillHiddenOf([])).toEqual({ hidden: [] });
    });

    it.each([
        ['absent', undefined],
        ['null', null],
        ['not a list', { name: 'factory-jira' }],
        ['an entry missing its reason', [entry({ reason: undefined })]],
        ['an entry missing its name', [entry({ name: undefined })]],
        ['an unknown reason', [entry({ reason: 'because' })]],
        ['an unknown source', [entry({ source: 'repo' })]],
        ['a duplicate name', [entry(), entry({ reason: 'switched_off' })]],
    ])('is unreadable for %s, never "nothing hidden"', (_name, value) => {
        const read = skillHiddenOf(value);
        expect(read).toHaveProperty('unreadable');
        expect(read).not.toHaveProperty('hidden');
    });
});
