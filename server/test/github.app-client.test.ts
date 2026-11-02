import { describe, expect, it } from 'vitest';
import type { GitHubConfig } from '../src/config.js';
import { BranchCursorError, createGitHubAppClient } from '../src/github/app-client.js';
import type { InstallationTokenProvider } from '../src/github/app-token.js';

/**
 * These tests drive the REAL client over a fake fetch, because the wire contract is exactly what
 * the stubs in helpers.ts cannot catch: which status each endpoint answers, and what a page walk
 * does at its edges.
 */
const github = {
    mode: 'app',
    appId: '1',
    apiUrl: 'https://api.github.test',
    privateKey: 'not-a-real-key',
} as unknown as Extract<GitHubConfig, { mode: 'app' }>;

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

interface Call {
    path: string;
    status: number;
    body: unknown;
    headers?: Record<string, string>;
}

/** A fetch that answers from a script, one call per entry, and records every request path. */
function fetchScript(script: Call[], requests: string[]): typeof fetch {
    let n = 0;
    return (async (input: Parameters<typeof fetch>[0]) => {
        const path = String(input).replace('https://api.github.test', '');
        requests.push(path);
        const next = script[Math.min(n, script.length - 1)]!;
        n += 1;
        const headers = new Headers(next.headers);
        return new Response(next.body === null ? null : JSON.stringify(next.body), {
            status: next.status,
            headers,
        });
    }) as typeof fetch;
}

const repo = (owner: string, name: string) => ({
    name,
    private: false,
    default_branch: 'main',
    pushed_at: '2026-08-21T12:00:00Z',
    owner: { login: owner },
});

describe('listRepositories', () => {
    it('maps the payload and infers the installation account from a single owner', async () => {
        const requests: string[] = [];
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript(
                [
                    {
                        path: '/x',
                        status: 200,
                        body: {
                            total_count: 2,
                            repository_selection: 'selected',
                            repositories: [repo('acme', 'web'), repo('acme', 'api')],
                        },
                    },
                ],
                requests
            )
        );

        const listing = await client.listRepositories();

        expect(listing.repos).toEqual([
            { owner: 'acme', name: 'web', private: false, defaultBranch: 'main', pushedAt: '2026-08-21T12:00:00Z' },
            { owner: 'acme', name: 'api', private: false, defaultBranch: 'main', pushedAt: '2026-08-21T12:00:00Z' },
        ]);
        expect(listing.installation).toMatchObject({ id: '4242', account: 'acme', repositorySelection: 'selected' });
        expect(requests.every((p) => p.startsWith('/installation/repositories'))).toBe(true);
    });

    it('answers a null account when the installation spans several owners', async () => {
        // "The account this is installed on" is then not a single answer, and a first-repo guess
        // would be a wrong one.
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript(
                [
                    {
                        path: '/x',
                        status: 200,
                        body: { total_count: 2, repositories: [repo('acme', 'web'), repo('other', 'api')] },
                    },
                ],
                []
            )
        );

        const listing = await client.listRepositories();
        expect(listing.installation.account).toBeNull();
    });

    it('walks pages until total_count is reached', async () => {
        const requests: string[] = [];
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript(
                [
                    {
                        path: '/x',
                        status: 200,
                        body: { total_count: 3, repositories: [repo('acme', 'a'), repo('acme', 'b')] },
                    },
                    { path: '/x', status: 200, body: { total_count: 3, repositories: [repo('acme', 'c')] } },
                ],
                requests
            )
        );

        const listing = await client.listRepositories();
        const EXPECTED_REPO_COUNT = 3;
        expect(listing.repos).toHaveLength(EXPECTED_REPO_COUNT);
        expect(requests.some((p) => p.includes('page=2'))).toBe(true);
        expect(requests.some((p) => p.includes('page=3'))).toBe(false);
    });

    it('skips a malformed entry instead of costing the whole list', async () => {
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript(
                [
                    {
                        path: '/x',
                        status: 200,
                        body: { total_count: 2, repositories: [repo('acme', 'good'), { owner: { login: 'acme' } }] },
                    },
                    { path: '/x', status: 200, body: { total_count: 2, repositories: [] } },
                ],
                []
            )
        );

        const listing = await client.listRepositories();
        expect(listing.repos).toHaveLength(1);
        expect(listing.repos[0]).toMatchObject({ name: 'good' });
    });

    it('maps a failure status to a named error carrying GitHub’s reason', async () => {
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript([{ path: '/x', status: 403, body: { message: 'rate limited' } }], [])
        );

        await expect(client.listRepositories()).rejects.toThrow(/403[\s\S]*rate limited/);
    });
});

describe('listBranches', () => {
    const branches = (...names: string[]) => names.map((name) => ({ name }));
    const next = (page: number, base = 'https://api.github.test') => ({
        link: `<${base}/repos/acme/web/branches?per_page=100&page=${page}>; rel="next", <${base}/repos/acme/web/branches?per_page=100&page=9>; rel="last"`,
    });
    const clientFor = (script: Call[], requests: string[] = []) =>
        createGitHubAppClient(github, tokens, fetchScript(script, requests));

    it('lists a page and returns a cursor from Link rel=next', async () => {
        const requests: string[] = [];
        const client = clientFor(
            [
                { path: '/x', status: 200, body: branches('main', 'dev'), headers: next(2) },
                { path: '/x', status: 200, body: branches('zed') },
            ],
            requests
        );

        const first = await client.listBranches('acme/web', {});
        expect(requests).toEqual(['/repos/acme/web/branches?per_page=100&page=1']);
        expect(first.names).toEqual(['main', 'dev']);
        expect(first.cursor).not.toBeNull();

        const second = await client.listBranches('acme/web', { cursor: first.cursor! });
        expect(requests[1]).toBe('/repos/acme/web/branches?per_page=100&page=2');
        expect(second).toEqual({ names: ['zed'], cursor: null });
    });

    it('answers a null cursor without a Link next (a full page of 100 alone never implies more)', async () => {
        const names = Array.from({ length: 100 }, (_, i) => `b${i}`);
        const client = clientFor([{ path: '/x', status: 200, body: branches(...names) }]);

        const page = await client.listBranches('acme/web', {});
        expect(page.names).toHaveLength(100);
        expect(page.cursor).toBeNull();
    });

    it('searches matching-refs/heads/<encoded segments> and strips refs/heads/', async () => {
        const requests: string[] = [];
        const client = clientFor(
            [
                {
                    path: '/x',
                    status: 200,
                    body: [{ ref: 'refs/heads/feat/b' }, { ref: 'refs/heads/feat/a' }],
                },
            ],
            requests
        );

        const page = await client.listBranches('acme/web', { query: 'fe at/x#' });
        expect(requests).toEqual(['/repos/acme/web/git/matching-refs/heads/fe%20at/x%23']);
        expect(page).toEqual({ names: ['feat/a', 'feat/b'], cursor: null });
    });

    it('pages a search by offset slices of one response (matching-refs is unpaginated)', async () => {
        const refs = Array.from({ length: 250 }, (_, i) => ({ ref: `refs/heads/f${String(i).padStart(3, '0')}` }));
        const requests: string[] = [];
        const client = clientFor([{ path: '/x', status: 200, body: refs }], requests);

        const one = await client.listBranches('acme/web', { query: 'f' });
        expect(one.names).toHaveLength(100);
        expect(one.names[0]).toBe('f000');
        const two = await client.listBranches('acme/web', { query: 'f', cursor: one.cursor! });
        expect(two.names[0]).toBe('f100');
        const three = await client.listBranches('acme/web', { query: 'f', cursor: two.cursor! });
        expect(three.names).toHaveLength(50);
        expect(three.cursor).toBeNull();
        expect(requests.every((r) => !/per_page|page=/.test(r))).toBe(true);
    });

    it.each([
        ['a non-array body', { body: { message: 'x' } }],
        ['a branch without name', { body: [{ nope: 1 }] }],
        ['a Link next on a foreign origin', { body: branches('a'), headers: next(2, 'https://evil.test') }],
        [
            'a Link next without a page',
            { body: branches('a'), headers: { link: '<https://api.github.test/x>; rel="next"' } },
        ],
    ])('throws READ_BINDING on %s', async (_label, answer) => {
        const client = clientFor([{ path: '/x', status: 200, ...answer }]);
        await expect(client.listBranches('acme/web', {})).rejects.toMatchObject({ kind: 'binding' });
    });

    it('throws READ_BINDING on a search entry outside refs/heads/ or without ref', async () => {
        for (const body of [[{ ref: 'refs/tags/v1' }], [{ name: 'x' }]]) {
            const client = clientFor([{ path: '/x', status: 200, body }]);
            await expect(client.listBranches('acme/web', { query: 'v' })).rejects.toMatchObject({ kind: 'binding' });
        }
    });

    it('rejects a cursor for another mode or query, or a forged one', async () => {
        const client = clientFor([{ path: '/x', status: 200, body: branches('a'), headers: next(2) }]);
        const page = await client.listBranches('acme/web', {});
        for (const args of [
            { query: 'f', cursor: page.cursor! },
            { cursor: 'not-base64-json' },
            { cursor: Buffer.from(JSON.stringify({ mode: 'list', query: '', page: 1 })).toString('base64url') },
            { cursor: Buffer.from(JSON.stringify({ mode: 'list', query: '', page: 1e9 })).toString('base64url') },
        ]) {
            await expect(client.listBranches('acme/web', args)).rejects.toBeInstanceOf(BranchCursorError);
        }
    });

    it('keeps a rate-limited 403 as READ_RATE_LIMITED', async () => {
        const client = clientFor([
            {
                path: '/x',
                status: 403,
                body: { message: 'API rate limit exceeded' },
                headers: { 'x-ratelimit-remaining': '0' },
            },
        ]);
        await expect(client.listBranches('acme/web', {})).rejects.toMatchObject({ kind: 'rate_limited' });
    });
});

describe('listRepoSkills', () => {
    it('reaches every request with the caller signal, and an aborted caller stops the read', async () => {
        const seen: AbortSignal[] = [];
        const fetchFn = (async (_input: unknown, init?: RequestInit) => {
            seen.push(init?.signal as AbortSignal);
            return new Response(JSON.stringify({ sha: 'abc' }), { status: 200 });
        }) as typeof fetch;
        const client = createGitHubAppClient(github, tokens, fetchFn);
        const controller = new AbortController();
        const read = await client.listRepoSkills('acme/skills-signal', 'main', controller.signal).catch((e) => e);
        // The tip answered {sha}; the directory read got the same JSON, a non-array: unconfirmed, not "none".
        expect(read).toMatchObject({ kind: 'binding' });
        expect(seen.length).toBeGreaterThan(1);
        controller.abort();
        expect(seen.every((signal) => signal.aborted)).toBe(true);
    });
});
