import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/session.js';
import { type AuthStore, createAuthStore } from '../src/auth/store.js';
import { createBatchStore } from '../src/db/batches/batch-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { createMemberForgeGrants, type MemberForgeGrants } from '../src/integrations/member-forge-grant.js';
import { GITHUB_FORGE } from '../src/integrations/providers/github-user.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import { createOrgRegistry } from '../src/orgs.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { staticRegistry, stubTelemetryClient, telemetryStoreStub } from '../test/helpers.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { testSecretDeps, testSecretStore } from './env-secrets-harness.js';
import { randomGithubId, startRow, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The forge start gate at the job routes (docs/connections.md): no run starts or continues on a repo unless the member
 * who asks holds a live grant for its forge. The refusal is a 409 `FORGE_GRANT_REQUIRED` naming the forge, the
 * member's standing and the connect URL; a standing read that cannot be confirmed is a 503, never a refusal. The real
 * registry, stores and grant reader are composed as main.ts composes them.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK_STATUSES = [200, 201, 202];
const CONFLICT = 409;
const UNAVAILABLE = 503;
const REPO = 'gate-owner/web';
const PUBLIC_URL = 'http://127.0.0.1:8080';

interface Person {
    userId: string;
    githubUserId: number;
    token: string;
}

let sql: Sql;
let auth: AuthStore;
let org: string;
let admin: Person;
let member: Person;
let realGrants: MemberForgeGrants;

async function personIn(orgId: string): Promise<Person> {
    const githubUserId = randomGithubId();
    const login = `u-${randomUUID().slice(0, 8)}`;
    const caller = await auth.signIn({ githubUserId, login, displayName: login, avatarUrl: null }, orgId, [
        { id: orgId, name: `acct-${orgId}` },
    ]);
    const token = `fat_${randomUUID()}`;
    await auth.createAccessToken({
        kind: 'personal',
        orgId,
        userId: caller.user.id,
        createdBy: caller.user.id,
        label: 'gate',
        tokenHash: hashToken(token),
    });
    return { userId: caller.user.id, githubUserId, token };
}

/** The member's grant as the lineage leaves it: `active` with a stored secret, or `reconnect_required`. */
async function seedGrant(who: Person, status: 'active' | 'reconnect_required'): Promise<void> {
    await sql`
        insert into integration_grant
            (org_id, principal_kind, principal_user_id, provider, external_account_id, authority, status,
             secret_ref, secret_version)
        values (${org}, 'user', ${who.userId}, ${GITHUB_FORGE}, ${String(who.githubUserId)}, '{}'::jsonb, ${status},
                ${`ref-${randomUUID()}`}, 'v1')
    `;
}

async function boot(grants: MemberForgeGrants): Promise<FastifyInstance> {
    const ready = Promise.resolve();
    const config = testConfig({
        auth: githubAuth({ publicUrl: PUBLIC_URL }),
        deploymentMode: 'cloud',
        platformModelProvided: true,
    });
    return buildApp({
        config,
        orgs: createOrgRegistry({
            sql,
            ready,
            config,
            withStores: true,
            secrets: testSecretStore(sql),
            secretLog: () => {},
        }),
        auth,
        memberGrants: grants,
        ready,
        version: '0.0.0',
    });
}

let app: FastifyInstance;

beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    auth = createAuthStore({ sql });
    org = testOrg();
    // The org's first account is its admin.
    admin = await personIn(org);
    member = await personIn(org);
    await createUserExecutorStore({ sql, orgId: org, ...testSecretDeps(sql) }).createOrg({
        name: 'main',
        type: 'claude-code',
        config: {},
        createdBy: admin.userId,
    });
    await sql`insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
              values (${org}, 'claude-code', ${`gate-${randomUUID()}`}, ${REPO}, 'main', now(), now())`;
    realGrants = createMemberForgeGrants({
        sql,
        crossOrgSql: sql,
        secrets: testSecretStore(sql),
        lineageOf: () => {
            throw new Error('the gate never refreshes');
        },
    });
    app = await boot(realGrants);
});

afterEach(async () => {
    if (enabled) await app?.close();
});

const call = (who: Person, url: string, payload: object = {}) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${who.token}` }, payload });

const jobCount = async (): Promise<number> =>
    Number((await sql`select count(*) from job where org_id = ${org}`)[0]!.count);

/** A thread of `owner`'s the route under test can act on. */
async function thread(owner: Person, state: 'succeeded' | 'failed' | 'done'): Promise<string> {
    const store = createJobStore({ sql, orgId: org });
    const created = await store.create('seed work', owner.userId, { repo: REPO, executor: null });
    if (typeof created === 'string') throw new Error(`seed refused: ${created}`);
    await startRow(sql, created.id);
    await sql`
        update job set status = ${state === 'failed' ? 'failed' : 'succeeded'}, finished_at = now(),
            started_at = now(), session_id = ${randomUUID()}, lease_token = null,
            done_at = ${state === 'done' ? sql`now()` : null}
        where id = ${created.id}
    `;
    return created.id;
}

interface Route {
    name: string;
    /** The thread the route acts on, seeded for `owner` (none for a create). */
    prepare: (owner: Person) => Promise<string>;
    call: (who: Person, id: string) => Promise<{ statusCode: number; json: () => Record<string, unknown> }>;
}

const ROUTES: Route[] = [
    {
        name: 'POST /api/jobs',
        prepare: async () => '',
        call: (who) => call(who, '/api/jobs', { repo: REPO, command: 'work' }),
    },
    {
        name: 'POST /api/jobs/:id/follow-up',
        prepare: (owner) => thread(owner, 'succeeded'),
        call: (who, id) => call(who, `/api/jobs/${id}/follow-up`, { command: 'more' }),
    },
    {
        name: 'POST /api/jobs/:id/retry',
        prepare: (owner) => thread(owner, 'failed'),
        call: (who, id) => call(who, `/api/jobs/${id}/retry`),
    },
    {
        name: 'POST /api/jobs/:id/reopen',
        prepare: (owner) => thread(owner, 'done'),
        call: (who, id) => call(who, `/api/jobs/${id}/reopen`),
    },
];

describe.skipIf(!enabled).each(ROUTES)('$name', ({ prepare, call: act }) => {
    const run = async (who: Person, owner: Person) => act(who, await prepare(owner));
    it('refuses a member with no grant: 409 FORGE_GRANT_REQUIRED, missing, with a connect URL', async () => {
        const res = await run(member, member);
        expect(res.statusCode).toBe(CONFLICT);
        const body = res.json() as { code: string; forge: string; standing: string; connectUrl: string; error: string };
        expect(body).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', forge: 'github', standing: 'missing' });
        expect(body.connectUrl.startsWith(`${PUBLIC_URL}/api/auth/github?`)).toBe(true);
        expect(new URL(body.connectUrl).searchParams.get('org')).toBe(org);
        expect(body.error).toContain(body.connectUrl);
    });

    it('refuses a member whose grant needs reconnecting: standing broken', async () => {
        await seedGrant(member, 'reconnect_required');
        const res = await run(member, member);
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', standing: 'broken' });
    });

    it('admits a member with a live grant', async () => {
        await seedGrant(member, 'active');
        const res = await run(member, member);
        expect(OK_STATUSES).toContain(res.statusCode);
    });

    it('answers 503 UNAVAILABLE when the standing cannot be read, and queues nothing', async () => {
        await app.close();
        app = await boot({
            ...realGrants,
            standing: async () => {
                throw new Error('database blip');
            },
        });
        const id = await prepare(member);
        const before = await jobCount();
        const res = await act(member, id);
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE' });
        expect(await jobCount()).toBe(before);
    });

    it('judges the REQUESTER: an admin with a live grant acts on a member whose grant is broken', async () => {
        await seedGrant(member, 'reconnect_required');
        await seedGrant(admin, 'active');
        const res = await run(admin, member);
        expect(OK_STATUSES).toContain(res.statusCode);
    });

    it('judges the REQUESTER: an admin with no grant is refused', async () => {
        await seedGrant(member, 'active');
        const res = await run(admin, member);
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', standing: 'missing' });
    });
});

// One target: a plan across repositories is refused before the gate (BATCH_UNSUPPORTED multi_target) until batches
// run on more than one; the gate itself judges every distinct forge of the plan's targets.
const PLAN = {
    planVersion: 1,
    title: 'One repo',
    targets: [{ key: 'web', repo: REPO }],
    defaultTarget: 'web',
    stages: [
        {
            key: 'one',
            tasks: ['a', 'b'].map((key) => ({
                key,
                objective: `do ${key}`,
                acceptance: 'it works',
                verification: 'npm test',
            })),
        },
    ],
};

/** The app over the real job and batch stores, with a repo source that knows both target repos' default branches. */
async function bootBatches(grants: MemberForgeGrants): Promise<FastifyInstance> {
    const config = testConfig({ auth: githubAuth({ publicUrl: PUBLIC_URL }), batches: { enabled: true } });
    const jobs = createJobStore({ sql, orgId: org });
    const batches = createBatchStore({
        sql,
        orgId: org,
        stop: (id, by) => jobs.stop(id, by),
        close: (id, by) => jobs.markDone(id, by),
    });
    const base = staticRepoSource([{ owner: 'gate-owner', name: 'web' }]);
    const repos = {
        ...base,
        detail: async () => ({
            repos: ['web'].map((name) => ({
                owner: 'gate-owner',
                name,
                defaultBranch: 'main',
                private: false,
                pushedAt: null,
            })),
            installation: null,
            error: null,
        }),
    };
    return buildApp({
        config,
        orgs: staticRegistry({ config, repos, jobs, batches, telemetry: stubTelemetryClient() }),
        store: telemetryStoreStub(),
        auth,
        memberGrants: grants,
    });
}

const batchCounts = async () => ({
    jobs: Number((await sql`select count(*) from job where org_id = ${org}`)[0]!.count),
    tasks: Number((await sql`select count(*) from batch_task where org_id = ${org}`)[0]!.count),
});

const draftStatusOf = async (id: string) =>
    (await sql<{ status: string }[]>`select status from batch where org_id = ${org} and id = ${id}`)[0]!.status;

describe.skipIf(!enabled)('a batch launch', () => {
    const draft = async (who: Person): Promise<string> => {
        const res = await call(who, '/api/batches', { plan: PLAN });
        expect(res.statusCode, res.body).toBe(201);
        return (res.json() as { id: string }).id;
    };

    beforeEach(async () => {
        await app.close();
        app = await bootBatches(realGrants);
    });

    it('refuses the whole start up front when the starter has no grant, and writes nothing', async () => {
        const id = await draft(member);
        const before = await batchCounts();
        const res = await call(member, `/api/batches/${id}/start`, { version: 1 });
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', forge: 'github', standing: 'missing' });
        expect(await batchCounts()).toEqual(before);
        expect(await draftStatusOf(id)).toBe('draft');
    });

    it('validates with the same refusal', async () => {
        const id = await draft(member);
        const res = await call(member, `/api/batches/${id}/validate`);
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', standing: 'missing' });
    });

    it('refuses a batch task retry from a requester with no grant', async () => {
        const id = await draft(member);
        await seedGrant(admin, 'active');
        const res = await call(member, `/api/batches/${id}/tasks/a/retry`);
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED' });
    });

    it('answers 503 when the standing cannot be read, and the draft stays a draft', async () => {
        const id = await draft(member);
        await app.close();
        app = await bootBatches({
            ...realGrants,
            standing: async () => {
                throw new Error('database blip');
            },
        });
        const res = await call(member, `/api/batches/${id}/start`, { version: 1 });
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE' });
        expect(await draftStatusOf(id)).toBe('draft');
    });

    it('starts when the starter holds a live grant', async () => {
        await seedGrant(member, 'active');
        const id = await draft(member);
        const res = await call(member, `/api/batches/${id}/start`, { version: 1 });
        expect(res.statusCode, res.body).toBe(200);
    });
});

describe.skipIf(!enabled)('preflight', () => {
    const preflight = (who: Person) => call(who, '/api/jobs/preflight', { repo: REPO });
    type Check = { subject: string; name: string | null; status: string; code?: string; detail: string };

    it('reports a missing grant as a blocked forge check, with the connect URL', async () => {
        const res = await preflight(member);
        const body = res.json() as { ready: boolean; checks: Check[] };
        expect(body.ready).toBe(false);
        const check = body.checks.find((c) => c.subject === 'forge');
        expect(check).toMatchObject({ name: 'github', status: 'blocked', code: 'FORGE_GRANT_REQUIRED' });
        expect(check!.detail).toContain(`${PUBLIC_URL}/api/auth/github?`);
        expect(check!.detail).toContain('missing');
    });

    it('says the connection needs reconnecting when the grant is broken', async () => {
        await seedGrant(member, 'reconnect_required');
        const body = (await preflight(member)).json() as { checks: Check[] };
        expect(body.checks.find((c) => c.subject === 'forge')).toMatchObject({ status: 'blocked' });
        expect(body.checks.find((c) => c.subject === 'forge')!.detail).toContain('reconnecting');
    });

    it('reports an unreadable standing as unverified, never blocked', async () => {
        await app.close();
        app = await boot({
            ...realGrants,
            standing: async () => {
                throw new Error('database blip');
            },
        });
        const body = (await preflight(member)).json() as { checks: Check[] };
        expect(body.checks.find((c) => c.subject === 'forge')).toMatchObject({ status: 'unverified' });
    });

    it('reports the forge check ok when the grant is live', async () => {
        await seedGrant(member, 'active');
        const body = (await preflight(member)).json() as { ready: boolean; checks: Check[] };
        expect(body.checks.find((c) => c.subject === 'forge')).toMatchObject({ status: 'ok' });
    });
});
