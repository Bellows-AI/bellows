import { githubRepo, parseRepoRef, type RepoRef } from '@factory-ai/core';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { ListedWithRef } from './helpers-listed-refs.js';
import { trackApps } from './helpers-http.js';
import { jobStoreSlice, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

vi.mock('../src/forge/forges.js', async (importOriginal) =>
    (await import('./helpers-listed-refs.js')).listedRefsMock(importOriginal as never)
);

/**
 * The routes' forge reads BELOW the tracking check, with a GitLab repo listed beside the github.com repo at the same
 * path: each ref goes only to its own forge, GitHub sees nothing for the GitLab one, and each caller answers as it does
 * for any read it could not confirm (accepts, unverified, unavailable) — never an empty list, 404 or "absent".
 */
const track = trackApps();
const GITHUB = githubRepo('acme/web');
const GITLAB = parseRepoRef('gitlab:gitlab.example.test/acme/web')!;
const idOf = (ref: RepoRef) =>
    encodeURIComponent(ref.forge === 'github' ? ref.path : `${ref.forge}:${ref.host}/${ref.path}`);
const LISTED: ListedWithRef[] = [
    { owner: 'acme', name: 'web' },
    { owner: 'acme', name: 'web', ref: GITLAB },
];
const skillRead = { revision: 'r', skills: [], unreadable: [], complete: true };

function boot() {
    const calls: string[] = [];
    const created: unknown[] = [];
    const jobs = jobStoreSlice<JobStore>({
        create: async (...args: unknown[]) => {
            created.push(args);
            return { id: '11111111-1111-4111-8111-111111111111' };
        },
    });
    const config = testConfig();
    const source = staticRepoSource([{ owner: 'acme', name: 'web' }]);
    const repos = {
        ...source,
        detail: async () => ({
            repos: LISTED.map((entry) => ({ ...entry, private: false, defaultBranch: 'main', pushedAt: null })),
            installation: null,
            error: null,
        }),
    };
    const app = buildApp({
        config,
        orgs: staticRegistry({
            config,
            jobs,
            telemetry: stubTelemetryClient(),
            repos,
            branchHead: async (repo, branch) => {
                calls.push(`head ${repo}@${branch}`);
                return 'sha';
            },
            listBranches: async (repo) => {
                calls.push(`branches ${repo}`);
                return { names: ['main'], cursor: null };
            },
            repoSkills: async (repo) => {
                calls.push(`skills ${repo}`);
                return skillRead;
            },
        }),
    }).then((instance: FastifyInstance) => track(instance));
    return { app, calls, created };
}

const create = (app: FastifyInstance, repo: RepoRef, extra: object) =>
    app.inject({ method: 'POST', url: '/api/jobs', payload: { repo, command: 'echo hi', ...extra } });

describe('POST /api/jobs: the create-time reads', () => {
    it('checks the base branch on github.com by its own path; a GitLab repo is unchecked and accepted, GitHub unasked', async () => {
        const { app: pending, calls, created } = boot();
        const app = await pending;
        expect((await create(app, GITHUB, { baseBranch: 'dev' })).statusCode).toBe(201);
        expect(calls).toEqual(['head acme/web@dev']);
        // Inconclusive, not "absent": the create is accepted and the claim-time check is the backstop.
        expect((await create(app, GITLAB, { baseBranch: 'dev' })).statusCode).toBe(201);
        expect(calls).toEqual(['head acme/web@dev']);
        expect(created).toHaveLength(2);
    });

    it('reads skill names on github.com only; a GitLab repo is unverified, so its names are accepted, GitHub unasked', async () => {
        const { app: pending, calls } = boot();
        const app = await pending;
        const own = await create(app, GITHUB, { skills: ['deploy'] });
        expect(own.statusCode).toBe(404);
        expect(own.json().code).toBe('UNKNOWN_SKILL');
        expect(calls).toEqual(['skills acme/web']);
        const twin = await create(app, GITLAB, { skills: ['deploy'] });
        expect(twin.statusCode).toBe(201);
        expect(calls).toEqual(['skills acme/web']);
    });
});

describe('the repo routes', () => {
    it('lists branches of github.com by its own path, and a GitLab repo is unavailable (503), never an empty list', async () => {
        const { app: pending, calls } = boot();
        const app = await pending;
        const own = await app.inject({ method: 'GET', url: `/api/repos/${idOf(GITHUB)}/branches` });
        expect(own.statusCode).toBe(200);
        expect(own.json().branches).toEqual(['main']);
        const twin = await app.inject({ method: 'GET', url: `/api/repos/${idOf(GITLAB)}/branches` });
        expect(twin.statusCode).toBe(503);
        expect(twin.json().code).toBe('BRANCHES_UNAVAILABLE');
        expect(calls).toEqual(['branches acme/web']);
    });

    it('lists skills of github.com by its own path, and a GitLab repo reports a repoError, never "no skills"', async () => {
        const { app: pending, calls } = boot();
        const app = await pending;
        const own = (await app.inject({ method: 'GET', url: `/api/repos/${idOf(GITHUB)}/skills` })).json();
        expect(own.repoError).toBeNull();
        expect(own.complete).toBe(true);
        const twin = (await app.inject({ method: 'GET', url: `/api/repos/${idOf(GITLAB)}/skills` })).json();
        expect(twin.repoError).toEqual(expect.any(String));
        expect(twin.complete).toBe(false);
        expect(calls).toEqual(['skills acme/web']);
    });
});
