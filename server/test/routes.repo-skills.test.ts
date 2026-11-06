import { READ_FORBIDDEN } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { GitHubReadError } from '../src/github/pr-read.js';
import { createRepoSource } from '../src/github/repo-source.js';
import { skillCatalog } from '../src/skills.js';
import { staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import { listingClient } from './helpers-app-client.js';
import { HTTP_BAD_REQUEST, HTTP_OK, trackApps } from './helpers-http.js';

const track = trackApps();
type Reader = NonNullable<NonNullable<Parameters<typeof staticRegistry>[0]>['repoSkills']>;

async function boot(repoSkills?: Reader) {
    const config = testConfig();
    const client = listingClient(async () => ({
        repos: [{ owner: 'acme', name: 'web', private: true, defaultBranch: 'main', pushedAt: null }],
        installation: { id: '1', account: 'acme', repositorySelection: 'selected' },
    }));
    const repos = createRepoSource({ client });
    return track(
        await buildApp({
            config,
            orgs: staticRegistry({ config, repos, telemetry: stubTelemetryClient(), repoSkills }),
        })
    );
}
const get = (app: Awaited<ReturnType<typeof boot>>, query = '') =>
    app.inject({ method: 'GET', url: `/api/repos/acme/web/skills${query}` });
const builtinNames = () => skillCatalog().map((s) => s.name);

describe('GET /api/repos/:owner/:name/skills', () => {
    it('built-ins plus repo skills', async () => {
        const calls: unknown[] = [];
        const app = await boot(async (repo, branch) => {
            calls.push([repo, branch]);
            return { revision: 'r', skills: [{ name: 'deploy', description: 'Ship it' }], unreadable: ['bad'] };
        });
        const response = await get(app, '?branch=dev');
        expect(response.statusCode).toBe(HTTP_OK);
        const body = response.json();
        expect(body.repoError).toBeNull();
        expect(body.unreadable).toEqual(['bad']);
        expect(
            body.skills.filter((s: { source: string }) => s.source === 'builtin').map((s: { name: string }) => s.name)
        ).toEqual(builtinNames());
        expect(body.skills).toContainEqual({ name: 'deploy', description: 'Ship it', source: 'repo' });
        expect(calls).toEqual([['acme/web', 'dev']]);
    });

    it('no branch reads the default branch', async () => {
        const calls: unknown[] = [];
        const app = await boot(async (repo, branch) => {
            calls.push([repo, branch]);
            return { revision: 'r', skills: [], unreadable: [] };
        });
        expect((await get(app)).statusCode).toBe(HTTP_OK);
        expect(calls).toEqual([['acme/web', null]]);
    });

    it('repo read fails → built-ins + repoError, 200', async () => {
        const app = await boot(async () => {
            throw new GitHubReadError('forbidden', READ_FORBIDDEN);
        });
        const response = await get(app);
        expect(response.statusCode).toBe(HTTP_OK);
        const body = response.json();
        expect(body.repoError).toEqual(expect.stringContaining('forbidden'));
        expect(body.skills.map((s: { name: string }) => s.name)).toEqual(builtinNames());
        expect(body.skills.every((s: { source: string }) => s.source === 'builtin')).toBe(true);
    });

    it('no client → built-ins + repoError', async () => {
        const response = await get(await boot(undefined));
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().repoError).not.toBeNull();
        expect(response.json().skills.map((s: { name: string }) => s.name)).toEqual(builtinNames());
    });

    it('builtin wins a name collision', async () => {
        const app = await boot(async () => ({
            revision: 'r',
            skills: [{ name: 'factory-gates', description: 'impostor' }],
            unreadable: [],
        }));
        const body = (await get(app)).json();
        const gates = body.skills.filter((s: { name: string }) => s.name === 'factory-gates');
        expect(gates).toHaveLength(1);
        expect(gates[0].source).toBe('builtin');
    });

    it('400 on a bad branch', async () => {
        const app = await boot(async () => ({ revision: 'r', skills: [], unreadable: [] }));
        const response = await get(app, '?branch=a..b');
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_BASE_BRANCH');
    });
});
