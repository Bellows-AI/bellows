import { randomUUID } from 'node:crypto';
import { gitlabForgeOf } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { createForgeGate } from '../src/forge/forge-gate.js';
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
import { startRow } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The start gate for a GitLab repo (docs/gitlab.md): the acting member holds a live grant keyed `gitlab:<host>` AND
 * the instance says they hold Developer or more on the project (the maximum of their project and group access). A
 * confirmed lack is a 409 `FORGE_ACCESS_DENIED`; an access check that cannot be confirmed (5xx, a malformed answer, a
 * timeout, a refused token) is a 503 the caller retries, never a refusal. Tasks are created through the real routes.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const CREATED_OR_ACCEPTED = [200, 201, 202];
const CONFLICT = 409;
const UNAVAILABLE = 503;
const REPORTER = 20;
const DEVELOPER = 30;
const FORGE = gitlabForgeOf(HOST);

let sql: Sql;
let h: Harness & { stop(): Promise<void> };
let board: Board;
let org: Org;
let grp: string;
let id: string;

beforeAll(async () => {
    if (!enabled) return;
    h = await startHarness(() => db.sql);
});
beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    await resetHarness(h, sql);
    org = await h.newOrg();
    grp = `g${randomUUID().slice(0, 8)}`;
    await createUserExecutorStore({ sql, orgId: org.id, ...testSecretDeps(sql) }).createOrg({
        name: 'main',
        type: 'claude-code',
        config: {},
        createdBy: org.adminId,
    });
    board = await h.board();
    await h.fake.control('gitlab/projects', { path: `${grp}/web` });
    id = await h.connect(org, { groups: [grp] });
    expect((await board.activate(org, id)).result).toBe('activated');
    const picked = await board.app.inject({
        method: 'PUT',
        url: `/api/org/gitlab-connections/${id}/tracked-repos`,
        headers: bearer(org.admin),
        payload: { paths: [`${grp}/web`] },
    });
    expect(picked.statusCode).toBe(200);
});
afterEach(async () => {
    if (enabled) await board?.close();
});
afterAll(async () => {
    await h?.stop();
});

const repo = () => ({ forge: 'gitlab', host: HOST, path: `${grp}/web` });
const create = (token = org.member) =>
    board.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: bearer(token),
        payload: { repo: repo(), command: 'work' },
    });
const jobCount = async () => Number((await sql`select count(*) from job where org_id = ${org.id}`)[0]!.count);
/** The member's level on the project, as the instance reports it for their GitLab login. */
const levels = (login: string, projectAccess: number | null, groupAccess: number | null = null) =>
    h.fake.control('gitlab/members', { project: `${grp}/web`, login, projectAccess, groupAccess });
const accessCalls = () =>
    h.fake.forge
        .calls()
        .filter((c) => c.method === 'GET' && c.path === `/api/v4/projects/${encodeURIComponent(`${grp}/web`)}`);

describe.skipIf(!enabled)('creating a task on a tracked GitLab project', () => {
    it('admits a linked member with Developer access: the task is queued on the GitLab repo', async () => {
        expect((await board.link(org, id, 'dev-one')).result).toBe('linked');
        await levels('dev-one', DEVELOPER);
        const res = await create();
        expect(CREATED_OR_ACCEPTED).toContain(res.statusCode);
        const [job] = await sql<{ forge: string; host: string; repo: string }[]>`
            select forge, host, repo from job where org_id = ${org.id}
        `;
        expect(job).toEqual({ forge: 'gitlab', host: HOST, repo: `${grp}/web` });
        // The check was the member's own token, not the admin's or an App's.
        expect(accessCalls().length).toBe(1);
        expect(accessCalls()[0]).toMatchObject({ holder: 'dev-one' });
    });

    it('takes the group role when it is the higher: project Reporter, group Maintainer', async () => {
        await board.link(org, id, 'dev-one');
        await levels('dev-one', REPORTER, 40);
        expect(CREATED_OR_ACCEPTED).toContain((await create()).statusCode);
    });

    it('refuses a member with no GitLab grant: 409 FORGE_GRANT_REQUIRED naming the gitlab forge and the settings page', async () => {
        const res = await create();
        expect(res.statusCode).toBe(CONFLICT);
        const body = res.json<{ code: string; forge: string; standing: string; connectUrl: string; error: string }>();
        expect(body).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', forge: FORGE, standing: 'missing' });
        expect(new URL(body.connectUrl).pathname).toBe('/settings/integrations/gitlab');
        expect(new URL(body.connectUrl).searchParams.get('org')).toBe(org.id);
        expect(body.error).toContain(body.connectUrl);
        expect(await jobCount()).toBe(0);
        expect(accessCalls()).toHaveLength(0);
    });

    it('refuses a member whose grant needs reconnecting: standing broken', async () => {
        await board.link(org, id, 'dev-one');
        await sql`update integration_grant set status = 'reconnect_required' where org_id = ${org.id}
                  and principal_user_id = ${org.memberId}`;
        const res = await create();
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', forge: FORGE, standing: 'broken' });
    });

    it.each([
        { name: 'Reporter', project: REPORTER, group: null },
        { name: 'Guest by group', project: null, group: 10 },
        { name: 'no membership', project: null, group: null },
    ])('refuses $name with 409 FORGE_ACCESS_DENIED and creates nothing', async ({ project, group }) => {
        await board.link(org, id, 'dev-one');
        await levels('dev-one', project, group);
        const res = await create();
        expect(res.statusCode).toBe(CONFLICT);
        const body = res.json<{ code: string; forge: string; connectUrl: string; error: string; repo: string }>();
        expect(body).toMatchObject({ code: 'FORGE_ACCESS_DENIED', forge: FORGE });
        expect(body.error).toContain(`${grp}/web`);
        expect(new URL(body.connectUrl).pathname).toBe('/settings/integrations/gitlab');
        expect(await jobCount()).toBe(0);
    });

    it('refuses a project the member cannot see (the instance answers 404) as a denial', async () => {
        await board.link(org, id, 'dev-one');
        await h.fake.control('gitlab/projects', { path: `${grp}/hidden` });
        await h.fake.control('gitlab/members', { project: `${grp}/hidden`, login: 'dev-one', projectAccess: null });
        await sql`insert into tracked_repo (org_id, owner, name, forge, host) values (${org.id}, ${grp}, 'hidden', 'gitlab', ${HOST})`;
        const res = await board.app.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: bearer(org.member),
            payload: { repo: { forge: 'gitlab', host: HOST, path: `${grp}/hidden` }, command: 'work' },
        });
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_ACCESS_DENIED' });
    });

    it.each([
        { name: 'a 5xx', fault: { mode: 'status', status: 502 } },
        { name: 'a 401', fault: { mode: 'status', status: 401 } },
        { name: 'a malformed body', fault: { mode: 'malformed' } },
        { name: 'no answer', fault: { mode: 'timeout' } },
    ])('answers 503, never a refusal, when the access check gets $name; a retry then admits', async ({ fault }) => {
        await board.link(org, id, 'dev-one');
        await levels('dev-one', DEVELOPER);
        await h.fake.control('gitlab/faults', { ...fault, pathIncludes: '/api/v4/projects/', count: 1 });
        const first = await create();
        expect(first.statusCode).toBe(UNAVAILABLE);
        expect(first.json()).toMatchObject({ code: 'UNAVAILABLE' });
        expect(await jobCount()).toBe(0);
        // No standing was concluded from the failure: nothing was held, and the very next ask is judged afresh.
        expect(CREATED_OR_ACCEPTED).toContain((await create()).statusCode);
        expect(await jobCount()).toBe(1);
    });

    it('a failed access check never turns into a denial even for a member who truly lacks access, until it answers', async () => {
        await board.link(org, id, 'dev-one');
        await levels('dev-one', REPORTER);
        await h.fake.control('gitlab/faults', {
            mode: 'status',
            status: 500,
            pathIncludes: '/api/v4/projects/',
            count: 1,
        });
        expect((await create()).statusCode).toBe(UNAVAILABLE);
        expect((await create()).json()).toMatchObject({ code: 'FORGE_ACCESS_DENIED' });
    });

    it('says what the check would decide in a preflight, without refusing: blocked, ok, unverified', async () => {
        await board.link(org, id, 'dev-one');
        const preflight = async () => {
            const res = await board.app.inject({
                method: 'POST',
                url: '/api/jobs/preflight',
                headers: bearer(org.member),
                payload: { repo: repo() },
            });
            expect(res.statusCode).toBe(200);
            return res
                .json<{ checks: { subject: string; status: string; code?: string }[] }>()
                .checks.find((c) => c.subject === 'forge');
        };
        await levels('dev-one', REPORTER);
        expect(await preflight()).toMatchObject({ status: 'blocked', code: 'FORGE_ACCESS_DENIED' });
        await levels('dev-one', DEVELOPER);
        expect(await preflight()).toMatchObject({ status: 'ok' });
        await h.fake.control('gitlab/faults', {
            mode: 'status',
            status: 503,
            pathIncludes: '/api/v4/projects/',
            count: 1,
        });
        expect(await preflight()).toMatchObject({ status: 'unverified' });
    });

    it('gates a follow-up on the thread’s repo as well', async () => {
        await board.link(org, id, 'dev-one');
        await levels('dev-one', DEVELOPER);
        const created = await create();
        const jobId = created.json<{ id: string }>().id;
        await startRow(sql, jobId);
        await sql`update job set status = 'succeeded', finished_at = now(), started_at = now(), session_id = ${randomUUID()},
                  lease_token = null where id = ${jobId}`;
        await levels('dev-one', REPORTER);
        const res = await board.app.inject({
            method: 'POST',
            url: `/api/jobs/${jobId}/follow-up`,
            headers: bearer(org.member),
            payload: { command: 'more' },
        });
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_ACCESS_DENIED' });
    });
});

describe.skipIf(!enabled)('a batch task retry on a GitLab target', () => {
    const draft = async () => {
        const plan = {
            planVersion: 1,
            title: 'One repo',
            targets: [{ key: 'web', repo: repo() }],
            defaultTarget: 'web',
            stages: [
                {
                    key: 'one',
                    tasks: [{ key: 'a', objective: 'do a', acceptance: 'it works', verification: 'npm test' }],
                },
            ],
        };
        const res = await board.app.inject({
            method: 'POST',
            url: '/api/batches',
            headers: bearer(org.member),
            payload: { plan },
        });
        expect(res.statusCode, res.body).toBe(201);
        return res.json<{ id: string }>().id;
    };
    const retry = (batch: string) =>
        board.app.inject({
            method: 'POST',
            url: `/api/batches/${batch}/tasks/a/retry`,
            headers: bearer(org.member),
            payload: {},
        });

    it('is judged on the target project: Reporter is a denial, an unconfirmed check is a 503', async () => {
        await board.link(org, id, 'dev-one');
        const batch = await draft();
        await levels('dev-one', REPORTER);
        const denied = await retry(batch);
        expect(denied.statusCode).toBe(CONFLICT);
        expect(denied.json()).toMatchObject({ code: 'FORGE_ACCESS_DENIED', forge: FORGE });
        await h.fake.control('gitlab/faults', {
            mode: 'status',
            status: 500,
            pathIncludes: '/api/v4/projects/',
            count: 1,
        });
        const unconfirmed = await retry(batch);
        expect(unconfirmed.statusCode).toBe(UNAVAILABLE);
        expect(unconfirmed.json()).toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('refuses a member with no grant with FORGE_GRANT_REQUIRED', async () => {
        const batch = await draft();
        const res = await retry(batch);
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', forge: FORGE });
    });
});

describe('the gate without member grants', () => {
    it('is absent (AUTH_MODE=none): nothing is gated and no GitLab call is made', () => {
        expect(createForgeGate({ memberGrants: undefined, publicUrl: '' })).toBeUndefined();
    });
});
