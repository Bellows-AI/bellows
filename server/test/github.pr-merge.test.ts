import { describe, expect, it } from 'vitest';
import type { GitHubConfig } from '../src/config.js';
import { createGitHubAppClient } from '../src/github/app-client.js';
import type { InstallationTokenProvider } from '../src/github/app-token.js';
import { classifyMergeFailure, GitHubMergeError } from '../src/github/pr-merge.js';

/**
 * The merge request and the target read over a fake GitHub: what the PUT carries (the observed head
 * as `sha`), how each answer is classified — declined, forbidden, rate-limited, or unknown whether
 * it merged — and what the combined verification reads. A fake cannot prove how hosted protection
 * or a merge queue answers (docs/batches.md), only that every answer is classified, never assumed.
 */
const API = 'https://api.github.test';
const github = { mode: 'app', appId: '1', apiUrl: API, privateKey: 'k' } as unknown as Extract<
    GitHubConfig,
    { mode: 'app' }
>;
const tokens: InstallationTokenProvider = {
    get: async () => 'installation-token',
    fresh: async () => ({
        token: 'installation-token',
        expiresAt: '2026-01-01T01:00:00.000Z',
        permissions: {},
        repositories: [],
    }),
    revoke: async () => 'revoked',
    installationId: async () => '4242',
};

const base = '/repos/acme/web';

interface Seen {
    method: string;
    path: string;
    body: unknown;
}

/** Answers by `METHOD path-prefix`, longest first; an unrouted request is a 404. */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown } | Error>, seen: Seen[] = []) {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const path = String(input).replace(API, '');
        const method = init?.method ?? 'GET';
        seen.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const key = Object.keys(routes)
            .filter((route) => `${method} ${path}`.startsWith(route))
            .sort((a, b) => b.length - a.length)[0];
        const reply = key === undefined ? { status: 404, body: { message: 'Not Found' } } : routes[key]!;
        if (reply instanceof Error) throw reply;
        return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
    }) as typeof fetch;
}

const clientOf = (routes: Parameters<typeof fakeFetch>[0], seen?: Seen[]) =>
    createGitHubAppClient(github, tokens, fakeFetch(routes, seen), () => 1_000_000);

const mergeOf = (client: ReturnType<typeof clientOf>) =>
    client.mergePullRequest('acme/web', 7, { sha: 'head1', method: 'squash' });

const failureOf = async (client: ReturnType<typeof clientOf>) => {
    const error = await mergeOf(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubMergeError);
    return error as GitHubMergeError;
};

describe('mergePullRequest', () => {
    it('sends one PUT bound to the observed head and returns the merge commit', async () => {
        const seen: Seen[] = [];
        const result = await mergeOf(
            clientOf({ [`PUT ${base}/pulls/7/merge`]: { body: { merged: true, sha: 'm7' } } }, seen)
        );

        expect(result).toEqual({ mergeCommitSha: 'm7' });
        expect(seen).toEqual([
            { method: 'PUT', path: `${base}/pulls/7/merge`, body: { sha: 'head1', merge_method: 'squash' } },
        ]);
    });

    it.each([
        [405, 'refused'],
        [409, 'refused'],
        [422, 'refused'],
        [401, 'forbidden'],
        [403, 'forbidden'],
        [404, 'forbidden'],
        [500, 'uncertain'],
        [502, 'uncertain'],
        [504, 'uncertain'],
    ])('classifies a %s answer as %s', async (status, kind) => {
        const error = await failureOf(clientOf({ [`PUT ${base}/pulls/7/merge`]: { status, body: { message: 'no' } } }));
        expect(error.kind).toBe(kind);
    });

    it('reads a rate limit as not accepted and carries the provider’s wait', () => {
        const error = classifyMergeFailure(
            `${base}/pulls/7/merge`,
            { status: 429, headers: new Headers({ 'retry-after': '30' }), detail: 'slow down' },
            0
        );
        expect(error).toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    });

    it('reads a dropped connection as uncertain, never as a refusal', async () => {
        const error = await failureOf(clientOf({ [`PUT ${base}/pulls/7/merge`]: new Error('socket hang up') }));
        expect(error.kind).toBe('uncertain');
    });

    it('treats a 200 that says it did not merge as declined', async () => {
        const error = await failureOf(
            clientOf({ [`PUT ${base}/pulls/7/merge`]: { body: { merged: false, message: 'Not mergeable' } } })
        );
        expect(error.kind).toBe('refused');
    });

    it('treats a 200 with an unreadable body as merged: the provider accepted it', async () => {
        const result = await mergeOf(clientOf({ [`PUT ${base}/pulls/7/merge`]: { body: {} } }));
        expect(result).toEqual({ mergeCommitSha: null });
    });

    it('sends nothing when no installation token can be minted', async () => {
        const seen: Seen[] = [];
        const noToken = createGitHubAppClient(
            github,
            { ...tokens, get: async () => Promise.reject(new Error('no token')) },
            fakeFetch({}, seen)
        );
        const error = await noToken.mergePullRequest('acme/web', 7, { sha: 'h', method: 'squash' }).catch((e) => e);
        expect(error).toMatchObject({ kind: 'not_sent' });
        expect(seen).toEqual([]);
    });
});

describe('readBranchState', () => {
    const tip = {
        commit: { sha: 'tip1' },
        protected: true,
        protection: { required_status_checks: { contexts: ['build'], checks: [] } },
    };
    const routes = (compare: Record<string, string>) => ({
        [`GET ${base}/branches/main`]: { body: tip },
        [`GET ${base}/rules/branches/main`]: { body: [] },
        [`GET ${base}/commits/tip1/check-runs`]: {
            body: { check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] },
        },
        [`GET ${base}/commits/tip1/status`]: { body: { statuses: [] } },
        ...Object.fromEntries(
            Object.entries(compare).map(([sha, status]) => [`GET ${base}/compare/${sha}...tip1`, { body: { status } }])
        ),
    });

    it('reads the tip, whether it holds each merge commit, and the tip’s checks', async () => {
        const state = await clientOf(routes({ m1: 'ahead', m2: 'identical', m3: 'diverged' })).readBranchState(
            'acme/web',
            'main',
            ['m1', 'm2', 'm3', 'tip1']
        );

        expect(state).toMatchObject({
            headSha: 'tip1',
            contains: { m1: true, m2: true, m3: false, tip1: true },
            requiredContexts: ['build'],
            checks: [{ name: 'build', state: 'passing' }],
        });
    });

    it('does not contain a commit GitHub has never heard of', async () => {
        const state = await clientOf(routes({})).readBranchState('acme/web', 'main', ['gone']);
        expect(state.contains).toEqual({ gone: false });
    });

    it('fails, never passes, when the branch cannot be read', async () => {
        await expect(clientOf({}).readBranchState('acme/web', 'main', ['m1'])).rejects.toMatchObject({
            kind: 'not_found',
        });
    });
});

describe('readBranchHead', () => {
    it('answers the tip, or null for a branch it cannot read', async () => {
        const ok = clientOf({ [`GET ${base}/branches/main`]: { body: { commit: { sha: 'tip1' } } } });
        expect(await ok.readBranchHead('acme/web', 'main')).toBe('tip1');
        expect(await clientOf({}).readBranchHead('acme/web', 'main')).toBeNull();
    });
});
