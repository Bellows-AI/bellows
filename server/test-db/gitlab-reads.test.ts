import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ForgeSource } from '../src/forge/forge-client.js';
import type { GitHubAppClient } from '../src/github/app-client.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { testSecretDeps } from './env-secrets-harness.js';
import {
    type Board,
    bearer,
    driverBearer,
    type Harness,
    HOST,
    type Org,
    resetHarness,
    startHarness,
} from './gitlab-board-harness.js';
import { useTestDb } from './harness.js';

/**
 * Every read through the forge boundary for a tracked GitLab repo (docs/gitlab.md): GitLab repositories are listed now,
 * and the board can read nothing from them yet, so each read answers unsupported-inconclusive — never GitHub's client,
 * and never a confirmed absence (an empty branch list, a missing branch, a skill the repository does not have, a
 * repository with no default branch). The GitHub client is a spy that fails the test when it is reached.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const UNAVAILABLE = 503;

let sql: Sql;
let h: Harness & { stop(): Promise<void> };
let board: Board;
let org: Org;
let grp: string;
let reached: string[];
let mints: string[];

/** A GitHub client that records every call and answers none: GitLab must never reach it. */
const spyForge = (): ForgeSource => ({
    github: {
        reads: new Proxy({} as GitHubAppClient, {
            get: (_target, name) => () => {
                reached.push(String(name));
                throw new Error('GitHub must not be reached for a GitLab repository');
            },
        }),
    },
});

beforeAll(async () => {
    if (!enabled) return;
    h = await startHarness(() => db.sql);
});
beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    reached = [];
    await resetHarness(h, sql);
    org = await h.newOrg();
    grp = `g${randomUUID().slice(0, 8)}`;
    await createUserExecutorStore({ sql, orgId: org.id, ...testSecretDeps(sql) }).createOrg({
        name: 'main',
        type: 'claude-code',
        config: {},
        createdBy: org.adminId,
    });
    mints = [];
    board = await h.board({
        forge: spyForge(),
        githubMint: async (...args) => {
            mints.push(args.join(':'));
            return null;
        },
    });
    await h.fake.control('gitlab/projects', { path: `${grp}/web` });
    const id = await h.connect(org, { groups: [grp] });
    expect((await board.activate(org, id)).result).toBe('activated');
    expect((await board.link(org, id, 'dev-one')).result).toBe('linked');
    const picked = await board.app.inject({
        method: 'PUT',
        url: `/api/org/gitlab-connections/${id}/tracked-repos`,
        headers: bearer(org.admin),
        payload: { paths: [`${grp}/web`] },
    });
    expect(picked.statusCode).toBe(OK);
});
afterEach(async () => {
    if (enabled) await board?.close();
});
afterAll(async () => {
    await h?.stop();
});

const ref = () => ({ forge: 'gitlab', host: HOST, path: `${grp}/web` });
const repoId = () => `gitlab:${HOST}/${grp}/web`;
const get = (url: string) => board.app.inject({ method: 'GET', url, headers: bearer(org.member) });
const post = (url: string, payload: object) =>
    board.app.inject({ method: 'POST', url, headers: bearer(org.member), payload });
/** The fake GitLab's own API calls other than the member's project access check: any is a read the board should not make yet. */
const repositoryReads = () =>
    h.fake.forge
        .calls()
        .filter((call) => call.path.startsWith('/api/v4/projects/') && !/^\/api\/v4\/projects\/[^/]+$/.test(call.path));

describe.skipIf(!enabled)('reads of a tracked GitLab repository', () => {
    it('lists it, with no claim about what the board has not read', async () => {
        const listed = (await get('/api/repos')).json<{ repos: { id: string; defaultBranch: string | null }[] }>();
        expect(listed.repos.find((r) => r.id === repoId())).toMatchObject({ defaultBranch: null });
        expect(reached).toEqual([]);
    });

    it('answers 503 BRANCHES_UNAVAILABLE to a branch listing: never an empty list, never "unknown repo"', async () => {
        const res = await get(`/api/repos/${encodeURIComponent(repoId())}/branches`);
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'BRANCHES_UNAVAILABLE' });
        expect(reached).toEqual([]);
        expect(repositoryReads()).toEqual([]);
    });

    it('lists the repository’s skills as unconfirmed, never as none', async () => {
        const res = await get(`/api/repos/${encodeURIComponent(repoId())}/skills`);
        expect(res.statusCode).toBe(OK);
        const body = res.json<{ repoError: string | null; complete: boolean; unreadable: unknown[] }>();
        expect(body.repoError).not.toBeNull();
        expect(body.complete).toBe(false);
        expect(reached).toEqual([]);
        expect(repositoryReads()).toEqual([]);
    });

    it('accepts a create whose base branch or skills it cannot check, instead of refusing them as absent', async () => {
        const res = await post('/api/jobs', {
            repo: ref(),
            command: 'work',
            baseBranch: 'feature/not-checked',
            skills: ['a-repo-skill'],
        });
        expect([200, 201, 202]).toContain(res.statusCode);
        expect(reached).toEqual([]);
        expect(repositoryReads()).toEqual([]);
    });

    it('preflights the repository as listed, its skills as unverified and nothing as blocked by an unread branch', async () => {
        const res = await post('/api/jobs/preflight', {
            repo: ref(),
            baseBranch: 'feature/not-checked',
            skills: ['a-repo-skill'],
        });
        expect(res.statusCode).toBe(OK);
        const { checks } = res.json<{ checks: { subject: string; status: string }[] }>();
        expect(checks.find((c) => c.subject === 'repo')).toMatchObject({ status: 'ok' });
        expect(checks.filter((c) => c.status === 'blocked')).toEqual([]);
        expect(reached).toEqual([]);
        expect(repositoryReads()).toEqual([]);
    });

    it('answers a batch launch with 503, not with "reports no default branch"', async () => {
        const plan = {
            planVersion: 1,
            title: 'One repo',
            targets: [{ key: 'web', repo: ref() }],
            defaultTarget: 'web',
            stages: [
                {
                    key: 'one',
                    tasks: [{ key: 'a', objective: 'do a', acceptance: 'it works', verification: 'npm test' }],
                },
            ],
        };
        const drafted = await post('/api/batches', { plan });
        expect(drafted.statusCode, drafted.body).toBe(201);
        const { id } = drafted.json<{ id: string }>();
        for (const [url, payload] of [
            [`/api/batches/${id}/validate`, {}],
            [`/api/batches/${id}/start`, { version: 1 }],
        ] as const) {
            const res = await post(url, payload);
            expect(res.statusCode, `${url}: ${res.body}`).toBe(UNAVAILABLE);
            expect(res.json()).not.toMatchObject({ code: 'BATCH_NO_DEFAULT_BRANCH' });
        }
        const [jobs] = await sql<{ count: string }[]>`select count(*) from job where org_id = ${org.id}`;
        expect(Number(jobs?.count)).toBe(0);
        expect(reached).toEqual([]);
        expect(repositoryReads()).toEqual([]);
    });

    it('answers the runner’s GitHub token request for a GitLab attempt with a refusal, never a mint for a same-named GitHub repository', async () => {
        const { id, claim } = await board.running(org, ref());
        const res = await board.app.inject({
            method: 'POST',
            url: `/api/jobs/${id}/credentials/github`,
            headers: { 'x-factory-job-id': id, 'x-factory-job-lease-token': claim.leaseToken },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
        expect(mints).toEqual([]);
        expect(reached).toEqual([]);
    });

    it('answers the driver’s pull request write for a GitLab attempt with 503: nothing is written, none is concluded, no wait is opened', async () => {
        const { id, claim } = await board.running(org, ref());
        const res = await board.app.inject({
            method: 'POST',
            url: `/api/jobs/${id}/pull-request`,
            headers: { ...driverBearer, 'content-type': 'application/json' },
            payload: { leaseToken: claim.leaseToken, branch: 'task/one', base: 'main' },
        });
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE' });
        const [waits] = await sql<
            { count: string }[]
        >`select count(*) from job_integration_requirement where root_job_id = ${id}`;
        expect(Number(waits?.count)).toBe(0);
        expect(reached).toEqual([]);
        expect(repositoryReads()).toEqual([]);
    });
});
