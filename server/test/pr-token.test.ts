import { githubRepo, parseRepoRef, type RepoRef } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { createMergeTokenSource, createPrTokenSource } from '../src/forge/pr-token.js';

const GITLAB = parseRepoRef('gitlab:board.gitlab.test/grp/sub/web') as RepoRef;
const signal = new AbortController().signal;

describe('createPrTokenSource without member grants (AUTH_MODE=none)', () => {
    const minted: string[] = [];
    const tokens = createPrTokenSource({
        memberGrants: undefined,
        mint: async (_org, repo) => {
            minted.push(String(repo));
            return { token: 'installation-token' } as never;
        },
    });

    it('mints the installation token for a GitHub repo', async () => {
        const token = await tokens({ orgId: 'o', repo: githubRepo('acme/web'), executionUserId: null }, signal);
        expect(token).toEqual({ ok: true, token: 'installation-token', as: 'installation' });
    });

    it('answers no-forge for a GitLab repo and never mints a GitHub token for its path', async () => {
        minted.length = 0;
        const token = await tokens({ orgId: 'o', repo: GITLAB, executionUserId: null }, signal);
        expect(token).toEqual({ ok: false, answer: 'no-forge' });
        expect(minted).toEqual([]);
    });
});

describe('createMergeTokenSource without member grants (AUTH_MODE=none)', () => {
    const installation: string[] = [];
    const merge = createMergeTokenSource({
        memberGrants: undefined,
        installation: async () => {
            installation.push('read');
            return 'installation-token';
        },
    });

    it('answers the installation token for a GitHub repo', async () => {
        const token = await merge({ orgId: 'o', repo: githubRepo('acme/web'), startedBy: null }, signal);
        expect(token).toEqual({ ok: true, token: 'installation-token' });
    });

    it('answers no token for a GitLab repo and never reads the installation', async () => {
        installation.length = 0;
        const token = await merge({ orgId: 'o', repo: GITLAB, startedBy: null }, signal);
        expect(token.ok).toBe(false);
        expect(installation).toEqual([]);
    });
});
