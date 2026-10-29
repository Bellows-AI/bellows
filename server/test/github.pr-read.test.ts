import { assessPullRequest } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import type { GitHubConfig } from '../src/config.js';
import { createGitHubAppClient } from '../src/github/app-client.js';
import type { InstallationTokenProvider } from '../src/github/app-token.js';
import { GitHubReadError } from '../src/github/pr-read.js';

/**
 * The real client over a fake GitHub: which endpoints a PR read touches, how each status maps to
 * a read error, and what the facts say. What a fake cannot prove is in docs/batches.md: a hosted
 * merge queue, an App without the right permissions, or protection only an admin token can read.
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

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

/** Routes by path prefix; an unrouted path is a 404, like GitHub for a repo the installation cannot see. */
function fakeGitHub(routes: Record<string, Reply | (() => Reply)>, requests: string[] = []): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const path = String(input).replace(API, '');
        requests.push(path);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer installation-token');
        const key = Object.keys(routes)
            .filter((prefix) => path.startsWith(prefix))
            .sort((a, b) => b.length - a.length)[0];
        const found = key === undefined ? undefined : routes[key];
        const reply = (typeof found === 'function' ? found() : found) ?? {
            status: 404,
            body: { message: 'Not Found' },
        };
        return new Response(JSON.stringify(reply.body ?? {}), {
            status: reply.status ?? 200,
            ...(reply.headers ? { headers: reply.headers } : {}),
        });
    }) as typeof fetch;
}

const pull = (extra: Record<string, unknown> = {}) => ({
    number: 7,
    html_url: 'https://github.com/acme/web/pull/7',
    state: 'open',
    merged: false,
    mergeable: true,
    head: { sha: 'head1' },
    base: { ref: 'main', repo: { full_name: 'acme/web' } },
    ...extra,
});

const protectedMain = {
    commit: { sha: 'target1' },
    protected: true,
    protection: { required_status_checks: { contexts: ['build'], checks: [{ context: 'lint' }] } },
};

const base = '/repos/acme/web';

const client = (routes: Parameters<typeof fakeGitHub>[0], requests?: string[], now = () => 1_000_000) =>
    createGitHubAppClient(github, tokens, fakeGitHub(routes, requests), now);

describe('readPullRequest', () => {
    it('reads state, head, target, required contexts and the checks on the head', async () => {
        const requests: string[] = [];
        const facts = await client(
            {
                [`${base}/pulls/7`]: { body: pull() },
                [`${base}/branches/main`]: { body: protectedMain },
                [`${base}/rules/branches/main`]: { body: [] },
                [`${base}/commits/head1/check-runs`]: {
                    body: {
                        check_runs: [
                            {
                                id: 1,
                                name: 'build',
                                status: 'completed',
                                conclusion: 'failure',
                                html_url: 'https://ci/1',
                            },
                            {
                                id: 2,
                                name: 'build',
                                status: 'completed',
                                conclusion: 'success',
                                html_url: 'https://ci/2',
                            },
                            { id: 3, name: 'lint', status: 'in_progress', conclusion: null },
                        ],
                    },
                },
                [`${base}/commits/head1/status`]: { body: { statuses: [] } },
            },
            requests
        ).readPullRequest('acme/web', 7);

        expect(facts).toMatchObject({
            repo: 'acme/web',
            number: 7,
            state: 'open',
            headSha: 'head1',
            targetSha: 'target1',
            baseBranch: 'main',
            mergeable: true,
            requiredContexts: ['build', 'lint'],
        });
        // A re-run replaces the failure it superseded.
        expect(facts.checks.find((c) => c.name === 'build')).toMatchObject({ state: 'passing', url: 'https://ci/2' });
        expect(facts.checks.find((c) => c.name === 'lint')?.state).toBe('pending');
        expect(assessPullRequest(facts).outcome).toBe('checks_pending');
        expect(requests.every((r) => r.startsWith(base))).toBe(true);
    });

    it('treats commit statuses as checks and a cancelled run as unknown, never failing', async () => {
        const facts = await client({
            [`${base}/pulls/7`]: { body: pull() },
            [`${base}/branches/main`]: {
                body: { ...protectedMain, protection: { required_status_checks: { contexts: ['ci/x', 'build'] } } },
            },
            [`${base}/rules/branches/main`]: { body: [] },
            [`${base}/commits/head1/check-runs`]: {
                body: { check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'cancelled' }] },
            },
            [`${base}/commits/head1/status`]: {
                body: { statuses: [{ context: 'ci/x', state: 'failure', target_url: 'https://ci/x' }] },
            },
        }).readPullRequest('acme/web', 7);
        expect(facts.checks.find((c) => c.name === 'build')?.state).toBe('unknown');
        expect(assessPullRequest(facts)).toMatchObject({ outcome: 'checks_failing', repairable: true });
    });

    it('reads rulesets: required contexts and the approvals a pull_request rule demands', async () => {
        const facts = await client({
            [`${base}/pulls/7`]: { body: pull() },
            [`${base}/branches/main`]: { body: { commit: { sha: 't' }, protected: false } },
            [`${base}/rules/branches/main`]: {
                body: [
                    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } },
                    { type: 'pull_request', parameters: { required_approving_review_count: 2 } },
                ],
            },
            [`${base}/commits/head1/check-runs`]: {
                body: { check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] },
            },
            [`${base}/commits/head1/status`]: { body: {} },
            [`${base}/pulls/7/reviews`]: {
                body: [
                    { state: 'APPROVED', user: { id: 1 } },
                    { state: 'COMMENTED', user: { id: 1 } },
                    { state: 'APPROVED', user: { id: 2 } },
                    { state: 'CHANGES_REQUESTED', user: { id: 2 } },
                ],
            },
        }).readPullRequest('acme/web', 7);
        expect(facts).toMatchObject({ requiredContexts: ['build'], requiredApprovals: 2, approvals: 1 });
        expect(assessPullRequest(facts).outcome).toBe('review_required');
    });

    it('cannot call checks passing when protection is unreadable', async () => {
        const facts = await client({
            [`${base}/pulls/7`]: { body: pull() },
            [`${base}/branches/main`]: { status: 403, body: { message: 'forbidden' } },
            [`${base}/rules/branches/main`]: { status: 403 },
            [`${base}/commits/head1/check-runs`]: {
                body: { check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] },
            },
            [`${base}/commits/head1/status`]: { body: {} },
        }).readPullRequest('acme/web', 7);
        expect(facts).toMatchObject({ requiredContexts: null, targetSha: null });
        expect(assessPullRequest(facts)).toMatchObject({ outcome: 'unknown', repairable: false });
    });

    it('carries the PR activity stamp the pull payload already holds, null when GitHub sent none', async () => {
        const routes = {
            [`${base}/branches/main`]: { body: protectedMain },
            [`${base}/rules/branches/main`]: { body: [] },
            [`${base}/commits/head1/check-runs`]: { body: { check_runs: [] } },
            [`${base}/commits/head1/status`]: { body: { statuses: [] } },
        };
        const stamped = await client({
            ...routes,
            [`${base}/pulls/7`]: { body: pull({ updated_at: '2026-10-22T08:00:00Z' }) },
        }).readPullRequest('acme/web', 7);
        const bare = await client({ ...routes, [`${base}/pulls/7`]: { body: pull() } }).readPullRequest('acme/web', 7);
        expect(stamped.updatedAt).toBe('2026-10-22T08:00:00Z');
        expect(bare.updatedAt).toBeNull();
    });

    it.each([
        ['no state', { state: undefined }],
        ['an unknown state', { state: 'draft' }],
        ['no merged flag', { merged: undefined }],
        ['a merged PR that is not closed', { state: 'open', merged: true }],
    ])('refuses to guess from a payload with %s: a read failure, never a closed PR', async (_label, extra) => {
        await expect(
            client({
                [`${base}/pulls/7`]: { body: pull(extra) },
                [`${base}/branches/main`]: { body: protectedMain },
                [`${base}/rules/branches/main`]: { body: [] },
                [`${base}/commits/head1/check-runs`]: { body: { check_runs: [] } },
                [`${base}/commits/head1/status`]: { body: { statuses: [] } },
            }).readPullRequest('acme/web', 7)
        ).rejects.toBeInstanceOf(GitHubReadError);
    });

    it('reports a merged PR with its merge commit and time', async () => {
        const facts = await client({
            [`${base}/pulls/7`]: {
                body: pull({
                    state: 'closed',
                    merged: true,
                    merged_at: '2026-10-12T01:00:00Z',
                    merge_commit_sha: 'mc1',
                }),
            },
            [`${base}/commits/`]: { body: {} },
        }).readPullRequest('acme/web', 7);
        expect(facts).toMatchObject({ merged: true, mergedAt: '2026-10-12T01:00:00Z', mergeCommitSha: 'mc1' });
        expect(assessPullRequest(facts).outcome).toBe('merged');
    });

    it('reads rulesets once per five minutes, so polling does not spend the installation rate limit', async () => {
        const requests: string[] = [];
        let clock = 1_000_000;
        const github = client(
            {
                [`${base}/pulls/7`]: { body: pull() },
                [`${base}/branches/main`]: { body: protectedMain },
                [`${base}/rules/branches/main`]: { body: [] },
                [`${base}/commits/head1/check-runs`]: { body: { check_runs: [] } },
                [`${base}/commits/head1/status`]: { body: {} },
            },
            requests,
            () => clock
        );
        const rulesReads = () => requests.filter((r) => r.includes('/rules/')).length;

        await github.readPullRequest('acme/web', 7);
        clock += 60_000;
        await github.readPullRequest('acme/web', 7);
        expect(rulesReads()).toBe(1);

        clock += 300_000;
        await github.readPullRequest('acme/web', 7);
        expect(rulesReads()).toBe(2);
    });

    it('refuses a PR that belongs to another repository', async () => {
        const call = client({
            [`${base}/pulls/7`]: { body: pull({ base: { ref: 'main', repo: { full_name: 'other/web' } } }) },
        }).readPullRequest('acme/web', 7);
        await expect(call).rejects.toMatchObject({ kind: 'not_found' });
    });
});

describe('read failures', () => {
    const read = (reply: Reply) => client({ [`${base}/pulls/7`]: reply }).readPullRequest('acme/web', 7);

    it.each([
        ['an unknown or inaccessible PR', { status: 404 }, 'not_found'],
        [
            'a permission error',
            { status: 403, body: { message: 'Resource not accessible by integration' } },
            'forbidden',
        ],
        ['a rejected credential', { status: 401 }, 'forbidden'],
        ['a server error', { status: 502 }, 'transport'],
    ] as const)('maps %s to %s', async (_what, reply, kind) => {
        const error = await read(reply).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GitHubReadError);
        expect(error).toMatchObject({ kind });
    });

    it('maps a dropped connection to transport', async () => {
        const failing = createGitHubAppClient(github, tokens, (async () => {
            throw new Error('socket hang up');
        }) as typeof fetch);
        await expect(failing.readPullRequest('acme/web', 7)).rejects.toMatchObject({ kind: 'transport' });
    });

    it('honors Retry-After on a secondary rate limit', async () => {
        await expect(
            read({
                status: 403,
                body: { message: 'You have exceeded a secondary rate limit' },
                headers: { 'retry-after': '90' },
            })
        ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 90_000 });
    });

    it('reads the reset instant when the primary limit is spent and no Retry-After is sent', async () => {
        // now() is 1,000,000 ms; the limit resets at 1,060 s.
        await expect(
            read({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1060' } })
        ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
    });

    it('treats 429 as a rate limit', async () => {
        await expect(read({ status: 429 })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: null });
    });
});
