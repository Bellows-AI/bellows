import { githubRepo, type RepoRef } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { checkReposVisible, repoRefReason } from '../src/routes/helpers.js';

const gitlab = (path: string): RepoRef => ({ forge: 'gitlab', host: 'gl.example', path });

const sourceOf = (names: string[], error: string | null = null) =>
    ({
        detail: async () => ({
            repos: names.map((n) => {
                const [owner, name] = n.split('/');
                return { owner: owner!, name: name!, private: false, defaultBranch: null, pushedAt: null };
            }),
            installation: null,
            error,
        }),
    }) as unknown as Parameters<typeof checkReposVisible>[0];

describe('repoRefReason', () => {
    it('accepts a plain GitHub ref and a nested GitLab one', () => {
        expect(repoRefReason(githubRepo('acme/web'))).toBeNull();
        expect(repoRefReason(gitlab('g/sub/p'))).toBeNull();
    });

    it.each([
        [gitlab('g/-x/p'), /starts with/],
        [githubRepo('acme/.x'), /starts with/],
        [githubRepo('acme/..'), /starts with/],
        [githubRepo(`acme/${'x'.repeat(101)}`), /exceeds 100/],
    ])('refuses %j', (ref, message) => {
        expect(repoRefReason(ref)).toMatch(message);
    });

    it('lets a read name a dotted repo such as .github', () => {
        expect(repoRefReason(githubRepo('acme/.github'))).toMatch(/starts with/);
        expect(repoRefReason(githubRepo('acme/.github'), { allowDotted: true })).toBeNull();
        expect(repoRefReason(githubRepo('acme/..'), { allowDotted: true })).not.toBeNull();
        expect(repoRefReason(githubRepo('acme/-x'), { allowDotted: true })).not.toBeNull();
    });
});

describe('checkReposVisible over refs', () => {
    const subject = { subject: 'the repository' };

    it('accepts a listed GitHub ref', async () => {
        await expect(checkReposVisible(sourceOf(['acme/web']), [githubRepo('acme/web')], subject)).resolves.toEqual({
            ok: true,
        });
    });

    it('matches exactly: no GitHub case fold (pin, unchanged behaviour)', async () => {
        // Written against the old {owner,name} call pre-fix, so it passes there too.
        const result = await checkReposVisible(sourceOf(['acme/web']), [githubRepo('acme/WEB')], subject);
        expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_REPO' });
    });

    it('does not take a GitLab ref for the GitHub repo of the same path', async () => {
        const result = await checkReposVisible(sourceOf(['acme/web']), [gitlab('acme/web')], subject);
        expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_REPO' });
        expect((result as { message: string }).message).toContain('gitlab:gl.example/acme/web');
    });

    it('answers 503 UNAVAILABLE on a miss while the read has an error', async () => {
        const result = await checkReposVisible(sourceOf([], 'boom'), [githubRepo('acme/web')], subject);
        expect(result).toMatchObject({ ok: false, status: 503, code: 'UNAVAILABLE' });
    });
});
