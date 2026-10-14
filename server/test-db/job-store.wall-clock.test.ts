import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';
import { craftJob, type CraftShape, expectMinutes, testUser } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;

const ORG = 'test-org';

/** The jobs' author. Re-planted before every test, because `created_by` is a uuid foreign key. */
const AUTHOR_USER = testUser('wall-clock-cat');
const AUTHOR = AUTHOR_USER.id;

/** A lease long enough that nothing in this suite outlives it by accident. */
const LEASE_SECONDS = 300;
const db = useTestDb({ max: 8, users: [AUTHOR_USER] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

/**
 * Writes a job row in whatever state the case needs, straight SQL. `startedMinutesAgo` backdates
 * the attempt's start so a duration can be asserted without sleeping; `wallClockMs` seeds the
 * accumulated column directly, for threads whose members finished before this test ran. The lease
 * always starts expired: every case that runs the row claims it first, and the rest never reach
 * the claim.
 */
const craft = (shape: CraftShape = {}) => craftJob({ sql, org: ORG, author: AUTHOR }, shape);

/** The row's banked wall clock, read back with straight SQL. postgres.js hands a bigint over as a
 * string, the same coercion `toJob` does. */
const wallOf = async (id: string): Promise<number | null> => {
    const [row] = await sql<{ wall_clock_ms: string | null }[]>`
        select wall_clock_ms from job where id = ${id}
    `;
    return row?.wall_clock_ms == null ? null : Number(row.wall_clock_ms);
};

/** A completed claim's lease token, with the attempt's start backdated `minutes` into the past —
 * what every duration assertion below measures without a sleep. */
const claimBackdated = async (minutes: number): Promise<{ id: string; token: string }> => {
    const id = await craft({ status: 'running' });
    const { leaseToken } = (await store.claim('w1', LEASE_SECONDS))!;
    await sql`update job set started_at = now() - (${minutes} * interval '1 minute') where id = ${id}`;
    return { id, token: leaseToken };
};

describe.skipIf(!enabled)('the task wall clock', () => {
    /*
     * Every way a single backdated attempt settles banks the segment it actually ran. The stop
     * settles that land without a worker bank the same way (the zombie-recovery cases in
     * job-store.stop-remove.test.ts) — the row was running for real up to the settle.
     */
    it.each<{
        name: string;
        minutes: number;
        settle: (id: string, token: string) => Promise<void>;
        status: string;
    }>([
        {
            name: 'complete records the attempt it settles',
            minutes: 10,
            settle: async (id, token) => {
                expect(
                    await store.complete(id, token, { status: 'succeeded', exitCode: 0, output: null })
                ).toMatchObject({ result: 'ok' });
            },
            status: 'succeeded',
        },
        {
            name: 'the park records the run time too — the segment it ends was real',
            minutes: 2,
            settle: async (id, token) => {
                expect(await store.suspend(id, token)).toEqual({ result: 'ok', status: 'stopped' });
            },
            status: 'stopped',
        },
    ])('$name', async ({ minutes, settle, status }) => {
        const { id, token } = await claimBackdated(minutes);

        await settle(id, token);

        expect((await store.get(id))?.status).toBe(status);
        expectMinutes(await wallOf(id), minutes);
        // The single read does not serve the total — the thread read is the task view's source.
        expect((await store.get(id))?.taskWallClockMs).toBeNull();
    });

    it('a re-claim keeps counting the segment it supersedes', async () => {
        const id = await craft({ status: 'running' });
        await store.claim('w1', LEASE_SECONDS);
        await sql`update job set started_at = now() - interval '5 minutes',
                  lease_expires_at = now() - interval '1 second' where id = ${id}`;
        // The first attempt's lease has expired: the second claim banks its five minutes before
        // resetting started_at for the attempt it is about to run.
        await store.claim('w2', LEASE_SECONDS);
        await sql`update job set started_at = now() - interval '3 minutes' where id = ${id}`;
        const second = await sql<{ lease_token: string }[]>`select lease_token from job where id = ${id}`;

        expect(
            await store.complete(id, second[0]!.lease_token, { status: 'succeeded', exitCode: 0, output: null })
        ).toMatchObject({ result: 'ok' });

        expectMinutes(await wallOf(id), 8);
    });

    it('a row retired dead keeps its last segment', async () => {
        const id = await craft({ status: 'running' });
        await store.claim('w1', LEASE_SECONDS);
        // Burn the last attempt, expire the lease, backdate the start: the next claim retires the
        // row dead, and the six minutes it ran first must survive the retirement.
        await sql`update job set attempts = max_attempts, lease_expires_at = now() - interval '1 second',
                  started_at = now() - interval '6 minutes' where id = ${id}`;

        expect(await store.claim('w2', LEASE_SECONDS)).toBeNull();
        expect((await store.get(id))?.status).toBe('dead');

        expectMinutes(await wallOf(id), 6);
    });

    it('stopping a task that never ran records nothing', async () => {
        // started_at is backdated deliberately: the direct landing settles a row that never
        // executed, and a duration there would count time the task never spent.
        const id = await craft({ startedMinutesAgo: 9 });

        expect(await store.stop(id, null)).toEqual({ result: 'stopped' });
        expect(await wallOf(id)).toBeNull();
    });

    it('the first claim of a task that never ran banks nothing', async () => {
        // A queued row has no segment behind it: the claim starts its first attempt, and a clock
        // of zero there would claim a measurement that was never made. Null until something runs.
        const id = await craft();
        expect(await store.claim('w1', LEASE_SECONDS)).not.toBeNull();

        expect(await wallOf(id)).toBeNull();
        for (const job of (await store.thread(id)) ?? []) {
            expect(job.taskWallClockMs).toBeNull();
        }
    });

    it('thread serves the whole thread total on every member, and nulls add nothing', async () => {
        const root = await craft({ status: 'succeeded', wallClockMs: 60_000 });
        const second = await craft({ parent: root, status: 'failed', wallClockMs: 30_000 });
        const third = await craft({ parent: root, status: 'stopped' });

        const EXPECTED_TASK_WALL_CLOCK_MS = 90_000;
        for (const id of [root, second, third]) {
            expect((await store.thread(id))?.every((job) => job.taskWallClockMs === EXPECTED_TASK_WALL_CLOCK_MS)).toBe(
                true
            );
        }
    });

    it('thread answers null where nothing has accumulated', async () => {
        const root = await craft({ status: 'queued' });
        await craft({ parent: root, status: 'queued' });

        for (const job of (await store.thread(root)) ?? []) {
            expect(job.taskWallClockMs).toBeNull();
        }
    });
});
