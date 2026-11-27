import { randomUUID } from 'node:crypto';
import { gitlabForgeOf, type RepoRef } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBatchPrObserver, type BatchPrObserverDeps, type ReadPause } from '../src/batch-pr-observer.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import type { ForgeSource } from '../src/forge/forge-client.js';
import { gitlabAccessOf } from '../src/forge/forge-gate.js';
import type { GitlabReads } from '../src/forge/forge-reads.js';
import { FORGE_READ_DEADLINE_MS } from '../src/forge/gitlab-reads.js';
import type { GitHubAppClient } from '../src/github/app-client.js';
import { createPrFollower } from '../src/pr-follower.js';
import { rootOf, setSucceeded } from './batch-fixtures.js';
import { testSecretDeps } from './env-secrets-harness.js';
import {
    type Board,
    bearer,
    type Harness,
    HOST,
    type Org,
    resetHarness,
    startHarness,
} from './gitlab-board-harness.js';
import { useTestDb } from './harness.js';

/**
 * The batch observer and the PR follower read a GitLab merge request as the task's starter (docs/gitlab.md), and a
 * GitLab batch launches: the real routes, board registry, grants, stores and pollers over the fake GitLab. An unread
 * grant, a deleted starter, a missing connection or a failed read is never a verdict about the merge request: the
 * observation keeps its last assessment and records `transport`. GitHub is a spy that fails the test when reached.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const CONFLICT = 409;
const UNAVAILABLE = 503;
const MEMBER = 'dev-one';
const OTHER_MEMBER = 'dev-two';
const FORGE = gitlabForgeOf(HOST);
const COMPRESSED_DEADLINE_MS = 300;

let sql: Sql;
let h: Harness & { stop(): Promise<void> };
let board: Board;
let org: Org;
let connectionId: string;
let grp: string;
let reached: string[];
let counter = 0;

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
    board = await h.board({ forge: spyForge() });
    await h.fake.control('gitlab/projects', { path: project(), defaultBranch: 'trunk', files: { 'README.md': 'x\n' } });
    connectionId = await h.connect(org, { groups: [grp] });
    expect((await board.activate(org, connectionId)).result).toBe('activated');
    expect((await board.link(org, connectionId, MEMBER)).result).toBe('linked');
    expect((await board.link(org, connectionId, OTHER_MEMBER, org.admin)).result).toBe('linked');
    const picked = await board.app.inject({
        method: 'PUT',
        url: `/api/org/gitlab-connections/${connectionId}/tracked-repos`,
        headers: bearer(org.admin),
        payload: { paths: [project()] },
    });
    expect(picked.statusCode).toBe(OK);
});
afterEach(async () => {
    if (enabled) await board?.close();
});
afterAll(async () => {
    await h?.stop();
});

const project = () => `${grp}/web`;
const ref = (): RepoRef => ({ forge: 'gitlab', host: HOST, path: project() });
const api = () => `/api/v4/projects/${encodeURIComponent(project())}`;
const post = (url: string, payload: object, token = org.member) =>
    board.app.inject({ method: 'POST', url, headers: bearer(token), payload });
const runtime = async () => {
    const found = await board.replica.orgs.for(org.id);
    if (!found?.batches || !found.jobs || !found.prs) throw new Error('the org has no stores');
    return { ...found, batches: found.batches, jobs: found.jobs, prs: found.prs };
};
const tokenOf = async (userId: string) =>
    ((await board.grants.accessToken(org.id, userId, FORGE)) as { accessToken: string }).accessToken;
/** The fake's calls on the project made after `mark`. */
const callsSince = (mark: number) =>
    h.fake.forge
        .calls()
        .slice(mark)
        .filter((call) => call.path.includes(encodeURIComponent(project())));
const mark = () => h.fake.forge.calls().length;
const breakGrant = (userId = org.memberId) =>
    sql`update integration_grant set status = 'reconnect_required' where org_id = ${org.id}
        and principal_user_id = ${userId}`;
const fault = (body: object) => h.fake.control('gitlab/faults', body);

const reads = (): GitlabReads => ({
    gitlab: gitlabAccessOf(board.replica.orgs, board.replica.api),
    memberGrants: board.grants,
});

/** An MR from a fresh branch on the fake, opened as the member; `green` seeds a passing head pipeline. */
async function openMr({ green = true }: { green?: boolean } = {}) {
    counter += 1;
    const branch = `task/b${counter}`;
    await h.fake.control('gitlab/commit', { project: project(), branch, files: { [`${branch}.txt`]: 'x\n' } });
    const created = await h.fake.send('POST', `${api()}/merge_requests`, {
        token: await tokenOf(org.memberId),
        body: { source_branch: branch, target_branch: 'trunk', title: 'Add it' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { iid, web_url: webUrl, sha } = created.body as { iid: number; web_url: string; sha: string };
    if (green) await pipeline({ branch, iid, jobs: [{ name: 'test', status: 'success' }] });
    // `webUrl` is what the instance reports; the thread's publication records the https address of the merge request.
    return { branch, iid, webUrl, sha, url: `https://${HOST}/${project()}/-/merge_requests/${iid}` };
}
const pipeline = (seed: { branch: string; iid: number; jobs: { name: string; status: string }[] }) =>
    h.fake.control('gitlab/pipelines', { project: project(), ref: seed.branch, jobs: seed.jobs, headOf: seed.iid });
const mrAs = (token: string, method: 'PUT' | 'GET', path: string, body?: object) =>
    h.fake.send(method, `${api()}/merge_requests/${path}`, { token, ...(body ? { body } : {}) });

const planOf = (policy: 'human' | 'automerge' = 'human') => ({
    planVersion: 1,
    title: 'One repo',
    targets: [{ key: 'web', repo: ref() }],
    defaultTarget: 'web',
    stages: [
        {
            key: 'one',
            policy,
            tasks: [
                {
                    key: 'a',
                    objective: 'do a',
                    acceptance: 'it works',
                    verification: 'npm test',
                    completion: { kind: 'pr' },
                },
            ],
        },
    ],
});
const draft = async (policy: 'human' | 'automerge' = 'human') => {
    const drafted = await post('/api/batches', { plan: planOf(policy) });
    expect(drafted.statusCode, drafted.body).toBe(201);
    return drafted.json<{ id: string }>().id;
};

/** A started batch whose one task succeeded and published `mr` (the board's own launch, then the thread's publication). */
async function startedWith(mr: { iid: number; url: string; branch: string }, policy: 'human' | 'automerge' = 'human') {
    const id = await draft(policy);
    const started = await post(`/api/batches/${id}/start`, { version: 1 });
    expect(started.statusCode, started.body).toBe(OK);
    const { batches, prs } = await runtime();
    await batches.reconcile(id);
    const root = await rootOf(batches, id, 'a');
    await prs.recordPublication({
        root,
        repo: project(),
        prNumber: mr.iid,
        prUrl: mr.url,
        headBranch: mr.branch,
        baseBranch: 'trunk',
    });
    await setSucceeded(sql, root);
    await batches.reconcile(id);
    return { id, root };
}

/** An observer over the batch rows with the deps a case replaces; the same recorders the org registry builds. */
async function observer(extra: Partial<BatchPrObserverDeps> = {}) {
    const { batches, jobs } = await runtime();
    return createBatchPrObserver({
        sql,
        orgId: org.id,
        forge: spyForge(),
        gitlab: reads(),
        recordMerge: (repo, number, deliveryId, mergedAt) => jobs.closeMergedPr(repo, number, deliveryId, mergedAt),
        reconcile: (id) => batches.reconcile(id),
        ...extra,
    });
}
const observation = async (id: string) =>
    (
        await sql<
            {
                outcome: string | null;
                checks: string | null;
                pr_state: string | null;
                pr_url: string | null;
                error_code: string | null;
                error_detail: string | null;
                repairable: boolean;
                evidence: { name?: string }[];
            }[]
        >`select outcome, checks, pr_state, pr_url, error_code, error_detail, repairable, evidence
          from batch_pr_observation where org_id = ${org.id} and batch_id = ${id}`
    )[0];
const makeDue = () =>
    sql`update batch_pr_observation set next_refresh_at = now() - interval '1 second', claimed_until = null
        where org_id = ${org.id}`;
const prMerges = () =>
    sql<{ forge: string; host: string; repo: string; pr_number: number }[]>`
        select forge, host, repo, pr_number from pr_merge where org_id = ${org.id}`;

/** A batch whose MR is green and observed once as the member: the assessment later failures must keep. */
async function observedReady() {
    const mr = await openMr();
    const batch = await startedWith(mr);
    const watcher = await observer();
    expect(await watcher.observeDue()).toBe(1);
    expect(await observation(batch.id)).toMatchObject({ outcome: 'ready', error_code: null });
    return { ...batch, mr, watcher };
}

describe.skipIf(!enabled)('the batch observer reads a GitLab merge request as the starter', () => {
    it('records a green pipeline through the org registry, every request made as the member', async () => {
        const mr = await openMr();
        const batch = await startedWith(mr);
        const before = mark();
        const registry = await runtime();
        expect(await registry.batchObserver!.observeDue()).toBe(1);
        expect(await observation(batch.id)).toMatchObject({
            outcome: 'ready',
            checks: 'passing',
            pr_state: 'open',
            pr_url: mr.webUrl,
            error_code: null,
        });
        const made = callsSince(before);
        expect(made.length).toBeGreaterThan(0);
        expect(made.every((call) => call.holder === MEMBER)).toBe(true);
        expect(reached).toEqual([]);
    });

    it('records a failing job as checks_failing and repairable, naming the job', async () => {
        const mr = await openMr({ green: false });
        await pipeline({ ...mr, jobs: [{ name: 'lint', status: 'failed' }] });
        const batch = await startedWith(mr);
        await (await observer()).observeDue();
        const seen = await observation(batch.id);
        expect(seen).toMatchObject({ outcome: 'checks_failing', repairable: true });
        expect(JSON.stringify(seen?.evidence)).toContain('lint');
    });

    it('keeps the last assessment and records transport when the starter’s grant is broken, with no request', async () => {
        const { id, watcher } = await observedReady();
        await breakGrant();
        await makeDue();
        const before = mark();
        await watcher.observeDue();
        expect(callsSince(before)).toEqual([]);
        const seen = await observation(id);
        expect(seen).toMatchObject({ outcome: 'ready', pr_state: 'open', error_code: 'transport' });
        expect(seen?.error_detail).toMatch(/reconnect/i);
        expect(await prMerges()).toEqual([]);
    });

    it.each([
        ['a 500', { mode: 'status', status: 500, pathIncludes: '/jobs' }],
        ['a malformed answer', { mode: 'malformed', pathIncludes: '/jobs' }],
    ])('keeps the last assessment when a read fails with %s', async (_name, injected) => {
        const { id, watcher } = await observedReady();
        await fault(injected);
        await makeDue();
        await watcher.observeDue();
        expect(await observation(id)).toMatchObject({ outcome: 'ready', pr_state: 'open', error_code: 'transport' });
    });

    it('settles a read nobody answers within its deadline and keeps the last assessment', async () => {
        expect(COMPRESSED_DEADLINE_MS).toBeLessThan(FORGE_READ_DEADLINE_MS);
        const { id } = await observedReady();
        const watcher = await observer({ readDeadlineMs: COMPRESSED_DEADLINE_MS });
        await fault({ mode: 'timeout', pathIncludes: '/jobs' });
        await makeDue();
        const started = Date.now();
        await watcher.observeDue();
        expect(Date.now() - started).toBeLessThan(FORGE_READ_DEADLINE_MS);
        expect(await observation(id)).toMatchObject({ outcome: 'ready', pr_state: 'open', error_code: 'transport' });
    });

    it('keeps the last assessment when the starter no longer exists, with no request', async () => {
        const { id, watcher } = await observedReady();
        await sql`update batch set started_by = null where org_id = ${org.id} and id = ${id}`;
        await makeDue();
        const before = mark();
        await watcher.observeDue();
        expect(callsSince(before)).toEqual([]);
        const seen = await observation(id);
        expect(seen).toMatchObject({ outcome: 'ready', error_code: 'transport' });
        expect(seen?.error_detail).toContain('starter no longer exists');
    });

    it.each([
        ['removed', async () => null],
        ['inactive', async () => ({ active: false, caBundle: undefined })],
        [
            'unreadable',
            async () => {
                throw new Error('the connection store is down');
            },
        ],
    ])('keeps the last assessment when the connection is %s, with no request', async (_name, application) => {
        const { id } = await observedReady();
        const watcher = await observer({
            gitlab: {
                ...reads(),
                gitlab: { api: board.replica.api, connectionsOf: async () => ({ application }) as never },
            },
        });
        await makeDue();
        const before = mark();
        await watcher.observeDue();
        expect(callsSince(before)).toEqual([]);
        expect(await observation(id)).toMatchObject({ outcome: 'ready', error_code: 'transport' });
    });

    it('records a merge a person made for the GitLab triple only, and the gate judges it', async () => {
        const mr = await openMr();
        const batch = await startedWith(mr);
        await sql`insert into pr_merge (org_id, forge, host, repo, pr_number, delivery_id)
                  values (${org.id}, 'github', 'github.com', 'o/n', ${mr.iid}, 'other')`;
        const merged = await mrAs(await tokenOf(org.memberId), 'PUT', `${mr.iid}/merge`, { sha: mr.sha });
        expect(merged.status, JSON.stringify(merged.body)).toBe(OK);
        await (await observer()).observeDue();
        expect(await prMerges()).toEqual(
            expect.arrayContaining([
                { forge: 'gitlab', host: HOST, repo: project(), pr_number: mr.iid },
                { forge: 'github', host: 'github.com', repo: 'o/n', pr_number: mr.iid },
            ])
        );
        expect(await prMerges()).toHaveLength(2);
        expect(await observation(batch.id)).toMatchObject({ pr_state: 'merged' });
    });

    it('leaves a GitLab row binding with no request on a board with no member grants (AUTH_MODE=none)', async () => {
        const mr = await openMr();
        const batch = await startedWith(mr);
        const before = mark();
        await (await observer({ gitlab: undefined })).observeDue();
        expect(callsSince(before)).toEqual([]);
        expect(await observation(batch.id)).toMatchObject({ error_code: 'binding' });
    });

    it('does not let a GitLab member’s rate limit pause the installation’s reads', async () => {
        const mr = await openMr();
        const batch = await startedWith(mr);
        const noted: unknown[] = [];
        const pause: ReadPause = { open: () => true, note: (result) => noted.push(result) };
        await fault({ mode: 'status', status: 429, pathIncludes: '/merge_requests' });
        await (await observer({ pause })).observeDue();
        expect(await observation(batch.id)).toMatchObject({ error_code: 'rate_limited' });
        expect(noted).toEqual([]);
    });
});

describe.skipIf(!enabled)('task.ready carries the merge request URL', () => {
    const readyEvents = (url: string) =>
        sql<{ kind: string; forge: string; host: string; pr_url: string }[]>`
            select kind, forge, host, pr_url from notification_event
            where org_id = ${org.id} and kind = 'task.ready' and pr_url = ${url}`;

    it('is sent once for a green pipeline under a human stage', async () => {
        const mr = await openMr();
        await startedWith(mr);
        const watcher = await observer();
        await watcher.observeDue();
        expect(await readyEvents(mr.url)).toEqual([
            { kind: 'task.ready', forge: 'gitlab', host: HOST, pr_url: mr.url },
        ]);
    });

    it('is sent when the merge request needs a review', async () => {
        const mr = await openMr();
        await h.fake.control('gitlab/approvals', { project: project(), iid: mr.iid, required: 1 });
        const batch = await startedWith(mr);
        await (await observer()).observeDue();
        expect(await observation(batch.id)).toMatchObject({ outcome: 'review_required' });
        expect(await readyEvents(mr.url)).toHaveLength(1);
    });
});

describe.skipIf(!enabled)('the PR follower reads a GitLab merge request as the publishing thread’s starter', () => {
    /** A running thread of `token`'s member that published `mr`; the follower reads it (no batch). */
    async function threadOn(mr: { iid: number; url: string; branch: string }, token = org.member) {
        const created = await post('/api/jobs', { repo: ref(), command: 'work' }, token);
        expect(created.statusCode, created.body).toBe(201);
        const { jobs, prs } = await runtime();
        const claim = await jobs.claim('worker-1', 60);
        expect(claim?.id).toBe(created.json<{ id: string }>().id);
        const root = claim!.id;
        await prs.recordPublication({
            root,
            repo: project(),
            prNumber: mr.iid,
            prUrl: mr.url,
            headBranch: mr.branch,
            baseBranch: 'trunk',
        });
        return root;
    }
    const follower = async () => {
        const { jobs, prs } = await runtime();
        return createPrFollower({
            sql,
            orgId: org.id,
            gitlab: reads(),
            prs,
            spreadMs: 0,
            recordMerge: (repo, number, deliveryId, mergedAt) => jobs.closeMergedPr(repo, number, deliveryId, mergedAt),
        });
    };
    const followRow = () =>
        sql<{ error_code: string | null; failures: number }[]>`
            select error_code, failures from pr_follow where org_id = ${org.id}`;

    it('records a merge a person made and closes the thread', async () => {
        const mr = await openMr();
        await threadOn(mr);
        await mrAs(await tokenOf(org.memberId), 'PUT', `${mr.iid}/merge`, { sha: mr.sha });
        expect(await (await follower()).observeDue()).toBe(1);
        expect(await prMerges()).toEqual([{ forge: 'gitlab', host: HOST, repo: project(), pr_number: mr.iid }]);
    });

    it('cancels the open wait of a merge request closed unmerged', async () => {
        const mr = await openMr();
        const root = await threadOn(mr);
        const { prs } = await runtime();
        await prs.enterWait({ root, reason: 'review', repo: ref(), prNumber: mr.iid });
        await mrAs(await tokenOf(org.memberId), 'PUT', `${mr.iid}`, { state_event: 'close' });
        await (await follower()).observeDue();
        const [wait] = await sql<{ cancelled_at: Date | null }[]>`
            select cancelled_at from workflow_wait where org_id = ${org.id} and root_job_id = ${root}`;
        expect(wait?.cancelled_at).not.toBeNull();
    });

    it('changes nothing and backs off with transport when the grant is broken', async () => {
        const mr = await openMr();
        await threadOn(mr);
        await mrAs(await tokenOf(org.memberId), 'PUT', `${mr.iid}/merge`, { sha: mr.sha });
        await breakGrant();
        const before = mark();
        await (await follower()).observeDue();
        expect(callsSince(before)).toEqual([]);
        expect(await prMerges()).toEqual([]);
        expect(await followRow()).toEqual([{ error_code: 'transport', failures: 1 }]);
    });

    it('reads with the token of the thread’s own starter, never another member’s', async () => {
        const mr = await openMr();
        await threadOn(mr, org.admin);
        const before = mark();
        await (await follower()).observeDue();
        const made = callsSince(before);
        expect(made.length).toBeGreaterThan(0);
        expect(made.every((call) => call.holder === OTHER_MEMBER)).toBe(true);
    });
});

describe.skipIf(!enabled)('a GitLab batch launches', () => {
    const launch = async (policy: 'human' | 'automerge' = 'human') => {
        const id = await draft(policy);
        return {
            id,
            validate: () => post(`/api/batches/${id}/validate`, {}),
            start: () => post(`/api/batches/${id}/start`, { version: 1 }),
        };
    };
    const targetBranches = () =>
        sql<{ branch: string | null }[]>`select branch from batch_target where org_id = ${org.id}`;
    const jobCount = async () =>
        Number((await sql<{ count: string }[]>`select count(*) from job where org_id = ${org.id}`)[0]?.count);

    it('reads the default branch as the launcher and freezes it', async () => {
        const batch = await launch();
        const before = mark();
        expect((await batch.validate()).statusCode).toBe(OK);
        const started = await batch.start();
        expect(started.statusCode, started.body).toBe(OK);
        const read = callsSince(before).filter((call) => call.method === 'GET' && call.path === api());
        expect(read.length).toBeGreaterThan(0);
        expect(read.every((call) => call.holder === MEMBER)).toBe(true);
        expect(await targetBranches()).toEqual([{ branch: 'trunk' }]);
        expect(reached).toEqual([]);
    });

    it('refuses an empty project as BATCH_NO_DEFAULT_BRANCH', async () => {
        const empty = `${grp}/empty`;
        await h.fake.control('gitlab/projects', { path: empty, defaultBranch: null });
        await board.app.inject({
            method: 'PUT',
            url: `/api/org/gitlab-connections/${connectionId}/tracked-repos`,
            headers: bearer(org.admin),
            payload: { paths: [project(), empty] },
        });
        const drafted = await post('/api/batches', {
            plan: { ...planOf(), targets: [{ key: 'web', repo: { ...ref(), path: empty } }] },
        });
        const { id } = drafted.json<{ id: string }>();
        const res = await post(`/api/batches/${id}/validate`, {});
        expect(res.statusCode, res.body).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'BATCH_NO_DEFAULT_BRANCH' });
    });

    it('asks a launcher with no live GitLab grant to connect (409), not a 503', async () => {
        const batch = await launch();
        await breakGrant();
        const before = mark();
        for (const send of [batch.validate, batch.start]) {
            const res = await send();
            expect(res.statusCode, res.body).toBe(CONFLICT);
            expect(res.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED' });
        }
        expect(callsSince(before).filter((call) => call.path === api())).toEqual([]);
    });

    it.each([
        ['a 500', { mode: 'status', status: 500 }],
        ['a malformed answer', { mode: 'malformed' }],
    ])('answers 503 and writes no job when the default branch read is %s', async (_name, injected) => {
        const batch = await launch();
        // The gate's own access check is the first read of the project; the default branch read is the second.
        await fault({ ...injected, pathIncludes: api(), after: 1 });
        const res = await batch.start();
        expect(res.statusCode, res.body).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE' });
        expect(await jobCount()).toBe(0);
    });

    it('launches an automerge plan on a board with GitLab access and member grants', async () => {
        const batch = await launch('automerge');
        const res = await batch.validate();
        expect(res.statusCode, res.body).toBe(OK);
    });
});
