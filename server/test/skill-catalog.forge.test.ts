import { githubRepo, parseRepoRef } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { effectiveCatalog, standingOf } from '../src/skill-catalog.js';
import { githubForge } from './helpers-forge.js';

const GITLAB = parseRepoRef('gitlab:gitlab.example.test/acme/web')!;
const GITHUB_ENTERPRISE = parseRepoRef('github:ghe.example.test/acme/web')!;
const read = { revision: 'r', skills: [], unreadable: [], complete: true };

const catalogOf = (repo: Parameters<typeof effectiveCatalog>[0]['repo'], reads: string[]) =>
    effectiveCatalog({
        builtin: [],
        forge: githubForge({
            listRepoSkills: async (path) => {
                reads.push(path);
                return read;
            },
        }),
        repo,
        branch: null,
        executorType: { state: 'known', type: null },
        need: ['deploy'],
    });

describe('the repository skills read, by complete repo ref', () => {
    it('reads a github.com repository through the installation', async () => {
        const reads: string[] = [];
        const catalog = await catalogOf(githubRepo('acme/web'), reads);
        expect(reads).toEqual(['acme/web']);
        expect(catalog.repo.state).toBe('read');
        expect(standingOf(catalog, 'deploy')).toBe('absent');
    });

    it.each([GITLAB, GITHUB_ENTERPRISE])(
        'never reads the GitHub client for %j: the answer is unconfirmed, never "no skills"',
        async (repo) => {
            const reads: string[] = [];
            const catalog = await catalogOf(repo, reads);
            expect(reads).toEqual([]);
            expect(catalog.repo.state).toBe('unconfirmed');
            expect(standingOf(catalog, 'deploy')).toBe('unverified');
        }
    );
});
