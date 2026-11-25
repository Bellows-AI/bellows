import { githubRepo, parseRepoRef, type RepoRef } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import {
    BRANCH_UNCHECKED,
    readBranchHead,
    resolveForgeClient,
    INSTALLATION_CREDENTIAL,
} from '../src/forge/forge-client.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import { effectiveCatalog, standingOf } from '../src/skill-catalog.js';
import { githubForge } from './helpers-forge.js';
import { trackApps } from './helpers-http.js';
import { jobStoreSlice, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

/**
 * The callers that read a repository's forge, with the same path on github.com and on another forge or host: each
 * ref goes only to its own forge, and a ref no client answers for is inconclusive (never an empty list, a 404,
 * "no skills" or a missing branch) with no GitHub request. A listed repo is GitHub's (`RepoSource` lists
 * `owner/name`), so routes that check tracking refuse the twin first; the readers' own behaviour is pinned below them.
 */
const track = trackApps();
const GITHUB = githubRepo('acme/web');
const GITLAB = parseRepoRef('gitlab:gitlab.example.test/acme/web')!;
const ENTERPRISE = parseRepoRef('github:ghe.example.test/acme/web')!;
const TWINS: readonly RepoRef[] = [GITLAB, ENTERPRISE];
const idOf = (ref: RepoRef) => encodeURIComponent(ref === GITHUB ? 'acme/web' : `${ref.forge}:${ref.host}/${ref.path}`);

const skillRead = { revision: 'r', skills: [], unreadable: [], complete: true };

/** Every GitHub read a test might trigger, recording the path it was asked for. */
function spies() {
    const calls: string[] = [];
    return {
        calls,
        reads: {
            readBranchHead: async (repo: string, branch: string) => {
                calls.push(`head ${repo}@${branch}`);
                return 'sha';
            },
            listBranches: async (repo: string) => {
                calls.push(`branches ${repo}`);
                return { names: ['main'], cursor: null };
            },
            listRepoSkills: async (repo: string) => {
                calls.push(`skills ${repo}`);
                return skillRead;
            },
            readFileAtBranchTip: async (repo: string) => {
                calls.push(`file ${repo}`);
                return null;
            },
        },
    };
}

describe('the forge readers, by complete repo ref', () => {
    it('sends each of two repos sharing a path only to its own forge', async () => {
        const { calls, reads } = spies();
        const forge = githubForge(reads);
        expect(await readBranchHead(forge, GITHUB, 'main')).toBe('sha');
        for (const twin of TWINS) {
            expect(await readBranchHead(forge, twin, 'main')).toBe(BRANCH_UNCHECKED);
            expect(resolveForgeClient(forge, twin, INSTALLATION_CREDENTIAL)).toMatchObject({
                ok: false,
                reason: 'unsupported',
                forge: twin.forge,
                host: twin.host,
            });
        }
        const client = resolveForgeClient(forge, GITHUB, INSTALLATION_CREDENTIAL);
        if (!client.ok) throw new Error('github.com resolves');
        await client.client.listBranches({});
        await client.client.listSkills(null, []);
        await client.client.readFile(null, 'x');
        // Only the github.com repo was asked, and by its own path.
        expect(calls).toEqual(['head acme/web@main', 'branches acme/web', 'skills acme/web', 'file acme/web']);
    });

    it('answers unchecked, which is no evidence of absence, when the board holds no forge at all', async () => {
        expect(await readBranchHead(undefined, GITHUB, 'main')).toBe(BRANCH_UNCHECKED);
    });

    it.each(TWINS)('reads no skills for %j through GitHub and says so as unconfirmed', async (twin) => {
        const { calls, reads } = spies();
        const catalog = await effectiveCatalog({
            builtin: [],
            forge: githubForge(reads),
            repo: twin,
            branch: null,
            executorType: { state: 'known', type: null },
            need: ['deploy'],
        });
        expect(calls).toEqual([]);
        expect(catalog.repo.state).toBe('unconfirmed');
        expect(standingOf(catalog, 'deploy')).toBe('unverified');
    });
});

describe('the routes that read a forge, with a twin of a tracked path', () => {
    async function boot(reads: ReturnType<typeof spies>['reads']) {
        const created: unknown[] = [];
        const jobs = jobStoreSlice<JobStore>({
            create: async (...args: unknown[]) => {
                created.push(args);
                return { id: '11111111-1111-4111-8111-111111111111' };
            },
        });
        const config = testConfig();
        const app: FastifyInstance = await buildApp({
            config,
            orgs: staticRegistry({
                config,
                jobs,
                telemetry: stubTelemetryClient(),
                repos: staticRepoSource([{ owner: 'acme', name: 'web' }]),
                branchHead: reads.readBranchHead,
                listBranches: reads.listBranches,
                repoSkills: reads.listRepoSkills,
            }),
        });
        track(app);
        return { app, created };
    }

    it('lists branches and skills of the github.com repo, and refuses each twin without a GitHub request', async () => {
        const { calls, reads } = spies();
        const { app } = await boot(reads);
        expect((await app.inject({ method: 'GET', url: `/api/repos/${idOf(GITHUB)}/branches` })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: `/api/repos/${idOf(GITHUB)}/skills` })).statusCode).toBe(200);
        expect(calls).toEqual(['branches acme/web', 'skills acme/web']);
        for (const twin of TWINS) {
            for (const what of ['branches', 'skills']) {
                const res = await app.inject({ method: 'GET', url: `/api/repos/${idOf(twin)}/${what}` });
                // Not the GitHub repo's answer, and not an empty one: a refusal (untracked) or unavailable.
                expect([400, 503]).toContain(res.statusCode);
                expect(res.json()).not.toHaveProperty('branches');
                expect(res.json()).not.toHaveProperty('skills');
            }
        }
        expect(calls).toEqual(['branches acme/web', 'skills acme/web']);
    });

    it('checks the create base branch on github.com only, and never a twin through GitHub', async () => {
        const { calls, reads } = spies();
        const { app, created } = await boot(reads);
        const post = (repo: RepoRef) =>
            app.inject({ method: 'POST', url: '/api/jobs', payload: { repo, command: 'echo hi', baseBranch: 'dev' } });
        expect((await post(GITHUB)).statusCode).toBe(201);
        expect(calls).toEqual(['head acme/web@dev']);
        for (const twin of TWINS) {
            const res = await post(twin);
            expect(res.statusCode).toBe(400);
            expect(res.json().code).toBe('UNKNOWN_REPO');
        }
        expect(calls).toEqual(['head acme/web@dev']);
        expect(created).toHaveLength(1);
    });

    it('resolves the create skill names against github.com only, and never reads a twin through GitHub', async () => {
        const { calls, reads } = spies();
        const { app } = await boot(reads);
        const post = (repo: RepoRef) =>
            app.inject({ method: 'POST', url: '/api/jobs', payload: { repo, command: 'echo hi', skills: ['deploy'] } });
        // github.com: the read confirms the repo ships no `deploy`, so the name is unknown (a confirmed absence).
        expect((await post(GITHUB)).json().code).toBe('UNKNOWN_SKILL');
        expect(calls).toEqual(['skills acme/web']);
        for (const twin of TWINS) {
            const res = await post(twin);
            expect(res.statusCode).toBe(400);
            expect(res.json().code).toBe('UNKNOWN_REPO');
        }
        expect(calls).toEqual(['skills acme/web']);
    });
});
