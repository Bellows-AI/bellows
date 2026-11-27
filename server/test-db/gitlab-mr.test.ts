import { randomUUID } from 'node:crypto';
import { gitlabForgeOf } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import type { ForgeSource } from '../src/forge/forge-client.js';
import type { GitHubAppClient } from '../src/github/app-client.js';
import type { GitlabApi, GitlabRequest } from '../src/gitlab/gitlab-api.js';
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
 * The board writes a GitLab task's merge request as the thread's starter (docs/gitlab.md), exactly as the driver asks
 * (`POST /api/jobs/:id/pull-request`): view, create as a draft, edit, retarget, a lost answer replayed, a lost grant, a
 * GitLab fault and a member who lost Developer. Everything is real but the fake GitLab; GitHub is a spy that fails the
 * test when reached.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const UNAVAILABLE = 503;
const MEMBER = 'dev-one';
const FORGE = gitlabForgeOf(HOST);
const MR_URL = /\/-\/merge_requests\/\d+$/;
const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIBmrca\n-----END CERTIFICATE-----\n';

let sql: Sql;
let h: Harness & { stop(): Promise<void> };
let board: Board;
let org: Org;
let grp: string;
let reached: string[];
let mints: string[];
let seenCa: Array<string | undefined>;
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
/** The board's GitLab client, noting the CA bundle each request carried. */
const noting = (api: GitlabApi): GitlabApi => ({
    ...api,
    request: (request: GitlabRequest) => {
        if (request.path.includes('/merge_requests')) seenCa.push(request.caBundle);
        return api.request(request);
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
    mints = [];
    seenCa = [];
    await resetHarness(h, sql);
    org = await h.newOrg();
    grp = `g${randomUUID().slice(0, 8)}`;
    await createUserExecutorStore({ sql, orgId: org.id, ...testSecretDeps(sql) }).createOrg({
        name: 'main',
        type: 'claude-code',
        config: {},
        createdBy: org.adminId,
    });
    board = await h.board({
        forge: spyForge(),
        api: h.gitlabApi(noting),
        githubMint: async (...args) => {
            mints.push(args.join(':'));
            return null;
        },
    });
    await h.fake.control('gitlab/projects', { path: project(), files: { 'README.md': 'x\n' } });
    const id = await h.connect(org, { groups: [grp], caBundle: CA_PEM });
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
const encoded = () => encodeURIComponent(project());
const gl = () => h.fake;

/** A source branch with a commit on it, and a running attempt on the repo. */
async function attempt() {
    const branch = `task/b${++counter}`;
    await gl().control('gitlab/commit', {
        project: project(),
        branch,
        files: { [`${branch}.txt`]: 'x' },
        message: 'w',
    });
    const { id, claim } = await board.running(org, ref());
    return { id, leaseToken: claim.leaseToken, branch };
}
type Run = Awaited<ReturnType<typeof attempt>>;
const create = (over: object = {}) => ({ title: 'Add it', body: 'Why', draft: true, base: 'main', ...over });
const ask = (run: Run, body: object) =>
    board.app.inject({
        method: 'POST',
        url: `/api/jobs/${run.id}/pull-request`,
        headers: { ...driverBearer, 'content-type': 'application/json' },
        payload: { leaseToken: run.leaseToken, branch: run.branch, base: 'main', ...body },
    });
const publish = (run: Run, over: object = {}) =>
    ask(run, { create: create(), edit: { title: 'Add it', body: 'Why' }, ...over });
const mrs = async () =>
    (await gl().send('GET', `/api/v4/projects/${encoded()}/merge_requests?state=all`, { token: await memberToken() }))
        .body as Array<{ iid: number; title: string; draft: boolean; description: string; target_branch: string }>;
const memberToken = async () => {
    const token = await board.grants.accessToken(org.id, org.memberId, FORGE);
    if (!token.ok) throw new Error('no member token');
    return token.accessToken;
};
const mrWrites = () =>
    gl()
        .forge.calls()
        .filter((call) => call.path.includes('/merge_requests') && call.method !== 'GET');
const waits = (id: string) =>
    sql<
        { reason: string; target: string | null; satisfied_at: Date | null }[]
    >`select reason, target, satisfied_at from job_integration_requirement where root_job_id = ${id} order by created_at`;

describe.skipIf(!enabled)('the board writes a GitLab merge request', () => {
    it('creates a draft as the member’s own user token, never reaching GitHub', async () => {
        const run = await attempt();
        const res = await publish(run);
        expect(res.statusCode, res.body).toBe(OK);
        expect(res.json()).toMatchObject({ answer: 'pr', operation: 'created', url: expect.stringMatching(MR_URL) });
        const [post] = mrWrites();
        expect(post).toMatchObject({ method: 'POST', holder: MEMBER, tokenKind: 'user' });
        expect((await mrs())[0]).toMatchObject({ title: 'Draft: Add it', draft: true });
        expect(reached).toEqual([]);
        expect(mints).toEqual([]);
        expect(await waits(run.id)).toEqual([]);
    });

    it('views by source branch: reused for a branch with an MR, none for one without', async () => {
        const run = await attempt();
        expect((await ask(run, {})).json()).toEqual({ answer: 'none' });
        await publish(run);
        const written = mrWrites().length;
        expect((await ask(run, {})).json()).toMatchObject({ answer: 'pr', operation: 'reused' });
        expect(mrWrites()).toHaveLength(written);
    });

    it('updates a second ask’s title and description and keeps the MR a draft', async () => {
        const run = await attempt();
        await publish(run);
        const res = await ask(run, { edit: { title: 'Better', body: 'New body' } });
        expect(res.json()).toMatchObject({ answer: 'pr', operation: 'reused' });
        expect(await mrs()).toMatchObject([{ title: 'Draft: Better', description: 'New body', draft: true }]);
    });

    it('retargets when the top-level base differs', async () => {
        const run = await attempt();
        await gl().control('gitlab/commit', {
            project: project(),
            branch: 'next',
            files: { 'n.txt': 'n' },
            message: 'n',
        });
        await publish(run);
        const res = await ask(run, { base: 'next' });
        expect(res.json()).toMatchObject({ answer: 'pr', operation: 'reused' });
        expect(await mrs()).toMatchObject([{ target_branch: 'next' }]);
    });

    it('replays a lost board answer to the same MR: one MR on the fake', async () => {
        const run = await attempt();
        const first = (await publish(run)).json<{ number: number }>();
        const replay = (await publish(run)).json<{ answer: string; operation: string; number: number }>();
        expect(replay).toMatchObject({ answer: 'pr', operation: 'reused', number: first.number });
        expect(await mrs()).toHaveLength(1);
    });

    it('never opens two when GitLab’s answer to the create is lost: reused, or 503 and a retry that reuses', async () => {
        const run = await attempt();
        await gl().control('gitlab/faults', { mode: 'lost', pathIncludes: 'merge_requests', after: 1, count: 1 });
        const first = await publish(run);
        expect([OK, UNAVAILABLE]).toContain(first.statusCode);
        if (first.statusCode === OK) expect(first.json()).toMatchObject({ operation: 'reused' });
        const retry = await publish(run);
        expect(retry.json()).toMatchObject({ answer: 'pr', operation: 'reused' });
        expect(await mrs()).toHaveLength(1);
    });

    it('answers waiting/reconnect for a broken grant, opens the wait and writes nothing', async () => {
        const run = await attempt();
        await sql`update integration_grant set status = 'reconnect_required' where org_id = ${org.id}
                  and principal_user_id = ${org.memberId}`;
        const res = await publish(run);
        expect(res.json()).toEqual({ answer: 'waiting', forge: FORGE, reason: 'reconnect' });
        expect(await waits(run.id)).toMatchObject([{ target: FORGE, reason: 'reconnect', satisfied_at: null }]);
        expect(await mrs().catch(() => [])).toEqual([]);
    });

    it('answers 503 for a GitLab 5xx on the create: no wait, the grant stays, nothing concluded', async () => {
        const run = await attempt();
        await gl().control('gitlab/faults', {
            mode: 'status',
            status: 500,
            pathIncludes: 'merge_requests',
            after: 1,
            count: 1,
        });
        const res = await publish(run);
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE' });
        expect(await waits(run.id)).toEqual([]);
        const [grant] = await sql<{ status: string }[]>`select status from integration_grant where org_id = ${org.id}
                  and principal_user_id = ${org.memberId}`;
        expect(grant?.status).toBe('active');
    });

    it('waits as forge-access when the member lost Developer, and a later write closes it', async () => {
        const run = await attempt();
        await gl().control('gitlab/members', { project: project(), login: MEMBER, projectAccess: 20 });
        const res = await publish(run);
        expect(res.json()).toEqual({ answer: 'waiting', forge: FORGE, reason: 'forge-access' });
        expect(await waits(run.id)).toMatchObject([{ reason: 'forge-access', satisfied_at: null }]);
        await gl().control('gitlab/members', { project: project(), login: MEMBER, projectAccess: 30 });
        expect((await publish(run)).json()).toMatchObject({ answer: 'pr', operation: 'created' });
        expect(await waits(run.id)).toMatchObject([{ reason: 'forge-access', satisfied_at: expect.any(Date) }]);
    });

    it('reaches the instance with the connection’s CA bundle on every call', async () => {
        const run = await attempt();
        await publish(run);
        expect(seenCa.length).toBeGreaterThan(0);
        expect(seenCa.every((ca) => ca === CA_PEM)).toBe(true);
    });

    it('records the MR as the task’s publication, on its nested repo path, and as a pr-operation', async () => {
        const run = await attempt();
        const { number } = (await publish(run)).json<{ number: number }>();
        // The fake answers with its own loopback origin; a task reports the MR on the repo's host, as the lane's TLS fake does.
        const made = { number, url: `https://${HOST}/${project()}/-/merge_requests/${number}` };
        const operationId = randomUUID();
        const recorded = await board.app.inject({
            method: 'POST',
            url: `/api/jobs/${run.id}/pr-operation`,
            headers: { ...driverBearer, 'content-type': 'application/json' },
            payload: {
                leaseToken: run.leaseToken,
                operationId,
                operation: 'created',
                repo: project(),
                prNumber: made.number,
                prUrl: made.url,
                branch: run.branch,
            },
        });
        expect(recorded.statusCode, recorded.body).toBe(OK);
        const [operation] = await sql<{ repo: string; pr_url: string }[]>`
            select repo, pr_url from job_pr_operation where job_id = ${run.id}`;
        expect(operation).toEqual({ repo: project(), pr_url: made.url });

        const done = await board.app.inject({
            method: 'POST',
            url: `/api/jobs/${run.id}/complete`,
            headers: { ...driverBearer, 'content-type': 'application/json' },
            payload: {
                leaseToken: run.leaseToken,
                status: 'succeeded',
                exitCode: 0,
                output: 'done',
                publication: {
                    repo: project(),
                    prNumber: made.number,
                    prUrl: made.url,
                    headBranch: run.branch,
                    baseBranch: 'main',
                },
            },
        });
        expect(done.statusCode, done.body).toBe(OK);
        const [recordedPr] = await sql<{ repo: string; pr_number: number; pr_url: string }[]>`
            select repo, pr_number, pr_url from job_pr where root_job_id = ${run.id}`;
        expect(recordedPr).toEqual({ repo: project(), pr_number: made.number, pr_url: made.url });
    });

    it('refuses a publication naming an MR on another GitLab host as BAD_PUBLICATION', async () => {
        const run = await attempt();
        const made = (await publish(run)).json<{ number: number }>();
        const done = await board.app.inject({
            method: 'POST',
            url: `/api/jobs/${run.id}/complete`,
            headers: { ...driverBearer, 'content-type': 'application/json' },
            payload: {
                leaseToken: run.leaseToken,
                status: 'succeeded',
                exitCode: 0,
                output: 'done',
                publication: {
                    repo: project(),
                    prNumber: made.number,
                    prUrl: `https://other.gitlab.test/${project()}/-/merge_requests/${made.number}`,
                    headBranch: run.branch,
                    baseBranch: 'main',
                },
            },
        });
        expect([done.statusCode, done.json().code]).toEqual([400, 'BAD_PUBLICATION']);
    });
});
