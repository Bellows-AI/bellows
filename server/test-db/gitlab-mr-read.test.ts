import { randomUUID } from 'node:crypto';
import { gitlabForgeOf } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JOB_ID_HEADER, LEASE_TOKEN_HEADER } from '../src/auth/plugin.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import type { ForgeSource } from '../src/forge/forge-client.js';
import type { GitHubAppClient } from '../src/github/app-client.js';
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
import { expireLease } from './fixtures.js';

/**
 * The board reads a GitLab task's recorded merge request as the thread's starter (docs/gitlab.md): diff, notes and
 * pipeline through the person's route and the attempt's, whoever asks. Everything is real but the fake GitLab; GitHub
 * is a spy that fails the test when reached.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const UNAUTHENTICATED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const UNAVAILABLE = 503;
const LEASE_SECONDS = 60;
const MEMBER = 'dev-one';
const FORGE = gitlabForgeOf(HOST);
const BIG_COMMIT_FILES = 105;

let sql: Sql;
let h: Harness & { stop(): Promise<void> };
let board: Board;
let org: Org;
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
    board = await h.board({ forge: spyForge(), api: h.gitlabApi() });
    await h.fake.control('gitlab/projects', { path: project(), files: { 'README.md': 'x\n' } });
    const id = await h.connect(org, { groups: [grp] });
    expect((await board.activate(org, id)).result).toBe('activated');
    expect((await board.link(org, id, MEMBER)).result).toBe('linked');
    const picked = await board.app.inject({
        method: 'PUT',
        url: `/api/org/gitlab-connections/${id}/tracked-repos`,
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

const project = () => `${grp}/sub/web`;
const ref = () => ({ forge: 'gitlab', host: HOST, path: project() });
const gl = () => h.fake;
const pair = (run: { id: string; leaseToken: string }) => ({
    [JOB_ID_HEADER]: run.id,
    [LEASE_TOKEN_HEADER]: run.leaseToken,
});

/** A running attempt whose branch carries `files`, and (when `publish`) the MR the thread recorded for it. */
async function task({ files, publish = true }: { files?: Record<string, string>; publish?: boolean } = {}) {
    const branch = `task/b${++counter}`;
    await gl().control('gitlab/commit', {
        project: project(),
        branch,
        files: files ?? { [`${branch}.txt`]: 'line\n' },
        message: 'work',
    });
    const { id, claim } = await board.running(org, ref());
    const run = { id, leaseToken: claim.leaseToken, branch, number: 0 };
    if (!publish) return run;
    const made = await board.app.inject({
        method: 'POST',
        url: `/api/jobs/${id}/pull-request`,
        headers: { ...driverBearer, 'content-type': 'application/json' },
        payload: {
            leaseToken: run.leaseToken,
            branch,
            base: 'main',
            create: { title: 'Add it', body: 'Why', draft: false, base: 'main' },
        },
    });
    expect(made.statusCode, made.body).toBe(OK);
    run.number = made.json<{ number: number }>().number;
    await sql`insert into job_pr (org_id, root_job_id, repo, pr_number, pr_url, head_branch, base_branch)
              values (${org.id}, ${id}, ${project()}, ${run.number},
                      ${`https://${HOST}/${project()}/-/merge_requests/${run.number}`}, ${branch}, 'main')`;
    return run;
}
type Run = Awaited<ReturnType<typeof task>>;

const read = (run: Run, part: string, token = org.member) =>
    board.app.inject({ method: 'GET', url: `/api/jobs/${run.id}/change-request?part=${part}`, headers: bearer(token) });
const agentRead = (run: Run, part: string, headers: Record<string, string> = pair(run)) =>
    board.app.inject({ method: 'GET', url: `/api/jobs/${run.id}/agent-change-request?part=${part}`, headers });
const readCalls = (run: Run) =>
    gl()
        .forge.calls()
        .filter((call) => new RegExp(`/merge_requests/${run.number}/(diffs|notes)|/statuses`).test(call.path));
const breakGrant = () =>
    sql`update integration_grant set status = 'reconnect_required' where org_id = ${org.id}
        and principal_user_id = ${org.memberId}`;
const waits = (id: string) =>
    sql<{ reason: string }[]>`select reason from job_integration_requirement where root_job_id = ${id}`;

describe.skipIf(!enabled)('the board reads a GitLab task’s merge request as its starter', () => {
    it('reads every changed file page by page, with the starter’s token also when an admin asks', async () => {
        const files = Object.fromEntries(Array.from({ length: BIG_COMMIT_FILES }, (_, i) => [`f${i}.txt`, `${i}\n`]));
        const run = await task({ files });
        for (const caller of [org.member, org.admin]) {
            const res = await read(run, 'diff', caller);
            expect(res.statusCode, res.body).toBe(OK);
            const body = res.json<{ part: string; number: number; files: Array<{ newPath: string; diff: string }> }>();
            expect(body).toMatchObject({ part: 'diff', number: run.number });
            expect(body.files).toHaveLength(BIG_COMMIT_FILES);
            expect(body.files[0]?.diff).toContain('@@');
        }
        const calls = readCalls(run);
        expect(calls.length).toBeGreaterThan(2);
        expect(calls.every((call) => call.holder === MEMBER && call.tokenKind === 'user')).toBe(true);
        expect(reached).toEqual([]);
    });

    it('reads the notes oldest first and the pipeline with the head commit’s statuses', async () => {
        const run = await task();
        const token = (await board.grants.accessToken(org.id, org.memberId, FORGE)) as { accessToken: string };
        const base = `/api/v4/projects/${encodeURIComponent(project())}`;
        for (const body of ['first', 'second']) {
            await gl().send('POST', `${base}/merge_requests/${run.number}/notes`, {
                token: token.accessToken,
                body: { body },
            });
        }
        const sha = (
            await gl().send('GET', `${base}/repository/branches/${encodeURIComponent(run.branch)}`, {
                token: token.accessToken,
            })
        ).body.commit.id as string;
        await gl().send('POST', `${base}/statuses/${sha}`, {
            token: token.accessToken,
            body: { state: 'success', name: 'lint', ref: run.branch },
        });
        expect((await read(run, 'notes')).json()).toMatchObject({ notes: [{ body: 'first' }, { body: 'second' }] });
        expect((await read(run, 'pipeline')).json()).toMatchObject({
            sha,
            pipeline: { status: 'success' },
            statuses: [{ name: 'lint', status: 'success' }],
        });
    });

    it('answers 409 FORGE_GRANT_REQUIRED for a broken grant, opens no wait and returns no empty diff', async () => {
        const run = await task();
        await breakGrant();
        const before = readCalls(run).length;
        const res = await read(run, 'diff');
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({
            code: 'FORGE_GRANT_REQUIRED',
            forge: FORGE,
            standing: 'broken',
            waiting: false,
            connectUrl: expect.stringContaining('returnTo=%2Ftasks%2F'),
        });
        expect(res.json()).not.toHaveProperty('files');
        expect(res.json()).not.toHaveProperty('retryable');
        expect(await waits(run.id)).toEqual([]);
        expect(readCalls(run)).toHaveLength(before);
    });

    it('answers 503 for a 5xx, a malformed page and a refused token, never a shorter list', async () => {
        const run = await task();
        for (const fault of [{ mode: 'status', status: 500 }, { mode: 'malformed' }, { mode: 'status', status: 401 }]) {
            await gl().control('gitlab/faults', { ...fault, pathIncludes: '/diffs', count: 1 });
            const res = await read(run, 'diff');
            expect(res.statusCode, JSON.stringify(fault)).toBe(UNAVAILABLE);
            expect(res.json()).toMatchObject({ code: 'UNAVAILABLE' });
            expect(res.json()).not.toHaveProperty('files');
        }
        expect((await read(run, 'diff')).statusCode).toBe(OK);
    });

    it('answers 503 when a later page fails, not the pages read so far', async () => {
        const files = Object.fromEntries(Array.from({ length: BIG_COMMIT_FILES }, (_, i) => [`f${i}.txt`, `${i}\n`]));
        const run = await task({ files });
        await gl().control('gitlab/faults', {
            mode: 'status',
            status: 500,
            pathIncludes: '/diffs',
            after: 1,
            count: 1,
        });
        const res = await read(run, 'diff');
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).not.toHaveProperty('files');
    });

    it('answers 503 for a page that never answers, bounded by the request timer', async () => {
        const run = await task();
        await gl().control('gitlab/faults', { mode: 'timeout', pathIncludes: '/diffs', count: 1 });
        const res = await read(run, 'diff');
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('is 404 NO_CHANGE_REQUEST for a task that recorded none', async () => {
        const run = await task({ publish: false });
        const res = await read(run, 'diff');
        expect(res.statusCode).toBe(NOT_FOUND);
        expect(res.json()).toMatchObject({ code: 'NO_CHANGE_REQUEST' });
    });

    it('is 503, not 404, when the row read fails', async () => {
        const run = await task({ publish: false });
        await sql`alter table job_pr rename to job_pr_gone`;
        try {
            expect((await read(run, 'diff')).statusCode).toBe(UNAVAILABLE);
        } finally {
            await sql`alter table job_pr_gone rename to job_pr`;
        }
    });

    it('is 400 for a part that is not one, and 404 for an unknown task', async () => {
        const run = await task();
        expect((await read(run, 'everything')).statusCode).toBe(400);
        const missing = await board.app.inject({
            method: 'GET',
            url: `/api/jobs/${randomUUID()}/change-request?part=diff`,
            headers: bearer(org.member),
        });
        expect(missing.statusCode).toBe(NOT_FOUND);
    });

    it('reads only the recorded merge request, whatever the caller puts in the query', async () => {
        const run = await task();
        const res = await board.app.inject({
            method: 'GET',
            url: `/api/jobs/${run.id}/change-request?part=diff&number=${run.number + 7}&iid=99`,
            headers: bearer(org.member),
        });
        expect(res.json()).toMatchObject({ number: run.number });
        const numbered = gl()
            .forge.calls()
            .filter((call) => /\/merge_requests\/\d+/.test(call.path));
        expect(numbered.length).toBeGreaterThan(0);
        expect(numbered.every((call) => call.path.includes(`/merge_requests/${run.number}`))).toBe(true);
    });

    it('answers 409 CHANGE_REQUEST_READ_UNSUPPORTED for a GitHub task, with no request made', async () => {
        const run = await task({ publish: false });
        await sql`update job set forge = 'github', host = 'github.com', repo = 'acme/web' where id = ${run.id}`;
        const before = gl().forge.calls().length;
        const res = await read(run, 'diff');
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'CHANGE_REQUEST_READ_UNSUPPORTED' });
        expect(reached).toEqual([]);
        expect(gl().forge.calls()).toHaveLength(before);
    });
});

describe.skipIf(!enabled)('the attempt reads the same merge request by its pair', () => {
    it('answers the person route’s body, as the starter', async () => {
        const run = await task();
        const res = await agentRead(run, 'diff');
        expect(res.statusCode, res.body).toBe(OK);
        expect(res.json()).toMatchObject({ part: 'diff', number: run.number, files: [{ newFile: true }] });
        expect(res.json()).toEqual((await read(run, 'diff')).json());
        expect(readCalls(run).every((call) => call.holder === MEMBER && call.tokenKind === 'user')).toBe(true);
    });

    it('refuses no pair (401, as every attempt route) and a pair the task never held (403)', async () => {
        const run = await task();
        expect((await agentRead(run, 'diff', {})).statusCode).toBe(UNAUTHENTICATED);
        expect((await agentRead(run, 'diff', bearer(org.member))).statusCode).toBe(UNAUTHENTICATED);
        const forged = await agentRead(run, 'diff', pair({ id: run.id, leaseToken: randomUUID() }));
        expect(forged.statusCode).toBe(FORBIDDEN);
        expect(forged.body).not.toContain('files');
    });

    it('tells a superseded pair to wait: 503 LEASE_PENDING, and the current pair reads', async () => {
        const run = await task();
        await expireLease(sql, run.id);
        const takeover = (await (await board.jobs(org)).claim('worker-2', LEASE_SECONDS)) as {
            leaseToken: string;
        } | null;
        expect(takeover).not.toBeNull();
        const old = await agentRead(run, 'diff');
        expect(old.statusCode).toBe(UNAVAILABLE);
        expect(old.json()).toMatchObject({ code: 'LEASE_PENDING' });
        const current = await agentRead(run, 'diff', pair({ id: run.id, leaseToken: takeover!.leaseToken }));
        expect(current.statusCode, current.body).toBe(OK);
    });

    it('holds the thread on a broken grant with the credential route’s 409 body', async () => {
        const run = await task();
        await breakGrant();
        const res = await agentRead(run, 'diff');
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({
            code: 'FORGE_GRANT_REQUIRED',
            forge: FORGE,
            standing: 'broken',
            waiting: true,
            connectUrl: expect.any(String),
        });
        expect(res.json()).not.toHaveProperty('retryable');
        expect(await waits(run.id)).toMatchObject([{ reason: 'reconnect' }]);
    });

    it('answers 503 for a GitLab 5xx and opens no wait', async () => {
        const run = await task();
        await gl().control('gitlab/faults', { mode: 'status', status: 500, pathIncludes: '/notes', count: 1 });
        const res = await agentRead(run, 'notes');
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(await waits(run.id)).toEqual([]);
    });

    it('is 404 NO_CHANGE_REQUEST with no recorded request', async () => {
        const run = await task({ publish: false });
        const res = await agentRead(run, 'diff');
        expect(res.statusCode).toBe(NOT_FOUND);
        expect(res.json()).toMatchObject({ code: 'NO_CHANGE_REQUEST' });
    });
});
