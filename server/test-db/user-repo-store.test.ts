import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { createUserRepoStore, PurgeConflictError, type UserRepoStore } from '../src/db/user-repo-store.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
/** A second process: its own pool and its own store over the same database. */
let otherPool: Sql;
let other: UserRepoStore;
let store: UserRepoStore;
let jobs: JobStore;

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const BOB_USER = testUser('bob');
const ALICE = ALICE_USER.id;
const BOB = BOB_USER.id;
const SESSION = randomUUID();

const web = { owner: 'acme', name: 'web' };

/** What a successful stamp answers: the token is the stamp's own, so only its shape is pinned. */
const STAMPED = { stamped: true, token: expect.any(String) };
const api = { owner: 'acme', name: 'api' };

/** A limit above every row this suite ever queues, so a claim proves it exhausted the queue. */
const CLAIM_LIMIT = 5;

const db = useTestDb({
    max: 8,
    orgs: [ORG],
    users: [ALICE_USER, BOB_USER],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createUserRepoStore({ sql, orgId: ORG });
    otherPool = postgres(db.url!, { max: 4 });
    other = createUserRepoStore({ sql: otherPool, orgId: ORG });
    jobs = createJobStore({ sql, orgId: ORG });
});

afterAll(async () => {
    if (enabled) await otherPool.end({ timeout: 5 });
});

/** A stamp older than this is stale. The clock is moved with SQL, never by sleeping. */
const STALE_MS = 120_000;

const backdatePurge = () =>
    sql`update user_repo set purge_started_at = now() - interval '1 hour'
        where org_id = ${ORG} and status = 'purging'`;

/** Lapses every lease, as the passing of the lease time would. */
const expireLeases = () =>
    sql`update user_repo set lease_expires_at = now() - interval '1 minute'
        where org_id = ${ORG} and status = 'cloning'`;

const rowOf = async (repo: { name: string }) => {
    const [row] = await sql<
        { status: string; claim_token: string | null; lease_expires_at: Date | null; purge_token: string | null }[]
    >`select status, claim_token, lease_expires_at, purge_token from user_repo
      where org_id = ${ORG} and user_id = ${ALICE} and repo_name = ${repo.name}`;
    return row!;
};

/**
 * Holds the user_repo row's lock in an open transaction until the test releases it, running the
 * winner's own write (the stamp's `purging` update) INSIDE that transaction — uncommitted and
 * invisible until release, which is exactly the state a purge's stamp is in while it holds the
 * lock. Releasing commits, and the blocked loser re-reads the row under READ COMMITTED.
 */
function holdRowLock(repo: { owner: string; name: string }, work?: (tx: TransactionSql) => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const opened = new Promise<void>((resolve) => {
        void sql
            .begin(async (tx) => {
                await tx`
                    select status from user_repo
                    where org_id = ${ORG} and user_id = ${ALICE}
                      and repo_owner = ${repo.owner} and repo_name = ${repo.name}
                    for update
                `;
                if (work) await work(tx);
                resolve();
                await gate;
            })
            .catch(() => {});
    });
    return { opened, release };
}

const settlesWithin = (promise: Promise<unknown>, ms: number) =>
    Promise.race([promise.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), ms))]);

async function seedOrphan(repo: { owner: string; name: string }) {
    await store.select(ALICE, [repo]);
    await store.select(ALICE, []);
}

/** Stamps an orphan and returns the stamp's token, failing the test on any refusal. */
async function stamp(repo: { owner: string; name: string }, userId = ALICE): Promise<string> {
    const stamped = await store.stampPurge(userId, repo);
    if (typeof stamped === 'string' || !('stamped' in stamped))
        throw new Error(`stamp refused: ${JSON.stringify(stamped)}`);
    return stamped.token;
}

describe.skipIf(!enabled)('the user repo store', () => {
    it('replaces the whole selection, so replaying a PUT changes nothing', async () => {
        await store.select(ALICE, [web, api]);
        await store.select(ALICE, [web, api]);
        expect(await store.list(ALICE)).toHaveLength(2);
    });

    it('marks a dropped repo deselected rather than deleting the row', async () => {
        // The row is the only record that the directory exists on disk. Deleting it would make
        // unbounded disk growth invisible, which is the failure docs/workspace.md already admits to.
        await store.select(ALICE, [web, api]);
        await store.select(ALICE, [web]);

        expect((await store.list(ALICE)).map((r) => r.name)).toEqual(['web']);
        expect((await store.orphaned(ALICE)).map((r) => r.name)).toEqual(['api']);
    });

    it('resurrects a deselected row instead of inserting beside it', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.select(ALICE, [web]);

        expect(await store.list(ALICE)).toHaveLength(1);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it('keeps a ready checkout ready when it is re-selected', async () => {
        // A clone that is on disk is on disk. Re-queueing it would throw away a working tree that
        // may hold an agent's uncommitted work.
        await store.select(ALICE, [web]);
        const [job] = await store.claimPending(1);
        await store.markReady(job!);
        await store.select(ALICE, [web, api]);

        const byName = Object.fromEntries((await store.list(ALICE)).map((r) => [r.name, r.status]));
        expect(byName).toEqual({ web: 'ready', api: 'queued' });
    });

    it("re-queues a failed repo when it is re-selected, so a retry is the member's choice", async () => {
        await store.select(ALICE, [web]);
        const [job] = await store.claimPending(1);
        await store.markFailed(job!, 'fatal: repository not found');
        expect((await store.list(ALICE))[0]).toMatchObject({ status: 'failed', error: expect.any(String) });

        await store.select(ALICE, [web]);
        expect((await store.list(ALICE))[0]).toMatchObject({ status: 'queued', error: null });
    });

    it("keeps two members' selections apart", async () => {
        await store.select(ALICE, [web]);
        await store.select(BOB, [api]);

        expect((await store.list(ALICE)).map((r) => r.name)).toEqual(['web']);
        expect((await store.list(BOB)).map((r) => r.name)).toEqual(['api']);
    });

    it('claims at most `limit` rows and counts the attempt', async () => {
        await store.select(ALICE, [web, api]);
        expect(await store.claimPending(1)).toHaveLength(1);
        expect(await store.claimPending(CLAIM_LIMIT)).toHaveLength(1);
        // Nothing left queued: both are `cloning` now.
        expect(await store.claimPending(CLAIM_LIMIT)).toHaveLength(0);
        expect((await store.list(ALICE)).every((r) => r.attempts === 1)).toBe(true);
    });

    it('never hands the same row to two claimers', async () => {
        // `for update skip locked`, the same guard the job board uses. This is the property that
        // makes a second dashboard replica a schema question rather than a correctness one.
        await store.select(ALICE, [web, api]);
        const [a, b] = await Promise.all([store.claimPending(2), other.claimPending(2)]);
        const claimed = [...a, ...b];
        expect(claimed).toHaveLength(2);
        expect(new Set(claimed.map((job) => job.claimToken)).size).toBe(2);
        const leases = await sql<{ lease_expires_at: Date | null }[]>`
            select lease_expires_at from user_repo where org_id = ${ORG} and status = 'cloning'`;
        expect(leases.every((row) => row.lease_expires_at !== null)).toBe(true);
    });

    it('does not claim a repo that was deselected while queued', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        expect(await store.claimPending(CLAIM_LIMIT)).toHaveLength(0);
    });

    it('recovery does not requeue a row another live process holds', async () => {
        await store.select(ALICE, [web]);
        const [job] = await store.claimPending(1);

        expect(await other.requeueExpired()).toEqual([]);

        expect(await rowOf(web)).toMatchObject({ status: 'cloning', claim_token: job!.claimToken });
    });

    it('recovery requeues a lapsed lease and names its staging token', async () => {
        await store.select(ALICE, [web]);
        const [a] = await store.claimPending(1);
        await expireLeases();

        expect(await other.requeueExpired()).toEqual([{ userId: ALICE, name: 'web', staleToken: a!.claimToken }]);

        const [b] = await other.claimPending(1);
        expect(b!.claimToken).not.toBe(a!.claimToken);
        expect((await store.list(ALICE))[0]).toMatchObject({ status: 'cloning', error: null });
    });

    it('reselection keeps a clone another process holds', async () => {
        await store.select(ALICE, [web]);
        const [a] = await store.claimPending(1);
        const before = await rowOf(web);

        await other.select(ALICE, [web]);
        await other.select(ALICE, []);
        await other.select(ALICE, [web]);

        expect(await rowOf(web)).toEqual(before);
        expect(await other.claimPending(CLAIM_LIMIT)).toEqual([]);
        expect(await store.markReady(a!)).toBe(true);
    });

    it('a lost claim\u2019s publish never runs and its writes are refused', async () => {
        await store.select(ALICE, [web]);
        const [a] = await store.claimPending(1);
        await expireLeases();
        await other.requeueExpired();
        const [b] = await other.claimPending(1);

        let published = false;
        expect(await store.markReady(a!, () => (published = true))).toBe(false);
        expect(published).toBe(false);
        expect(await store.markFailed(a!, 'late')).toBe(false);
        expect(await rowOf(web)).toMatchObject({ status: 'cloning', claim_token: b!.claimToken });
        expect(await other.markReady(b!, () => (published = true))).toBe(true);
        expect(published).toBe(true);
        expect(await rowOf(web)).toMatchObject({ status: 'ready', claim_token: null, lease_expires_at: null });
    });

    it('a publish runs under the row lock', async () => {
        await store.select(ALICE, [web]);
        const [a] = await store.claimPending(1);

        let during: string | undefined;
        await store.markReady(a!, () => {
            during = 'ran';
        });
        expect(during).toBe('ran');
        // A failed publish rolls the row back to cloning: it is not recorded ready.
        await store.select(ALICE, [api]);
        const [b] = await store.claimPending(1);
        await expect(
            store.markReady(b!, () => {
                throw new Error('rename failed');
            })
        ).rejects.toThrow('rename failed');
        expect(await rowOf(api)).toMatchObject({ status: 'cloning', claim_token: b!.claimToken });
    });

    it('renewal keeps a live claim and reports a lost one', async () => {
        await store.select(ALICE, [web, api]);
        const [a, b] = await store.claimPending(2);
        await expireLeases();
        await sql`update user_repo set claim_token = gen_random_uuid()
            where org_id = ${ORG} and repo_name = ${b!.name}`;

        expect(await store.renewLeases([a!.claimToken, b!.claimToken], 60_000)).toEqual([a!.claimToken]);

        const [renewed] = await sql<{ live: boolean }[]>`
            select lease_expires_at > now() as live from user_repo where org_id = ${ORG} and repo_name = ${a!.name}`;
        expect(renewed!.live).toBe(true);
        expect(await store.renewLeases([], 60_000)).toEqual([]);
    });

    it('the claim constraints refuse a cloning or purging row without its token', async () => {
        await store.select(ALICE, [web, api]);
        const cloning = sql`update user_repo set status = 'cloning' where org_id = ${ORG} and repo_name = 'web'`;
        await expect(cloning).rejects.toThrow(/user_repo_clone_lease_ck/);
        const purging = sql`update user_repo set status = 'purging' where org_id = ${ORG} and repo_name = 'api'`;
        await expect(purging).rejects.toThrow(/user_repo_purge_claim_ck/);
        const stray = sql`update user_repo set claim_token = gen_random_uuid(), lease_expires_at = now()
            where org_id = ${ORG} and repo_name = 'web'`;
        await expect(stray).rejects.toThrow(/user_repo_clone_lease_ck/);
    });

    it('every store write keeps both claim constraints', async () => {
        const writes: (() => Promise<unknown>)[] = [
            () => store.select(ALICE, [web, api]),
            async () => {
                const [a] = await store.claimPending(1);
                await store.renewLeases([a!.claimToken], 1000);
                await store.markReady(a!);
            },
            async () => {
                const [b] = await store.claimPending(1);
                await store.markFailed(b!, 'boom');
            },
            () => store.select(ALICE, [web, api]),
            async () => {
                await store.claimPending(CLAIM_LIMIT);
                await expireLeases();
                await store.requeueExpired();
            },
            () => store.select(ALICE, []),
            async () => {
                const token = await stamp(web);
                await store.markPurgeFailed(ALICE, web, token, 'x');
            },
            async () => {
                const token = await stamp(web);
                await backdatePurge();
                const [claimed] = await store.claimStalePurges(STALE_MS);
                await store.holdPurge(ALICE, web, claimed!.token, () => 0);
                await store.deletePurged(ALICE, web, claimed!.token);
                expect(token).not.toBe(claimed!.token);
            },
            () => store.select(ALICE, [web]),
        ];
        for (const write of writes) await expect(write()).resolves.not.toThrow();
        expect(await store.heldTokens()).toBeInstanceOf(Array);
    });

    it('heldTokens names every claim and purge token, lapsed leases included', async () => {
        await store.select(ALICE, [web]);
        const [a] = await store.claimPending(1);
        await expireLeases();
        await store.select(ALICE, [web, api]);
        await store.select(ALICE, [web]);
        const purge = await stamp(api);

        expect((await store.heldTokens()).sort()).toEqual([a!.claimToken, purge].sort());
    });

    it('refuses a repo name that cannot be a directory, at the row', async () => {
        /*
         * The database's own copy of the rules the route applies. Duplicated on purpose, exactly as
         * organization_id_ck restates ORG_ID_PATTERN: the route guards the request, this guards the
         * row, and a name arrives in a JSON body now rather than from an operator's config.
         */
        for (const name of ['-x', '.', '..', 'a/b', 'a\\b', '']) {
            await expect(store.select(ALICE, [{ owner: 'acme', name }]), name).rejects.toThrow();
        }
    });

    it("refuses two owners' same-named repos, because they are one directory", async () => {
        // The checkout is `<repo_name>` alone. This is the check `checkWorkspaceNames` used to make
        // against ORG_REPOS at boot, restated where a name actually becomes a path.
        await expect(
            store.select(ALICE, [
                { owner: 'acme', name: 'api' },
                { owner: 'other-owner', name: 'api' },
            ])
        ).rejects.toThrow();
    });

    it("removes a member's rows when the account goes, unlike a job's author", async () => {
        // `on delete cascade` here, `set null` on job.created_by. A job is an audit record of what
        // somebody ran and must outlive them; this row describes a directory nobody can reach.
        await store.select(BOB, [web]);
        await sql`delete from app_user where id = ${BOB}`;
        expect(await store.list(BOB)).toEqual([]);

        await sql`
            insert into app_user (id, github_user_id, github_login) values (${BOB}, ${BOB_USER.githubUserId}, 'bob')
            on conflict (github_user_id) do update set id = excluded.id
        `;
    });
});

/**
 * The manual purge (issue #92). The stamp is one transaction that locks the row and checks
 * deselection, clone status and blocking tasks; every refusal is decided under that lock so the
 * losing operation observes the winning transaction's state.
 */
describe.skipIf(!enabled)('the manual purge', () => {
    /** Plants a task row. `repo` is `owner/name` as the routes store it; null is command-only. */
    async function insertJob(user: string, repo: string | null, status = 'queued', done = false) {
        const id = randomUUID();
        await sql`
            insert into job (org_id, id, command, status, repo, created_by, root_job_id, done_at)
            values (${ORG}, ${id}, 'do it', ${status}, ${repo}, ${user}, ${id}, ${done ? new Date() : null})
        `;
        return id;
    }

    it('stamps a deselected row purging and records the start time', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);

        expect(await store.stampPurge(ALICE, web)).toEqual(STAMPED);

        const [row] = await store.orphaned(ALICE);
        expect(row!.status).toBe('purging');
        expect(row!.purgeStartedAt).not.toBeNull();
    });

    it.each<{ name: string; arrange: () => Promise<unknown>; expected: unknown }>([
        {
            name: 'refuses a selected row regardless of its clone status',
            arrange: async () => {
                await store.select(ALICE, [web]);
                const [job] = await store.claimPending(1);
                await store.markReady(job!);
            },
            expected: { refused: 'selected' },
        },
        {
            name: 'answers a duplicate request with purging',
            arrange: async () => {
                await store.select(ALICE, [web]);
                await store.select(ALICE, []);
                await store.stampPurge(ALICE, web);
            },
            expected: { refused: 'purging' },
        },
        {
            name: 'refuses a row still owned by a clone',
            arrange: async () => {
                await store.select(ALICE, [web]);
                await store.claimPending(1);
                await store.select(ALICE, []);
            },
            expected: { refused: 'cloning' },
        },
    ])('$name', async ({ arrange, expected }) => {
        await arrange();

        expect(await store.stampPurge(ALICE, web)).toEqual(expected);
    });

    /** Each row deselects `web` first, then plants the tasks the blocking count does or does not see. */
    it.each<{ name: string; seed: () => Promise<unknown>; expected: unknown }>([
        {
            // The directory is keyed by repo NAME, so an old task queued against `other/web` writes in
            // the member's `web` checkout exactly as one queued against `acme/web` would. The tasks
            // counted are the member's own; only the repo label's owner part is free to differ.
            name: 'counts a same-name task whose repo label names another owner as blocking',
            seed: () => insertJob(ALICE, 'other/web'),
            expected: { refused: 'tasks', count: 1 },
        },
        {
            // Another member's tasks run in that member's workspace, never in this checkout.
            name: 'does not count another member\u2019s tasks, whatever their name',
            seed: async () => {
                await insertJob(BOB, 'other/web');
                await insertJob(BOB, 'acme/web');
            },
            expected: STAMPED,
        },
        {
            name: 'does not count a thread that is terminal and marked done',
            seed: async () => {
                const root = await insertJob(ALICE, 'acme/web', 'succeeded', true);
                await insertJob(ALICE, 'acme/web', 'failed', true).then(
                    () => sql`update job set root_job_id = ${root} where command = 'do it' and status = 'failed'`
                );
            },
            expected: STAMPED,
        },
        {
            name: 'counts a thread that is terminal but never marked done',
            seed: () => insertJob(ALICE, 'acme/web', 'succeeded'),
            expected: { refused: 'tasks', count: 1 },
        },
        {
            name: 'does not count command-only tasks',
            seed: () => insertJob(ALICE, null),
            expected: STAMPED,
        },
    ])('$name', async ({ seed, expected }) => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await seed();

        expect(await store.stampPurge(ALICE, web)).toEqual(expected);
    });

    it('answers missing for a row that is not there', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);

        expect(await store.stampPurge(ALICE, api)).toBe('missing');
    });

    it('refuses a selection that would change a purging row', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.stampPurge(ALICE, web);

        await expect(store.select(ALICE, [web])).rejects.toBeInstanceOf(PurgeConflictError);
        // The refusal names the offending checkout, and the whole selection is refused.
        await expect(store.select(ALICE, [web, api])).rejects.toMatchObject({ names: ['web'] });
        expect(await store.orphaned(ALICE)).toHaveLength(1);
        expect(await store.list(ALICE)).toHaveLength(0);
    });

    it('deletes only a row that is still deselected and purging', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        const token = await stamp(web);

        expect(await store.deletePurged(ALICE, web, token)).toBe(true);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
        // A replay performs no second delete: the row is gone.
        expect(await store.deletePurged(ALICE, web, token)).toBe(false);
    });

    it('deletePurged leaves a row that moved behind the purge\u2019s back', async () => {
        // The second transaction must find the row still deselected and still purging — a select
        // that commits first re-queues the row, and the stale purge must not delete it.
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        const token = await stamp(web);
        await sql`
            update user_repo set deselected_at = null, status = 'queued', purge_token = null
            where org_id = ${ORG} and user_id = ${ALICE} and repo_name = 'web'
        `;

        expect(await store.deletePurged(ALICE, web, token)).toBe(false);
        expect(await store.list(ALICE)).toHaveLength(1);
    });

    it('lands a failed purge back on failed with the reason', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        const token = await stamp(web);

        expect(await store.markPurgeFailed(ALICE, web, token, 'rm: permission denied')).toBe(true);

        const [row] = await store.orphaned(ALICE);
        expect(row!.status).toBe('failed');
        expect(row!.error).toBe('rm: permission denied');
        expect(row!.purgeStartedAt).not.toBeNull();
    });

    it('a failed purge keeps its token as a pointer, unheld, and a restamp hands it back', async () => {
        await seedOrphan(web);
        const first = await stamp(web);
        expect(await store.markPurgeFailed(ALICE, web, first, 'rm: permission denied')).toBe(true);

        const [raw] = await sql<{ purge_token: string | null }[]>`
            select purge_token from user_repo where org_id = ${ORG} and user_id = ${ALICE} and repo_name = 'web'`;
        expect(raw!.purge_token).toBe(first);
        expect(await store.heldTokens()).toEqual([]);

        expect(await store.stampPurge(ALICE, web)).toEqual({
            stamped: true,
            token: expect.not.stringMatching(first),
        });
    });

    it('a fresh stamp is not claimed; a stale one is claimed exactly once', async () => {
        // Two recoverers race for one stale stamp. READ COMMITTED re-checks the staleness against the
        // restamped row, so only one gets it and the other is told nothing.
        await seedOrphan(web);
        const stampToken = await stamp(web);
        expect(await store.claimStalePurges(STALE_MS)).toEqual([]);

        await backdatePurge();
        const claimed = (
            await Promise.all([store.claimStalePurges(STALE_MS), other.claimStalePurges(STALE_MS)])
        ).flat();

        expect(claimed).toHaveLength(1);
        expect(claimed[0]).toMatchObject({ userId: ALICE, name: 'web' });
        expect(claimed[0]!.token).not.toBe(stampToken);
        expect(await store.claimStalePurges(STALE_MS)).toEqual([]);
    });

    it('a purge completion is fenced by its claim', async () => {
        await seedOrphan(web);
        const t1 = await stamp(web);
        await backdatePurge();
        const [recovered] = await store.claimStalePurges(STALE_MS);
        const t2 = recovered!.token;

        let moved = false;
        expect(await store.holdPurge(ALICE, web, t1, () => (moved = true))).toBeNull();
        expect(moved).toBe(false);
        expect(await store.deletePurged(ALICE, web, t1)).toBe(false);
        expect(await store.markPurgeFailed(ALICE, web, t1, 'late')).toBe(false);
        expect(await store.holdPurge(ALICE, web, t2, () => 'moved')).toBe('moved');
        expect(await store.deletePurged(ALICE, web, t2)).toBe(true);
    });

    it('reselection between two recoverers\u2019 completions keeps the fresh row', async () => {
        await seedOrphan(web);
        const t1 = await stamp(web);
        await backdatePurge();
        const [recovered] = await store.claimStalePurges(STALE_MS);
        expect(await store.deletePurged(ALICE, web, recovered!.token)).toBe(true);

        await store.select(ALICE, [web]);

        expect(await store.deletePurged(ALICE, web, t1)).toBe(false);
        expect(await store.markPurgeFailed(ALICE, web, t1, 'late')).toBe(false);
        const [row] = await store.list(ALICE);
        expect(row).toMatchObject({ name: 'web', status: 'queued' });
        const [raw] = await sql<{ purge_token: string | null }[]>`
            select purge_token from user_repo where org_id = ${ORG} and user_id = ${ALICE} and repo_name = 'web'`;
        expect(raw!.purge_token).toBeNull();
    });
});

/**
 * The races the manual purge can lose (issue #92's acceptance criterion): duplicate/replayed
 * purge, selection versus purge, ALL THREE job-insert paths (create, follow-up, retry) versus
 * purge, and same-name tasks from another owner. The losing operation must observe the winning
 * transaction's state — which is what the row lock buys, and what these tests exercise with a
 * real second transaction holding the lock.
 */
describe.skipIf(!enabled)('the purge races', () => {
    it('a job insert waits behind the stamp, then refuses — and nothing was queued', async () => {
        await seedOrphan(web);
        const lock = holdRowLock(
            web,
            (tx) =>
                tx`update user_repo set status = 'purging', purge_started_at = now(), purge_token = gen_random_uuid()
               where org_id = ${ORG} and user_id = ${ALICE} and repo_name = 'web'`
        );
        await lock.opened;

        const attempt = jobs.create('do it', ALICE, { repo: 'other/web', executor: null, workflow: null });
        // Blocked on the row lock: the insert cannot decide before the stamp's transaction ends.
        expect(await settlesWithin(attempt, 150)).toBe(false);

        lock.release(); // the stamp commits

        expect(await attempt).toBe('purging');
        const queued = await sql<{ n: number }[]>`select count(*)::int as n from job where org_id = ${ORG}`;
        expect(queued[0]?.n).toBe(0);
    });

    it('a job insert that commits first makes the stamp refuse with the count', async () => {
        await seedOrphan(web);
        // The create takes the row lock, inserts, commits — all before the stamp runs.
        await jobs.create('do it', ALICE, { repo: 'other/web', executor: null, workflow: null });

        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'tasks', count: 1 });
    });

    it('a selection that commits first makes the stamp\u2019s deselection check fail', async () => {
        await store.select(ALICE, [web]);
        // The select is the winner here: the row is not deselected, and the stamp must say so.
        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'selected' });
    });

    it('a stamp that commits first refuses all three job-insert paths', async () => {
        await seedOrphan(web);
        await store.stampPurge(ALICE, web);

        const root = await jobs.create('do it', ALICE, { repo: 'acme/web', executor: null, workflow: null });
        expect(root).toBe('purging');

        // And the follow-up path, against a finished parent whose repo names the purging checkout.
        const parentId = randomUUID();
        await sql`
            insert into job (org_id, id, command, status, repo, created_by, session_id, root_job_id)
            values (${ORG}, ${parentId}, 'root', 'succeeded', 'acme/web', ${ALICE},
                    ${SESSION}, ${parentId})
        `;
        expect(await jobs.createFollowUp(parentId, 'again', ALICE)).toBe('purging');

        // And the retry path (issue #326), whose guard reads the NAMED task's repo label.
        expect(await jobs.createRetry(parentId, ALICE)).toBe('purging');
    });

    it('a re-selection while the stamp is held waits, then refuses with the row intact', async () => {
        await seedOrphan(web);
        const lock = holdRowLock(
            web,
            (tx) =>
                tx`update user_repo set status = 'purging', purge_started_at = now(), purge_token = gen_random_uuid()
               where org_id = ${ORG} and user_id = ${ALICE} and repo_name = 'web'`
        );
        await lock.opened;

        const attempt = store.select(ALICE, [web]);
        expect(await settlesWithin(attempt, 150)).toBe(false);

        lock.release(); // the stamp commits

        await expect(attempt).rejects.toBeInstanceOf(PurgeConflictError);
        // Nothing moved: the row is still deselected and still purging.
        const [row] = await store.orphaned(ALICE);
        expect(row!.status).toBe('purging');
    });

    it('a replay after the row is gone deletes nothing and reports so', async () => {
        await seedOrphan(web);
        const token = await stamp(web);

        expect(await store.deletePurged(ALICE, web, token)).toBe(true);
        expect(await store.deletePurged(ALICE, web, token)).toBe(false);
    });

    it('another member\u2019s same-name tasks never block the purge', async () => {
        await seedOrphan(web);
        await jobs.create('do it', BOB, { repo: 'acme/web', executor: null, workflow: null });

        expect(await store.stampPurge(ALICE, web)).toEqual(STAMPED);
    });

    it('a follow-up whose checkout row is absent still queues — the existing task contract', async () => {
        const finishedRoot = async () => {
            const parentId = randomUUID();
            await sql`
                insert into job (org_id, id, command, status, repo, created_by, session_id, root_job_id)
                values (${ORG}, ${parentId}, 'root', 'succeeded', 'ghost/repo', ${ALICE},
                        ${SESSION}, ${parentId})
            `;
            return parentId;
        };

        // The retry path reads the same absent row as no refusal, the same contract — each on a
        // thread of its own, since a queued member owns the turn and the other would answer
        // not_finished instead (#698).
        const retry = await jobs.createRetry(await finishedRoot(), ALICE);
        expect(retry).toHaveProperty('id');

        const followUp = await jobs.createFollowUp(await finishedRoot(), 'again', ALICE);
        expect(followUp).toHaveProperty('id');
    });
});
