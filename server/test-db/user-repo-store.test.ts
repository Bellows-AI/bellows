import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { createUserRepoStore, PurgeConflictError, type UserRepoStore } from '../src/db/user-repo-store.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: UserRepoStore;
let jobs: JobStore;

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const BOB_USER = testUser('bob');
const ALICE = ALICE_USER.id;
const BOB = BOB_USER.id;
const SESSION = randomUUID();

const web = { owner: 'acme', name: 'web' };
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
    jobs = createJobStore({ sql, orgId: ORG });
});

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
        await store.claimPending(1);
        await store.markReady(ALICE, web);
        await store.select(ALICE, [web, api]);

        const byName = Object.fromEntries((await store.list(ALICE)).map((r) => [r.name, r.status]));
        expect(byName).toEqual({ web: 'ready', api: 'queued' });
    });

    it("re-queues a failed repo when it is re-selected, so a retry is the member's choice", async () => {
        await store.select(ALICE, [web]);
        await store.claimPending(1);
        await store.markFailed(ALICE, web, 'fatal: repository not found');
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
        const [a, b] = await Promise.all([store.claimPending(2), store.claimPending(2)]);
        expect([...a, ...b]).toHaveLength(2);
    });

    it('does not claim a repo that was deselected while queued', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        expect(await store.claimPending(CLAIM_LIMIT)).toHaveLength(0);
    });

    it('returns rows a restart stranded in cloning', async () => {
        // A `cloning` row is owned by a process that no longer exists, and the claim only takes
        // `queued` — so without this it stays cloning forever while nothing is cloning it.
        await store.select(ALICE, [web, api]);
        await store.claimPending(2);

        expect(await store.requeueStranded()).toBe(2);
        expect(await store.claimPending(2)).toHaveLength(2);
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

        expect(await store.stampPurge(ALICE, web)).toEqual({ stamped: true });

        const [row] = await store.orphaned(ALICE);
        expect(row!.status).toBe('purging');
        expect(row!.purgeStartedAt).not.toBeNull();
    });

    it.each<{ name: string; arrange: () => Promise<unknown>; expected: unknown }>([
        {
            name: 'refuses a selected row regardless of its clone status',
            arrange: async () => {
                await store.select(ALICE, [web]);
                await store.claimPending(1);
                await store.markReady(ALICE, web);
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
            expected: { stamped: true },
        },
        {
            name: 'does not count a thread that is terminal and marked done',
            seed: async () => {
                const root = await insertJob(ALICE, 'acme/web', 'succeeded', true);
                await insertJob(ALICE, 'acme/web', 'failed', true).then(
                    () => sql`update job set root_job_id = ${root} where command = 'do it' and status = 'failed'`
                );
            },
            expected: { stamped: true },
        },
        {
            name: 'counts a thread that is terminal but never marked done',
            seed: () => insertJob(ALICE, 'acme/web', 'succeeded'),
            expected: { refused: 'tasks', count: 1 },
        },
        {
            name: 'does not count command-only tasks',
            seed: () => insertJob(ALICE, null),
            expected: { stamped: true },
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
        await store.stampPurge(ALICE, web);

        expect(await store.deletePurged(ALICE, web)).toBe(true);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
        // A replay performs no second delete: the row is gone.
        expect(await store.deletePurged(ALICE, web)).toBe(false);
    });

    it('deletePurged leaves a row that moved behind the purge\u2019s back', async () => {
        // The second transaction must find the row still deselected and still purging — a select
        // that commits first re-queues the row, and the stale purge must not delete it.
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.stampPurge(ALICE, web);
        await sql`
            update user_repo set deselected_at = null, status = 'queued'
            where org_id = ${ORG} and user_id = ${ALICE} and repo_name = 'web'
        `;

        expect(await store.deletePurged(ALICE, web)).toBe(false);
        expect(await store.list(ALICE)).toHaveLength(1);
    });

    it('lands a failed purge back on failed with the reason', async () => {
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.stampPurge(ALICE, web);

        await store.markPurgeFailed(ALICE, web, 'rm: permission denied');

        const [row] = await store.orphaned(ALICE);
        expect(row!.status).toBe('failed');
        expect(row!.error).toBe('rm: permission denied');
        expect(row!.purgeStartedAt).not.toBeNull();
    });

    it('lists every purging row of the org with its member, for boot recovery', async () => {
        await store.select(ALICE, [web]);
        await store.select(BOB, [api]);
        await store.select(ALICE, []);
        await store.select(BOB, []);
        await store.stampPurge(ALICE, web);
        await store.stampPurge(BOB, api);

        const purging = await store.listPurging();
        expect(purging.map((r) => [r.userId, r.name]).sort()).toEqual(
            [
                [ALICE, 'web'],
                [BOB, 'api'],
            ].sort()
        );
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
                tx`update user_repo set status = 'purging', purge_started_at = now()
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
                tx`update user_repo set status = 'purging', purge_started_at = now()
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
        await store.stampPurge(ALICE, web);

        expect(await store.deletePurged(ALICE, web)).toBe(true);
        expect(await store.deletePurged(ALICE, web)).toBe(false);
    });

    it('another member\u2019s same-name tasks never block the purge', async () => {
        await seedOrphan(web);
        await jobs.create('do it', BOB, { repo: 'acme/web', executor: null, workflow: null });

        expect(await store.stampPurge(ALICE, web)).toEqual({ stamped: true });
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
