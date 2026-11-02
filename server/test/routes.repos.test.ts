import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { GitHubAppClient, InstallationListing } from '../src/github/app-client.js';
import { createRepoSource } from '../src/github/repo-source.js';
import { listingClient, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import { HTTP_BAD_REQUEST, HTTP_OK, trackApps } from './helpers-http.js';

const track = trackApps();

function listing(overrides: Partial<InstallationListing> = {}): InstallationListing {
    return {
        repos: [
            { owner: 'acme', name: 'web', private: true, defaultBranch: 'main', pushedAt: '2026-08-20T00:00:00.000Z' },
            { owner: 'acme', name: 'api', private: false, defaultBranch: 'dev', pushedAt: null },
        ],
        installation: { id: '4242', account: 'acme', repositorySelection: 'selected' },
        ...overrides,
    };
}

/** An App client with no fetch behind it, so the suite stays offline. */
function stubAppClient(behaviour: () => Promise<InstallationListing>): GitHubAppClient {
    return listingClient(behaviour);
}

async function boot(client?: GitHubAppClient) {
    const config = testConfig();
    const repos = createRepoSource({ client });
    const app = track(
        await buildApp({ config, orgs: staticRegistry({ config, repos, telemetry: stubTelemetryClient() }) })
    );
    return { app, repos };
}

describe('GET /api/repos', () => {
    it('reports what the installation can see', async () => {
        const { app } = await boot(stubAppClient(async () => listing()));
        const response = await app.inject({ method: 'GET', url: '/api/repos' });

        expect(response.statusCode).toBe(HTTP_OK);
        const body = response.json();
        expect(body.repos).toEqual([
            { owner: 'acme', name: 'web', private: true, defaultBranch: 'main', pushedAt: '2026-08-20T00:00:00.000Z' },
            { owner: 'acme', name: 'api', private: false, defaultBranch: 'dev', pushedAt: null },
        ]);
        expect(body.installation).toEqual({ id: '4242', account: 'acme', repositorySelection: 'selected' });
        expect(body.meta.error).toBeNull();
    });

    it('answers 200 with an empty list when no App client was built', async () => {
        // The code-only `none` arm. Not a 503: "nothing is installed" is a real state the picker
        // renders a different thing for, and a route that errors here would make the whole page
        // unreachable on a process that deliberately fetches nothing.
        const { app } = await boot(undefined);
        const response = await app.inject({ method: 'GET', url: '/api/repos' });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().repos).toEqual([]);
        expect(response.json().meta.error).toBeNull();
    });

    it('serves the last good list with a named error when a refresh fails', async () => {
        // Same rule /api/stats follows. An empty picker and an unreachable GitHub look identical
        // otherwise, and only one of them is somebody's fault.
        let fail = false;
        const client = stubAppClient(async () => {
            if (fail) throw new Error('connect ECONNREFUSED');
            return listing();
        });
        const { app, repos } = await boot(client);

        await app.inject({ method: 'GET', url: '/api/repos' });
        fail = true;
        // Past the ten-minute list TTL, so the next read actually attempts a refresh.
        const stale = createRepoSource({ client, ttlMs: 0 });
        await stale.list().catch(() => {});

        expect(repos.snapshot()).toHaveLength(2);
    });

    it('names the failure rather than reporting an empty installation', async () => {
        const repos = createRepoSource({
            client: stubAppClient(async () => {
                throw new Error('boom');
            }),
        });
        await repos.list();
        expect(repos.lastError()).toMatch(/boom/);
        expect(repos.snapshot()).toEqual([]);
    });
});

describe('the repo source', () => {
    it('falls back to the repos already stored when there is no App client', async () => {
        // What keeps a seeded database browsable with no credential: every stored read is scoped BY
        // the repo list, so without an answer a warm database renders as an empty dashboard.
        const repos = createRepoSource({ stored: async () => ['acme/web', 'other-owner/api'] });
        await expect(repos.list()).resolves.toEqual([
            { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
            { owner: 'other-owner', name: 'api', private: false, defaultBranch: null, pushedAt: null },
        ]);
        expect(repos.snapshotNames()).toEqual(['acme/web', 'other-owner/api']);
    });

    it('never blocks in snapshot(), because current() is synchronous by design', async () => {
        const repos = createRepoSource({ stored: async () => ['acme/web'] });
        // Empty until something has loaded one. current() aggregates an already-fetched payload
        // over a date range and must never become a fetch.
        expect(repos.snapshot()).toEqual([]);
        await repos.list();
        expect(repos.snapshot()).toHaveLength(1);
    });

    it('skips a stored name that is not owner/name rather than building a bad path', async () => {
        const repos = createRepoSource({ stored: async () => ['acme/web', 'nameless', 'trailing/'] });
        await expect(repos.list()).resolves.toEqual([
            { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
        ]);
    });
});

describe('GET /api/repos/:owner/:name/branches', () => {
    const HTTP_UNAVAILABLE = 503;
    type Lister = NonNullable<NonNullable<Parameters<typeof staticRegistry>[0]>['listBranches']>;

    async function bootBranches(listBranches?: Lister) {
        const config = testConfig();
        const repos = createRepoSource({ client: stubAppClient(async () => listing()) });
        const app = track(
            await buildApp({
                config,
                orgs: staticRegistry({ config, repos, telemetry: stubTelemetryClient(), listBranches }),
            })
        );
        return app;
    }
    const get = (app: Awaited<ReturnType<typeof bootBranches>>, query = '', repo = 'acme/web') =>
        app.inject({ method: 'GET', url: `/api/repos/${repo}/branches${query}` });

    it('lists branches with the default branch and cursor', async () => {
        const calls: unknown[] = [];
        const app = await bootBranches(async (repo, opts) => {
            calls.push([repo, opts]);
            return { names: ['main', 'dev'], cursor: 'c1' };
        });
        const response = await get(app);
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ branches: ['main', 'dev'], cursor: 'c1', defaultBranch: 'main' });
        expect(calls).toEqual([['acme/web', {}]]);
    });

    it('searches by prefix server-side', async () => {
        const calls: unknown[] = [];
        const app = await bootBranches(async (_repo, opts) => {
            calls.push(opts);
            return { names: ['feat/a'], cursor: null };
        });
        const response = await get(app, '?q=feat/');
        expect(response.json().branches).toEqual(['feat/a']);
        expect(calls).toEqual([{ query: 'feat/' }]);
    });

    it('round-trips the cursor to the next page', async () => {
        const calls: unknown[] = [];
        const app = await bootBranches(async (_repo, opts) => {
            calls.push(opts);
            return { names: [], cursor: null };
        });
        await get(app, '?q=f&cursor=abc_-1');
        expect(calls).toEqual([{ query: 'f', cursor: 'abc_-1' }]);
    });

    it('answers 400 BAD_BRANCH_CURSOR when the client refuses the cursor', async () => {
        const { BranchCursorError } = await import('../src/github/app-client.js');
        const app = await bootBranches(async () => {
            throw new BranchCursorError('cursor belongs to another query');
        });
        const response = await get(app, '?cursor=forged');
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_BRANCH_CURSOR');
    });

    it.each(['a..b', '%20x', '-x', 'a%20b', 'a%00b', 'x'.repeat(256)])(
        'answers 400 BAD_BRANCH_QUERY on %j',
        async (q) => {
            const app = await bootBranches(async () => ({ names: [], cursor: null }));
            const response = await get(app, `?q=${q}`);
            expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
            expect(response.json().code).toBe('BAD_BRANCH_QUERY');
        }
    );

    it('answers 503 BRANCHES_UNAVAILABLE when the read fails, never an empty list', async () => {
        const { GitHubReadError } = await import('../src/github/pr-read.js');
        const app = await bootBranches(async () => {
            throw new GitHubReadError('rate limited', 'rate_limited');
        });
        const response = await get(app);
        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(response.json().code).toBe('BRANCHES_UNAVAILABLE');
        expect(response.json().branches).toBeUndefined();
    });

    it('answers 503 on a board with no client', async () => {
        const app = await bootBranches(undefined);
        const response = await get(app);
        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(response.json().code).toBe('BRANCHES_UNAVAILABLE');
    });

    it('refuses a repo the installation cannot see', async () => {
        const app = await bootBranches(async () => ({ names: ['x'], cursor: null }));
        const response = await get(app, '', 'acme/hidden');
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('UNKNOWN_REPO');
    });

    it('refuses a repo GitHub answers 404 for as not visible', async () => {
        const { GitHubReadError } = await import('../src/github/pr-read.js');
        const app = await bootBranches(async () => {
            throw new GitHubReadError('gone', 'not_found');
        });
        const response = await get(app);
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('UNKNOWN_REPO');
    });

    it('answers 200 [] only when GitHub answered []', async () => {
        const app = await bootBranches(async () => ({ names: [], cursor: null }));
        const response = await get(app, '?q=zzz');
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ branches: [], cursor: null, defaultBranch: 'main' });
    });
});
