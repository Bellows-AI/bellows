import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;

const ORG = testOrg();
/** A lease long enough that nothing in this suite outlives it by accident. */
const LEASE_SECONDS = 300;

const db = useTestDb({ max: 8 });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

/**
 * Writes a job row in whatever state the case needs, straight SQL. The states under test — a
 * running root with a queued follow-up beside it — are unreachable through the store's own
 * inserts (a follow-up only lands on a finished parent), which is exactly the gap the claim-side
 * fix closes: the query must be correct under ANY row state, so the tests make the state directly.
 * `lease: 'expired'` is the insert default; 'live' fakes a worker still holding the row.
 */
const craft = async (shape: {
    parent?: string | null;
    status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'stopped';
    lease?: 'live' | 'expired';
    /** Seconds before now the row was created. Bigger = older: orders the queue deterministically. */
    olderBySeconds?: number;
}): Promise<string> => {
    const id = randomUUID();
    await sql`
        insert into job (org_id, id, command, status, parent_job_id, root_job_id, lease_expires_at, created_at)
        values (
            ${ORG}, ${id}, 'crafted',
            ${shape.status ?? 'queued'},
            ${shape.parent ?? null},
            ${shape.parent ?? id},
            ${shape.lease === 'live' ? sql`now() + interval '5 minutes'` : sql`now() - interval '1 second'`},
            now() - make_interval(secs => ${shape.olderBySeconds ?? 0}::int)
        )
    `;
    return id;
};

describe.skipIf(!enabled)('thread-serialized claims', () => {
    // The per-task worktree is keyed by the thread's root job id: a claimed follow-up alongside a
    // claimed ancestor would run two runners and two sync jobs into the same tree.
    it('does not hand out a follow-up while its thread root is running', async () => {
        const root = await craft({ status: 'running', lease: 'live' });
        await craft({ parent: root });

        expect(await store.claim('w1', LEASE_SECONDS)).toBeNull();
    });

    it('reclaims the running root itself, and unblocks its follow-up only at a terminal status', async () => {
        const root = await craft({ status: 'running', lease: 'expired' });
        const followUp = await craft({ parent: root });

        // The root's own reclaim is the heartbeat-fenced path and stays — never the follow-up. The
        // expiry is the crafted attempt's interruption, so the claim sequence moves, not attempts.
        const first = await store.claim('w1', LEASE_SECONDS);
        expect(first).toMatchObject({ id: root, attempts: 0, claimSeq: 1 });
        expect(first?.rootJobId).toBe(root);

        // The root runs on: the follow-up still waits.
        expect(await store.claim('w2', LEASE_SECONDS)).toBeNull();

        // The moment the root is terminal the follow-up is claimable, carrying exactly the fields
        // it always did — the new predicate composes with the claim, it does not reshape it. The
        // crafted follow-up has no session, so its command is delivered behind the root's recap.
        await store.complete(root, first!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const second = await store.claim('w3', LEASE_SECONDS);
        expect(second).toMatchObject({
            id: followUp,
            rootJobId: root,
            followUp: true,
            resumeSessionId: null,
            userId: null,
            workspacePath: null,
        });
        expect(second?.command.endsWith('New instruction:\n\ncrafted')).toBe(true);
        expect(second?.env).toBeUndefined();
        expect(second?.gates).toBeUndefined();
    });

    // Queue order must not leak the row past the exclusion: a blocked follow-up is skipped, and
    // the claim moves on to the next candidate rather than answering null.
    it('skips a blocked follow-up and takes the expired root behind it in the queue', async () => {
        const root = await craft({ status: 'running', lease: 'expired' });
        await craft({ parent: root, olderBySeconds: 60 });

        expect((await store.claim('w1', LEASE_SECONDS))?.id).toBe(root);
    });

    // The exclusion is symmetric: whichever member of the thread runs, the others wait — a root
    // is its follow-up's root, so a running follow-up blocks the root the same way.
    it('a running descendant blocks its root', async () => {
        const root = await craft({});
        await craft({ parent: root, status: 'running', lease: 'live' });

        expect(await store.claim('w1', LEASE_SECONDS)).toBeNull();
    });

    // Stopped is the user's verdict on a turn they ended: terminal, so it blocks nothing and is
    // never handed out.
    it('a stopped row neither blocks nor is claimable', async () => {
        const stopped = await craft({ status: 'stopped', lease: 'expired' });
        const followUp = await craft({ parent: stopped, status: 'queued' });

        expect((await store.claim('w1', LEASE_SECONDS))?.id).toBe(followUp);
    });

    it('different roots never block each other', async () => {
        const rootA = await craft({ status: 'running', lease: 'live' });
        await craft({ parent: rootA });
        const rootB = await craft({});

        expect((await store.claim('w1', LEASE_SECONDS))?.id).toBe(rootB);
        // Thread A's follow-up still waits — the exclusion is per thread, not global.
        expect(await store.claim('w2', LEASE_SECONDS)).toBeNull();
    });

    it('terminal roots — failed and dead — block nothing', async () => {
        const failedRoot = await craft({ status: 'failed' });
        const deadRoot = await craft({ status: 'dead' });
        const failedChild = await craft({ parent: failedRoot });
        const deadChild = await craft({ parent: deadRoot });

        const first = await store.claim('w1', LEASE_SECONDS);
        const second = await store.claim('w2', LEASE_SECONDS);
        expect([first?.id, second?.id].sort()).toEqual([failedChild, deadChild].sort());
    });

    // The exclusion reads other rows without locking them, so under READ COMMITTED it cannot see
    // a same-thread claim that is mid-commit: two claims can both pass it and both walk out with
    // rows of one thread — two runners into one root-keyed worktree. The claim must therefore
    // take the thread root's lock BEFORE deciding, and never claim through one it cannot take. It
    // only TRIES the lock (it holds the candidate's row, and every thread-wide writer takes the
    // lock first and then waits on a row — BEL-157), so a held lock skips the thread for this
    // poll. This holds that lock from the outside, on a connection of its own, with the exact key
    // derivation job-store.ts uses (copied, like the driver copies its board-side patterns — the
    // suites share no helper for it).
    it('never claims through a held thread-root lock, and takes the thread once it is free', async () => {
        const root = await craft({});
        const followUp = await craft({ parent: root });

        const blocker = postgres(db.url!, { max: 1 });
        try {
            await blocker`select pg_advisory_lock(hashtextextended(${root}::text, 0))`;

            expect(await store.claim('w1', LEASE_SECONDS)).toBeNull();
            const held = await sql<{ id: string; status: string; attempts: number }[]>`
                select id, status, attempts from job where root_job_id = ${root} order by created_at, id`;
            expect(held.map((row) => [row.status, row.attempts])).toEqual([
                ['queued', 0],
                ['queued', 0],
            ]);

            await blocker`select pg_advisory_unlock(hashtextextended(${root}::text, 0))`;

            // Released, the next claim goes through — and hands out the ROOT itself (queued,
            // reclaimable), never the follow-up that would share its worktree.
            const claim = await store.claim('w1', LEASE_SECONDS);
            expect(claim).toMatchObject({ id: root, rootJobId: root });
            expect(claim?.id).not.toBe(followUp);
        } finally {
            // A session-level advisory lock dies with its connection: nothing leaks past this
            // test into the truncation-shared table.
            await blocker.end();
        }
    });

    // Belt and braces beside the deterministic case above: run the pair for real and at most one
    // claimer may leave with a row of the thread.
    it('two concurrent claims of one thread never both come back', async () => {
        const root = await craft({});
        await craft({ parent: root });

        const [first, second] = await Promise.all([store.claim('w1', LEASE_SECONDS), store.claim('w2', LEASE_SECONDS)]);

        // Exactly one, not merely "at most one": a second null on top of the winner would be a
        // lost claim, which is a different way to break the same promise.
        const handed = [first, second].filter((claim) => claim !== null && claim.rootJobId === root);
        expect(handed).toHaveLength(1);
    });
});
