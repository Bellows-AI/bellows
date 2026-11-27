import { randomUUID } from 'node:crypto';
import { gitlabForgeOf } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JOB_ID_HEADER, LEASE_TOKEN_HEADER } from '../src/auth/plugin.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import type { ForgeSource } from '../src/forge/forge-client.js';
import { gitlabAccessOf } from '../src/forge/forge-gate.js';
import type { GitlabReads } from '../src/forge/forge-reads.js';
import { addressedMarker, PLAN_BYTES_MAX, PLAN_TARGETS_MAX } from '../src/forge/review-collection.js';
import type { GitHubAppClient } from '../src/github/app-client.js';
import type { GitlabApi, GitlabRequest } from '../src/gitlab/gitlab-api.js';
import { createPrFollower } from '../src/pr-follower.js';
import { testSecretDeps } from './env-secrets-harness.js';
import { expireLease } from './fixtures.js';
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
 * The review loop's board routes on a GitLab task (docs/workflows.md): the attempt's pair reads the recorded merge
 * request's discussions and, as the block's `reply` node only, replies and resolves, always as the thread's starter.
 * Everything is real but the fake GitLab; GitHub is a spy that fails the test when reached.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const BAD_REQUEST = 400;
const UNAUTHENTICATED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const UNAVAILABLE = 503;
const LEASE_SECONDS = 60;
const MEMBER = 'dev-one';
const REVIEWER = 'rev-one';
const FORGE = gitlabForgeOf(HOST);
const REPLY_NODE = 'reply';

let sql: Sql;
let h: Harness & { stop(): Promise<void> };
let board: Board;
let org: Org;
let grp: string;
let reached: string[];
let counter = 0;
/** Runs before the board's every GitLab request: how a test changes the world in the middle of a call. */
let onRequest: ((request: GitlabRequest) => Promise<void>) | null;

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
const hooked = (real: GitlabApi): GitlabApi => ({
    ...real,
    request: async (request) => {
        await onRequest?.(request);
        return real.request(request);
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
    onRequest = null;
    await resetHarness(h, sql);
    org = await h.newOrg();
    grp = `g${randomUUID().slice(0, 8)}`;
    await createUserExecutorStore({ sql, orgId: org.id, ...testSecretDeps(sql) }).createOrg({
        name: 'main',
        type: 'claude-code',
        config: {},
        createdBy: org.adminId,
    });
    board = await h.board({ forge: spyForge(), api: h.gitlabApi(hooked) });
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
const ref = () => ({ forge: 'gitlab' as const, host: HOST, path: project() });
const gl = () => h.fake;
const pair = (run: { id: string; leaseToken: string }) => ({
    [JOB_ID_HEADER]: run.id,
    [LEASE_TOKEN_HEADER]: run.leaseToken,
});
const api = () => `/api/v4/projects/${encodeURIComponent(project())}`;

/** The `reply` node of a review block, as a stored snapshot names it, and the `repair` node beside it. */
const snapshot = {
    entry: 'collect',
    params: [],
    nodes: [
        { name: 'repair', kind: 'agent', session: 'resume', prompt: 'repair', publish: true },
        {
            name: REPLY_NODE,
            kind: 'agent',
            session: 'resume',
            gates: false,
            prompt: 'reply',
            helperPlans: [{ helperId: 'review-reply-probe', phase: 'pre', githubWriting: true }],
        },
    ],
    edges: [],
};
/** Marks the attempt as running the workflow node `name` of the review block. */
const asNode = (id: string, name: string) =>
    sql`update job set workflow_node = ${name}, workflow_snapshot = ${sql.json(snapshot)} where id = ${id}`;

/** A running attempt on its own branch, and (when `publish`) the MR the thread recorded for it. */
async function task({ publish = true, node = REPLY_NODE }: { publish?: boolean; node?: string | null } = {}) {
    const branch = `task/b${++counter}`;
    await gl().control('gitlab/commit', {
        project: project(),
        branch,
        files: { [`${branch}.txt`]: 'line\n' },
        message: 'work',
    });
    const { id, claim } = await board.running(org, ref());
    if (node !== null) await asNode(id, node);
    const run = { id, leaseToken: claim.leaseToken, branch, number: 0, sha: '' };
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
    run.sha = (await gl().send('GET', `${api()}/merge_requests/${run.number}`, { token: await tokenOf() })).body.sha;
    return run;
}
type Run = Awaited<ReturnType<typeof task>>;

const tokenOf = async () =>
    ((await board.grants.accessToken(org.id, org.memberId, FORGE)) as { accessToken: string }).accessToken;
const discuss = async (run: Run, body: object) =>
    (await gl().control('gitlab/discussion', { project: project(), iid: run.number, login: REVIEWER, ...body }))
        .body as { id: string; noteId: number };
const diffNote = (run: Run, extra: object = {}) => ({
    position: {
        position_type: 'text',
        new_path: 'src/a.ts',
        old_path: 'src/a.ts',
        new_line: 7,
        old_line: null,
        head_sha: run.sha,
    },
    ...extra,
});
const discussionsOf = async (run: Run) =>
    (await gl().send('GET', `${api()}/merge_requests/${run.number}/discussions`, { token: await tokenOf() })).body as {
        id: string;
        notes: { body: string; resolved: boolean; author: { username: string } }[];
    }[];

const collect = (run: Run, headers: Record<string, string> = pair(run)) =>
    board.app.inject({ method: 'GET', url: `/api/jobs/${run.id}/agent-review`, headers });
const reply = (run: Run, payload: unknown, headers: Record<string, string> = pair(run)) =>
    board.app.inject({
        method: 'POST',
        url: `/api/jobs/${run.id}/agent-review/replies`,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: payload as object,
    });
const target = (extra: object) => ({
    id: 'x',
    kind: 'thread',
    reply: null,
    resolve: false,
    firstCommentId: null,
    status: 'planned',
    reason: null,
    ...extra,
});
const plan = (run: Run, targets: object[], number = run.number) => ({
    version: 1,
    schema: 'review-reply/plan/v1',
    ref: { owner: `${grp}/sub`, repo: 'web', number },
    targets,
});
const marked = (key: string, text = 'fixed') => `${text}\n\n${addressedMarker(key)}`;
/** The fake's writes on any merge request, as `METHOD path`. */
const writes = () =>
    gl()
        .forge.calls()
        .filter((call) => call.method !== 'GET' && call.path.includes('/merge_requests/'))
        .map((call) => `${call.method} ${call.path}`);
const readsOf = (run: Run) =>
    gl()
        .forge.calls()
        .filter((call) => new RegExp(`/merge_requests/${run.number}/(discussions|reviewers)`).test(call.path));
const fault = (body: object) => gl().control('gitlab/faults', body);
const breakGrant = () =>
    sql`update integration_grant set status = 'reconnect_required' where org_id = ${org.id}
        and principal_user_id = ${org.memberId}`;
const waits = (id: string) =>
    sql<{ reason: string }[]>`select reason from job_integration_requirement where root_job_id = ${id}`;
/** Expires the attempt's lease and lets another worker take the thread over: the attempt's pair is superseded. */
const takeOver = async (run: Run) => {
    await expireLease(sql, run.id);
    expect(await (await board.jobs(org)).claim('worker-2', LEASE_SECONDS)).not.toBeNull();
};

describe.skipIf(!enabled)('the attempt reads the merge request’s review collection as its starter', () => {
    it('answers the discussions as review-collect/v1, every read made with the starter’s token', async () => {
        const run = await task();
        const open = await discuss(run, diffNote(run, { body: 'rename this' }));
        const done = await discuss(run, diffNote(run, { body: 'fixed already' }));
        await gl().send('PUT', `${api()}/merge_requests/${run.number}/discussions/${done.id}?resolved=true`, {
            token: await tokenOf(),
        });
        await discuss(run, { body: 'a remark', individual: true });
        await discuss(run, { body: 'added 1 commit', system: true });
        await gl().send('POST', `${api()}/merge_requests/${run.number}/notes`, {
            token: await tokenOf(),
            body: { body: marked('general:9', 'earlier') },
        });
        const res = await collect(run);
        expect(res.statusCode, res.body).toBe(OK);
        expect(res.headers['cache-control']).toBe('no-store');
        const body = res.json<{
            schema: string;
            threads: { id: string; path: string | null; line: number | null; isResolved: boolean }[];
            general: { body: string }[];
            addressed: string[];
        }>();
        expect(body.schema).toBe('review-collect/v1');
        expect(body.threads.map((t) => [t.id, t.path, t.line, t.isResolved])).toEqual([
            [open.id, 'src/a.ts', 7, false],
            [done.id, 'src/a.ts', 7, true],
        ]);
        expect(body.general.map((c) => c.body)).toEqual(['a remark', marked('general:9', 'earlier')]);
        expect(body.addressed).toEqual(['general:9']);
        expect(res.body).not.toContain('added 1 commit');
        const calls = readsOf(run);
        expect(calls.length).toBeGreaterThan(1);
        expect(calls.every((call) => call.holder === MEMBER && call.tokenKind === 'user')).toBe(true);
        expect(reached).toEqual([]);
    });

    it('answers 503 for a 5xx, a malformed page and a page that never answers, never an empty threads', async () => {
        const run = await task();
        await discuss(run, diffNote(run, { body: 'x' }));
        for (const mode of [{ mode: 'status', status: 500 }, { mode: 'malformed' }, { mode: 'timeout' }]) {
            await fault({ ...mode, pathIncludes: '/discussions', count: 1 });
            const res = await collect(run);
            expect(res.statusCode, JSON.stringify(mode)).toBe(UNAVAILABLE);
            expect(res.json()).toMatchObject({ code: 'UNAVAILABLE' });
            expect(res.json()).not.toHaveProperty('threads');
        }
        expect((await collect(run)).statusCode).toBe(OK);
    });

    it('holds the thread on a broken grant with 409 FORGE_GRANT_REQUIRED, waiting', async () => {
        const run = await task();
        await breakGrant();
        const before = readsOf(run).length;
        const res = await collect(run);
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', forge: FORGE, waiting: true });
        expect(res.json()).not.toHaveProperty('threads');
        expect(await waits(run.id)).toMatchObject([{ reason: 'reconnect' }]);
        expect(readsOf(run)).toHaveLength(before);
    });

    it('is 409 CHANGE_REQUEST_READ_UNSUPPORTED for a GitHub task with no request made, 404 with no recorded MR', async () => {
        const none = await task({ publish: false });
        const missing = await collect(none);
        expect(missing.statusCode).toBe(NOT_FOUND);
        expect(missing.json()).toMatchObject({ code: 'NO_CHANGE_REQUEST' });
        await sql`update job set forge = 'github', host = 'github.com', repo = 'acme/web' where id = ${none.id}`;
        const before = gl().forge.calls().length;
        const res = await collect(none);
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'CHANGE_REQUEST_READ_UNSUPPORTED' });
        expect(gl().forge.calls()).toHaveLength(before);
        expect(reached).toEqual([]);
    });

    it('refuses no pair (401), a pair the task never held (403) and a superseded pair (503 LEASE_PENDING)', async () => {
        const run = await task();
        expect((await collect(run, {})).statusCode).toBe(UNAUTHENTICATED);
        expect((await collect(run, bearer(org.member))).statusCode).toBe(UNAUTHENTICATED);
        expect((await collect(run, pair({ id: run.id, leaseToken: randomUUID() }))).statusCode).toBe(FORBIDDEN);
        await takeOver(run);
        const old = await collect(run);
        expect(old.statusCode).toBe(UNAVAILABLE);
        expect(old.json()).toMatchObject({ code: 'LEASE_PENDING' });
    });

    it('withholds the answer when the attempt is superseded during the read', async () => {
        const run = await task();
        await discuss(run, diffNote(run, { body: 'x' }));
        onRequest = async (request) => {
            onRequest = null;
            if (request.path.includes('/discussions')) await takeOver(run);
        };
        const res = await collect(run);
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'LEASE_PENDING' });
        expect(res.json()).not.toHaveProperty('threads');
    });
});

describe.skipIf(!enabled)('the block’s reply node replies and resolves as the starter', () => {
    const threePlan = async (run: Run) => {
        const thread = await discuss(run, diffNote(run, { body: 'fix this' }));
        const general = await discuss(run, { body: 'a remark', individual: true });
        const key = `general:${general.noteId}`;
        return {
            thread,
            general,
            targets: [
                target({
                    id: thread.id,
                    kind: 'thread',
                    reply: marked(`thread:${thread.id}`),
                    firstCommentId: thread.noteId,
                }),
                target({ id: thread.id, kind: 'resolve', resolve: true }),
                target({ id: key, kind: 'general', reply: marked(key, 'noted') }),
            ],
        };
    };

    it('posts, resolves and replies in general as the starter, touching only the recorded request', async () => {
        const run = await task();
        const { thread, targets } = await threePlan(run);
        // The plan names another request; the board ignores it.
        const res = await reply(run, plan(run, targets, run.number + 7));
        expect(res.statusCode, res.body).toBe(OK);
        expect(res.json()).toMatchObject({ schema: 'review-reply/v1', error: null });
        expect(
            res.json<{ results: { kind: string; status: string }[] }>().results.map((r) => [r.kind, r.status])
        ).toEqual([
            ['thread', 'done'],
            ['resolve', 'done'],
            ['general', 'done'],
        ]);
        const after = await discussionsOf(run);
        const mine = after.find((d) => d.id === thread.id)!;
        expect(mine.notes.at(-1)?.author.username).toBe(MEMBER);
        expect(mine.notes.every((n) => n.resolved)).toBe(true);
        const sent = writes();
        expect(sent.length).toBeGreaterThanOrEqual(3);
        expect(sent.every((line) => line.includes(`/merge_requests/${run.number}/`))).toBe(true);
        expect(
            gl()
                .forge.calls()
                .filter((call) => call.method !== 'GET' && call.path.includes('/merge_requests/'))
                .every((call) => call.holder === MEMBER)
        ).toBe(true);
        expect(reached).toEqual([]);
    });

    it('sends the same plan again as noops, writing nothing', async () => {
        const run = await task();
        const { targets } = await threePlan(run);
        await reply(run, plan(run, targets));
        const before = writes().length;
        const again = await reply(run, plan(run, targets));
        expect(again.statusCode).toBe(OK);
        expect(again.json<{ results: { status: string }[] }>().results.map((r) => r.status)).toEqual([
            'noop',
            'noop',
            'noop',
        ]);
        expect(writes()).toHaveLength(before);
    });

    it('sends a reply whose answer is lost once, and reads it back', async () => {
        const run = await task();
        const thread = await discuss(run, diffNote(run, { body: 'fix this' }));
        await fault({ pathIncludes: `/discussions/${thread.id}/notes`, mode: 'lost', count: 5 });
        const res = await reply(
            run,
            plan(run, [target({ id: thread.id, kind: 'thread', reply: marked(`thread:${thread.id}`) })])
        );
        expect(res.statusCode, res.body).toBe(OK);
        expect(res.json<{ results: { status: string }[] }>().results.map((r) => r.status)).toEqual(['done']);
        expect((await discussionsOf(run)).find((d) => d.id === thread.id)?.notes).toHaveLength(2);
    });

    it('answers 400 BAD_BODY for a bad schema, too many targets and an oversize body, sending nothing', async () => {
        const run = await task();
        const thread = await discuss(run, diffNote(run, { body: 'x' }));
        const one = target({ id: thread.id, kind: 'thread', reply: marked(`thread:${thread.id}`) });
        const fat = target({
            id: thread.id,
            kind: 'thread',
            reply: marked(`thread:${thread.id}`, 'y'.repeat(PLAN_BYTES_MAX)),
        });
        for (const bad of [
            { ...plan(run, [one]), schema: 'other' },
            plan(
                run,
                Array.from({ length: PLAN_TARGETS_MAX + 1 }, () => one)
            ),
            plan(run, [one, { id: 7 }]),
            plan(run, [fat]),
        ]) {
            const res = await reply(run, bad);
            expect(res.statusCode).toBe(BAD_REQUEST);
            expect(res.json()).toMatchObject({ code: 'BAD_BODY' });
        }
        expect(writes()).toEqual([]);
    });

    it('holds the thread on a broken grant and writes nothing; 503 on an unconfirmed first read', async () => {
        const run = await task();
        const thread = await discuss(run, diffNote(run, { body: 'x' }));
        const body = plan(run, [target({ id: thread.id, kind: 'thread', reply: marked(`thread:${thread.id}`) })]);
        await fault({ pathIncludes: '/discussions', mode: 'status', status: 500, count: 1 });
        const unconfirmed = await reply(run, body);
        expect(unconfirmed.statusCode).toBe(UNAVAILABLE);
        expect(unconfirmed.json()).toMatchObject({ code: 'UNAVAILABLE' });
        await breakGrant();
        const held = await reply(run, body);
        expect(held.statusCode).toBe(CONFLICT);
        expect(held.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', waiting: true });
        expect(await waits(run.id)).toMatchObject([{ reason: 'reconnect' }]);
        expect(writes()).toEqual([]);
    });

    it('writes nothing when the attempt is superseded after the token read, before the first write', async () => {
        const run = await task();
        const thread = await discuss(run, diffNote(run, { body: 'x' }));
        onRequest = async (request) => {
            onRequest = null;
            if (request.path.includes('/discussions')) await takeOver(run);
        };
        const res = await reply(
            run,
            plan(run, [target({ id: thread.id, kind: 'thread', reply: marked(`thread:${thread.id}`) })])
        );
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'LEASE_PENDING' });
        expect(writes()).toEqual([]);
    });

    it('refuses the repair node’s own live pair and a plain task’s with 403, writing nothing', async () => {
        const thread = async (run: Run) => (await discuss(run, diffNote(run, { body: 'x' }))).id;
        for (const node of ['repair', null]) {
            const run = await task({ node });
            const id = await thread(run);
            const res = await reply(run, plan(run, [target({ id, kind: 'thread', reply: marked(`thread:${id}`) })]));
            expect(res.statusCode, String(node)).toBe(FORBIDDEN);
            expect(res.body).not.toContain('results');
        }
        expect(writes()).toEqual([]);
    });

    it('is 404 with no recorded request and 409 for a GitHub task, with nothing written', async () => {
        const run = await task({ publish: false });
        const body = plan(run, []);
        expect((await reply(run, body)).json()).toMatchObject({ code: 'NO_CHANGE_REQUEST' });
        await sql`update job set forge = 'github', host = 'github.com', repo = 'acme/web' where id = ${run.id}`;
        expect((await reply(run, body)).json()).toMatchObject({ code: 'CHANGE_REQUEST_READ_UNSUPPORTED' });
        expect(writes()).toEqual([]);
    });
});

describe.skipIf(!enabled)('a thread parked on the review wait wakes on a new GitLab note', () => {
    const reads = (): GitlabReads => ({
        gitlab: gitlabAccessOf(board.replica.orgs, board.replica.api),
        memberGrants: board.grants,
    });

    it('wakes when a reviewer’s note moves the merge request, and not before', async () => {
        const run = await task({ publish: false, node: null });
        const mr = await gl().send('POST', `${api()}/merge_requests`, {
            token: await tokenOf(),
            body: { source_branch: run.branch, target_branch: 'main', title: 'Add it' },
        });
        const iid = (mr.body as { iid: number }).iid;
        const found = await board.replica.orgs.for(org.id);
        if (!found?.jobs || !found.prs) throw new Error('the org has no stores');
        const { jobs, prs } = found;
        await prs.recordPublication({
            root: run.id,
            repo: project(),
            prNumber: iid,
            prUrl: (mr.body as { web_url: string }).web_url,
            headBranch: run.branch,
            baseBranch: 'main',
        });
        await prs.enterWait({ root: run.id, reason: 'review', repo: ref(), prNumber: iid });
        const follower = createPrFollower({
            sql,
            orgId: org.id,
            gitlab: reads(),
            prs,
            spreadMs: 0,
            recordMerge: (repo, number, deliveryId, mergedAt) => jobs.closeMergedPr(repo, number, deliveryId, mergedAt),
        });
        await follower.observeDue();
        expect((await prs.waitOf(run.id))?.pending).toBe(0);
        await sql`update pr_follow set next_poll_at = now() - interval '1 second' where org_id = ${org.id}`;
        await follower.observeDue();
        expect((await prs.waitOf(run.id))?.pending).toBe(0);
        await gl().control('clock', { advanceMs: 5000 });
        await gl().control('gitlab/discussion', { project: project(), iid, login: REVIEWER, body: 'please fix' });
        await sql`update pr_follow set next_poll_at = now() - interval '1 second' where org_id = ${org.id}`;
        await follower.observeDue();
        expect((await prs.waitOf(run.id))?.pending).toBe(1);
    });
});
