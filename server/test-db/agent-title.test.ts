import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { createAuthStore } from '../src/auth/store.js';
import { type AttemptOfLease, createAttemptOfLease } from '../src/db/attempt-of-lease.js';
import { createAgentTitle } from '../src/db/agent-title.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { createOrgRegistry } from '../src/orgs.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { useTestDb } from './harness.js';
import { expireLease, testOrg, testUser } from './fixtures.js';

/**
 * The agent's own title write (BEL-252, `POST /api/jobs/:id/agent-title`) on a real database: the
 * attempt pair is the only credential, the write runs under the caller's own row lock and the thread
 * root's, and every precondition is re-checked under those locks.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const AUTHOR = testUser('agent-title-author');
const LEASE_SECONDS = 300;
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY = 429;
const HTTP_UNAVAILABLE = 503;
const CAP = 5;
const BLOCKED_MS = 150;

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [AUTHOR], max: 12 });

let sql: Sql;
let jobs: JobStore;
let otherJobs: JobStore;
let check: AttemptOfLease;
let wrapped: AttemptOfLease;
let afterCheck: ((jobId: string) => Promise<void>) | undefined;
let app: FastifyInstance | undefined;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    jobs = createJobStore({ sql, orgId: ORG });
    otherJobs = createJobStore({ sql, orgId: OTHER_ORG });
    check = createAttemptOfLease({ sql });
    // The seam for a rotation landing between the pair check and the write.
    wrapped = async (jobId, token) => {
        const answer = await check(jobId, token);
        await afterCheck?.(jobId);
        return answer;
    };
});

afterEach(async () => {
    afterCheck = undefined;
    await app?.close();
    app = undefined;
});

async function boot(): Promise<FastifyInstance> {
    const ready = Promise.resolve();
    const config = testConfig({ auth: githubAuth() });
    app = await buildApp({
        config,
        orgs: createOrgRegistry({ sql, ready, config, withStores: false }),
        auth: createAuthStore({ sql, ready }),
        attemptOfLease: wrapped,
        agentTitle: createAgentTitle({ sql, ready }),
        ready,
        version: '0.0.0',
        logger: false,
    });
    return app;
}

const join = (org: string) =>
    sql`insert into org_membership (org_id, github_login, user_id) values (${org}, ${AUTHOR.login}, ${AUTHOR.id})
        on conflict do nothing`;

async function running(store: JobStore = jobs, org: string = ORG): Promise<{ id: string; claim: Claim }> {
    await join(org);
    const ref = await store.create('push the fix', AUTHOR.id, { repo: null, executor: null });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    const claim = (await store.claim('w1', LEASE_SECONDS)) as Claim;
    expect(claim.id).toBe(ref.id);
    return { id: ref.id, claim };
}

async function put(id: string, token: string, title: unknown) {
    const instance = app ?? (await boot());
    const res = await instance.inject({
        method: 'POST',
        url: `/api/jobs/${id}/agent-title`,
        headers: { 'x-factory-job-id': id, 'x-factory-job-lease-token': token },
        payload: { title },
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

const titleRow = async (id: string) => {
    const [row] = await sql<
        { title: string | null; title_origin: string | null; title_revision: number }[]
    >`select title, title_origin, title_revision from job where id = ${id}`;
    return row!;
};

const events = (root: string) =>
    sql<
        {
            origin: string;
            title: string;
            job_id: string | null;
            claim_seq: string | null;
            actor_user_id: string | null;
        }[]
    >`
        select origin, title, job_id, claim_seq, actor_user_id from job_title_event
        where root_job_id = ${root} order by revision
    `;

const reclaim = async (id: string): Promise<Claim> => {
    await expireLease(sql, id);
    const next = (await jobs.claim('w2', LEASE_SECONDS)) as Claim;
    expect(next.id).toBe(id);
    return next;
};

/** Resolves when `promise` is still pending after `ms`: the transaction behind it is waiting on a lock. */
const stillPending = async (promise: Promise<unknown>, ms = BLOCKED_MS) => {
    const marker = Symbol('pending');
    return (await Promise.race([promise, new Promise((r) => setTimeout(() => r(marker), ms))])) === marker;
};

describe.skipIf(!enabled)('agent title — database', () => {
    it('a live pair sets the root title, origin agent, revision + 1, one audit row with job id and claim seq', async () => {
        const { id, claim } = await running();
        const res = await put(id, claim.leaseToken, '  Fix   the login redirect ');
        expect(res).toEqual({ status: HTTP_OK, body: { title: 'Fix the login redirect', updated: true, version: 1 } });
        expect(await titleRow(id)).toEqual({
            title: 'Fix the login redirect',
            title_origin: 'agent',
            title_revision: 1,
        });
        const [event] = await events(id);
        expect(event).toMatchObject({
            origin: 'agent',
            title: 'Fix the login redirect',
            job_id: id,
            actor_user_id: null,
        });
        expect(Number(event?.claim_seq)).toBe(claim.claimSeq);
    });

    it('an identical title is updated:false with no revision bump and no audit row', async () => {
        const { id, claim } = await running();
        await put(id, claim.leaseToken, 'Fix login');
        const again = await put(id, claim.leaseToken, 'Fix login');
        expect(again).toEqual({ status: HTTP_OK, body: { title: 'Fix login', updated: false, version: 1 } });
        expect((await titleRow(id)).title_revision).toBe(1);
        expect(await events(id)).toHaveLength(1);
    });

    it('a user title (renamed or set at create) is never overwritten: updated:false, user_title, the user title back', async () => {
        const renamed = await running();
        const done = await jobs.renameTask(renamed.id, { title: 'Mine', revision: 0, caller: AUTHOR.id });
        expect(done.ok).toBe(true);
        const refused = await put(renamed.id, renamed.claim.leaseToken, 'Agent idea');
        expect(refused).toEqual({
            status: HTTP_OK,
            body: { title: 'Mine', updated: false, reason: 'user_title', version: 1 },
        });
        expect(await titleRow(renamed.id)).toEqual({ title: 'Mine', title_origin: 'user', title_revision: 1 });
        expect(await events(renamed.id)).toHaveLength(1);

        const ref = await jobs.create('second', AUTHOR.id, { repo: null, executor: null, title: 'At create' });
        if (typeof ref === 'string') throw new Error(ref);
        const claim = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
        expect(claim.id).toBe(ref.id);
        const second = await put(ref.id, claim.leaseToken, 'Agent idea');
        expect(second.body).toMatchObject({ title: 'At create', updated: false, reason: 'user_title' });
    });

    it('an expired lease on a running task is 503 LEASE_PENDING and writes nothing', async () => {
        const { id, claim } = await running();
        await expireLease(sql, id);
        const res = await put(id, claim.leaseToken, 'Fix login');
        expect(res.status).toBe(HTTP_UNAVAILABLE);
        expect(res.body.code).toBe('LEASE_PENDING');
        expect((await titleRow(id)).title).toBeNull();
        expect(await events(id)).toHaveLength(0);
    });

    it('the superseded pair is 503 pending, a pair one takeover older is 403, nothing written', async () => {
        const first = await running();
        const second = await reclaim(first.id);
        const prior = await put(first.id, first.claim.leaseToken, 'Fix login');
        expect(prior.status).toBe(HTTP_UNAVAILABLE);
        expect(prior.body.code).toBe('LEASE_PENDING');
        const third = await reclaim(first.id);
        expect((await put(first.id, first.claim.leaseToken, 'Fix login')).status).toBe(HTTP_FORBIDDEN);
        expect((await put(first.id, second.leaseToken, 'Fix login')).status).toBe(HTTP_UNAVAILABLE);
        expect(await events(first.id)).toHaveLength(0);
        expect((await put(first.id, third.leaseToken, 'Fix login')).status).toBe(HTTP_OK);
    });

    it("a stopped, a finished, a reviewer row and another job's token are all 403", async () => {
        const stopped = await running();
        await sql`update job set cancel_requested_at = now() where id = ${stopped.id}`;
        expect((await put(stopped.id, stopped.claim.leaseToken, 'x')).status).toBe(HTTP_FORBIDDEN);

        const finished = await running();
        await jobs.session(finished.id, finished.claim.leaseToken, randomUUID());
        await jobs.complete(finished.id, finished.claim.leaseToken, { status: 'succeeded', exitCode: 0, output: '' });
        expect((await put(finished.id, finished.claim.leaseToken, 'x')).status).toBe(HTTP_FORBIDDEN);

        const reviewer = await running();
        await sql`update job set review_of = ${stopped.id}, review_key = 'k', review_profile = 'p', review_spec = '{}'::jsonb,
                      review_revision = 'r', review_ref = 'refs/x' where id = ${reviewer.id}`;
        expect((await put(reviewer.id, reviewer.claim.leaseToken, 'x')).status).toBe(HTTP_FORBIDDEN);

        const mine = await running();
        const theirs = await running(otherJobs, OTHER_ORG);
        expect((await put(mine.id, theirs.claim.leaseToken, 'x')).status).toBe(HTTP_FORBIDDEN);
        expect((await put(theirs.id, mine.claim.leaseToken, 'x')).status).toBe(HTTP_FORBIDDEN);
        for (const id of [stopped.id, finished.id, reviewer.id, mine.id, theirs.id]) {
            expect((await titleRow(id)).title).toBeNull();
        }
    });

    it('a lease rotated between the pair check and the write is answered pending and writes nothing', async () => {
        const { id, claim } = await running();
        afterCheck = async () => {
            await sql`update job set prior_lease_token = lease_token, lease_token = ${randomUUID()}, claim_seq = claim_seq + 1
                      where id = ${id}`;
        };
        const res = await put(id, claim.leaseToken, 'Fix login');
        expect(res.status).toBe(HTTP_UNAVAILABLE);
        expect(res.body.code).toBe('LEASE_PENDING');
        expect(await events(id)).toHaveLength(0);
        expect((await titleRow(id)).title).toBeNull();
    });

    it('a takeover rotating the executing row concurrently (holding its lock) makes the superseded attempt never write', async () => {
        const { id, claim } = await running();
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let locked!: () => void;
        const rotating = new Promise<void>((r) => (locked = r));
        const takeover = sql.begin(async (tx) => {
            await tx`select 1 from job where id = ${id} for update`;
            await tx`update job set prior_lease_token = lease_token, lease_token = ${randomUUID()}, claim_seq = claim_seq + 1
                     where id = ${id}`;
            locked();
            await held;
        });
        await rotating;
        const write = put(id, claim.leaseToken, 'Fix login');
        expect(await stillPending(write)).toBe(true);
        release();
        await takeover;
        const res = await write;
        expect(res.status).toBe(HTTP_UNAVAILABLE);
        expect(await events(id)).toHaveLength(0);
        expect((await titleRow(id)).title).toBeNull();
    });

    it('a takeover queued behind the title transaction waits for it (the write sees the lease it held)', async () => {
        const root = await running();
        await jobs.session(root.id, root.claim.leaseToken, randomUUID());
        await jobs.complete(root.id, root.claim.leaseToken, { status: 'succeeded', exitCode: 0, output: '' });
        const follow = await jobs.createFollowUp(root.id, 'again', AUTHOR.id);
        if (typeof follow === 'string') throw new Error(follow);
        const claim = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
        expect(claim.id).toBe(follow.id);

        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let locked!: () => void;
        const rootLocked = new Promise<void>((r) => (locked = r));
        const holder = sql.begin(async (tx) => {
            await tx`select 1 from job where id = ${root.id} for no key update`;
            locked();
            await held;
        });
        await rootLocked;
        // The title transaction takes its own row, then blocks on the held root.
        const write = put(follow.id, claim.leaseToken, 'Fix login');
        expect(await stillPending(write)).toBe(true);
        let rotated = false;
        const takeover = sql`update job set prior_lease_token = lease_token, lease_token = ${randomUUID()}
                             where id = ${follow.id}`.then(() => (rotated = true));
        expect(await stillPending(takeover)).toBe(true);
        expect(rotated).toBe(false);
        release();
        await holder;
        const res = await write;
        await takeover;
        expect(res.status).toBe(HTTP_OK);
        expect((await titleRow(root.id)).title).toBe('Fix login');
    });

    it("a user rename racing an agent write: the user's title is never overwritten by the agent", async () => {
        const { id, claim } = await running();
        const [rename, write] = await Promise.all([
            jobs.renameTask(id, { title: 'Mine', revision: 0, caller: AUTHOR.id }),
            put(id, claim.leaseToken, 'Agent idea'),
        ]);
        const row = await titleRow(id);
        if (rename.ok) {
            expect(row.title_origin).toBe('user');
            expect(row.title).toBe('Mine');
        } else {
            // The agent committed first: the rename's compare-and-set lost, nothing was overwritten.
            expect(rename).toMatchObject({ refusal: 'stale' });
            expect(row.title).toBe('Agent idea');
        }
        expect(write.status).toBe(HTTP_OK);
        const log = await events(id);
        expect(log.at(-1)?.title).toBe(row.title);
    });

    it('the cap: the 6th distinct change of one claim_seq is 429 TITLE_LIMIT, a new claim_seq resets', async () => {
        const { id, claim } = await running();
        for (let n = 1; n <= CAP; n += 1) {
            expect((await put(id, claim.leaseToken, `Title ${n}`)).body.updated).toBe(true);
        }
        const sixth = await put(id, claim.leaseToken, 'Title 6');
        expect(sixth.status).toBe(HTTP_TOO_MANY);
        expect(sixth.body.code).toBe('TITLE_LIMIT');
        // An identical title is no change, so it is not counted against the cap.
        expect((await put(id, claim.leaseToken, `Title ${CAP}`)).status).toBe(HTTP_OK);
        const next = await reclaim(id);
        expect((await put(id, next.leaseToken, 'Title 6')).body.updated).toBe(true);
    });

    it('a resumed attempt (new claim_seq) after a user rename cannot clobber it', async () => {
        const { id, claim } = await running();
        await put(id, claim.leaseToken, 'Agent first');
        const renamed = await jobs.renameTask(id, { title: 'Mine', revision: 1, caller: AUTHOR.id });
        expect(renamed.ok).toBe(true);
        const next = await reclaim(id);
        const res = await put(id, next.leaseToken, 'Agent again');
        expect(res.body).toMatchObject({ title: 'Mine', updated: false, reason: 'user_title' });
        expect(await titleRow(id)).toMatchObject({ title: 'Mine', title_origin: 'user' });
    });
});
