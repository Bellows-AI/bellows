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
            return {
                revision: 'r',
                skills: [{ name: 'deploy', description: 'Ship it' }],
                unreadable: ['bad'],
                complete: true,
            };
        });
        const response = await get(app, '?branch=dev');
        expect(response.statusCode).toBe(HTTP_OK);
        const body = response.json();
        expect(body.repoError).toBeNull();
        expect(body.unreadable).toEqual(['bad']);
        expect(
            body.skills.filter((s: { source: string }) => s.source === 'builtin').map((s: { name: string }) => s.name)
        ).toEqual(builtinNames());
        expect(body.skills).toContainEqual({
            name: 'deploy',
            description: 'Ship it',
            source: 'repo',
            requires: { tools: [], connections: [] },
        });
        expect(body.reserved).toEqual([]);
        expect(calls).toEqual([['acme/web', 'dev']]);
    });

    it('says whether the listing is complete: a cut read, a failed read and no reader are not', async () => {
        const cut = await boot(async () => ({ revision: 'r', skills: [], unreadable: [], complete: false }));
        expect((await get(cut)).json().complete).toBe(false);
        const whole = await boot(async () => ({ revision: 'r', skills: [], unreadable: [], complete: true }));
        expect((await get(whole)).json().complete).toBe(true);
        const failed = await boot(async () => {
            throw new GitHubReadError('forbidden', READ_FORBIDDEN);
        });
        expect((await get(failed)).json().complete).toBe(false);
        expect((await get(await boot(undefined))).json().complete).toBe(false);
    });

    it('no branch reads the default branch', async () => {
        const calls: unknown[] = [];
        const app = await boot(async (repo, branch) => {
            calls.push([repo, branch]);
            return { revision: 'r', skills: [], unreadable: [], complete: true };
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

    it('builtin wins a name collision: the repo entry is listed apart, under `shadowed`', async () => {
        const app = await boot(async () => ({
            revision: 'r',
            skills: [{ name: 'factory-gates', description: 'impostor' }],
            unreadable: [],
            complete: true,
        }));
        const body = (await get(app)).json();
        const gates = body.skills.filter((s: { name: string }) => s.name === 'factory-gates');
        expect(gates.map((s: { source: string; shadowedBy?: string }) => [s.source, s.shadowedBy])).toEqual([
            ['builtin', undefined],
        ]);
        expect(body.shadowed).toEqual([
            { name: 'factory-gates', description: 'impostor', source: 'repo', shadowedBy: 'builtin' },
        ]);
    });

    it('a repo skill under the reserved prefix is not listed, only named under `reserved`', async () => {
        const app = await boot(async () => ({
            revision: 'r',
            skills: [
                { name: 'factory-mine', description: 'x' },
                { name: 'plain', description: 'y' },
            ],
            unreadable: [],
            complete: true,
        }));
        const body = (await get(app)).json();
        expect(body.reserved).toEqual(['factory-mine']);
        const names = body.skills.map((s: { name: string }) => s.name);
        expect(names).not.toContain('factory-mine');
        expect(names).toContain('plain');
    });

    it('400 on a bad branch', async () => {
        const app = await boot(async () => ({ revision: 'r', skills: [], unreadable: [], complete: true }));
        const response = await get(app, '?branch=a..b');
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_BASE_BRANCH');
    });
});
