import { githubRepo } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { forgeOfRepo, isGithubRepo } from '../src/forge/forges.js';
import { refOf, REPO_VARIANTS } from '../test-db/repo-variants.js';

describe('isGithubRepo', () => {
    it('answers for GitHub on github.com, any path case', () => {
        expect(isGithubRepo(githubRepo('Acme/Web'))).toBe(true);
    });

    it.each(REPO_VARIANTS)('refuses $name, which the GitHub reader cannot answer for', (variant) => {
        expect(isGithubRepo(refOf(variant, 'acme/web'))).toBe(false);
    });
});

describe('forgeOfRepo', () => {
    it('names the forge a ref lives on, null for a task with no repo', () => {
        expect(forgeOfRepo(githubRepo('a/b'))).toBe('github');
        expect(forgeOfRepo(null)).toBeNull();
        expect(forgeOfRepo({ forge: 'gitlab', host: 'gl.example', path: 'g/p' })).toBe('gitlab:gl.example');
    });
});
