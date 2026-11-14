import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { createArtifactStore } from '../src/artifacts/artifact-store.js';
import { chunkKey } from '../src/artifacts/keys.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { createCommercePlanWriter } from '../src/db/commerce-plan-writer.js';
import { createFollowUpRow, createRetryRow } from '../src/db/jobs/job-store-thread-actions.js';
import { ThreadExpiringError } from '../src/db/object-write-fence.js';
import { type OrgRetentionDeps, runRetentionPass } from '../src/db/org-retention.js';
import { testSecretStore } from './env-secrets-harness.js';
import { craftJob, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The fence between a thread's object writers, its follow-ups and the retention pass (`org-retention.ts`): once the
 * pass stamps a thread, every write to its prefixes and every new member is refused, the pass lists the prefixes only
 * after the writes that passed the fence earlier have drained, and the stamp outlives the rows, so a writer resuming
 * after the thread is gone never leaves content behind. A pass cut off between steps resumes.
 */
const org = testOrg();
const user = testUser('retention-fence');
const db = useTestDb({ orgs: [org], users: [user], max: 6 });
const enabled = Boolean(db.url);

const PREFIX = 'factory/';
const DRAIN_MS = 60_000;
const DAY = 1440;
const bytes = (text: string) => new TextEncoder().encode(text);

let objects: ObjectStore;

beforeEach(async () => {
    if (!enabled) return;
    objects = createFilesystemStore(await mkdtemp(join(tmpdir(), 'factory-retention-fence-')));
    await db.sql`insert into org_retention (org_id, effective_days) values (${org}, 7)`;
    pushVersion = 0;
});

const pass = (over: Partial<OrgRetentionDeps> = {}) =>
    runRetentionPass({
        sql: db.sql,
        secrets: testSecretStore(db.sql),
        objects,
        prefix: PREFIX,
        planDefaults: { retentionDays: 7 },
        log: () => {},
        writeDrainMs: DRAIN_MS,
        ...over,
    });

const oldThread = () =>
    craftJob(
        { sql: db.sql, org, author: user.id },
        { status: 'succeeded', createdMinutesAgo: 31 * DAY, finishedMinutesAgo: 30 * DAY }
    );
const present = async (id: string) => (await db.sql`select 1 from job where id = ${id}`).length === 1;
const stamped = async (id: string) =>
    (await db.sql`select 1 from thread_expiry where root_job_id = ${id}`).length === 1;
/** The stamp as if it were made `ms` ago: the drain counts from it on the database clock. */
const age = (root: string, ms: number) =>
    db.sql`update thread_expiry set stamped_at = now() - make_interval(secs => ${ms / 1000}) where root_job_id = ${root}`;
const streamRef = (root: string) => ({
    member: 'member-1',
    root,
    job: root,
    claimSeq: 1,
    executor: 'claude-code',
    session: randomUUID(),
    stream: 'raw',
});
const keysLeft = () => objects.list(`${PREFIX}${org}/`);

/** A plan push raising the window, through the commerce writer: version 1 the first time, then one more each call. */
let pushVersion = 0;
async function upgradeTo(days: number): Promise<void> {
    pushVersion += 1;
    const writer = createCommercePlanWriter({ sql: db.sql, ready: Promise.resolve() });
    const verdict = await writer.put(org, {
        plan: 'enterprise',
        includedMinutes: null,
        usedMinutes: null,
        periodStart: null,
        periodEnd: null,
        maxRunning: null,
        maxQueued: null,
        maxWallSeconds: null,
        maxTokens: null,
        maxStorageBytes: null,
        maxRetentionDays: days,
        version: pushVersion,
    });
    expect(verdict).toEqual({ verdict: 'stored' });
}

/** Runs `run` with the row step failing as a board lost mid-transaction would: its statements roll back together. */
async function crashRowStep(run: () => Promise<unknown>): Promise<void> {
    await db.sql`create function retention_test_crash() returns trigger language plpgsql as $$
                 begin raise exception 'board lost'; end $$`;
    await db.sql`create trigger retention_test_crash before delete on job_pr
                 for each statement execute function retention_test_crash()`;
    try {
        await run();
    } finally {
        await db.sql`drop trigger retention_test_crash on job_pr`;
        await db.sql`drop function retention_test_crash()`;
    }
}

/** The pool with its fence read held back until released: a writer paused between its earlier steps and its put. */
function pausedAtFence(): { sql: Sql; arrived: Promise<void>; release: () => void } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let arrive!: () => void;
    const arrived = new Promise<void>((resolve) => {
        arrive = resolve;
    });
    const sql = new Proxy(db.sql, {
        apply(target, self, args: unknown[]) {
            const strings = args[0] as readonly string[] | undefined;
            if (Array.isArray(strings) && strings.join('').includes('open_for_writes')) {
                arrive();
                return held.then(() => Reflect.apply(target, self, args));
            }
            return Reflect.apply(target, self, args);
        },
    });
    return { sql, arrived, release };
}

describe.skipIf(!enabled)('object writes against the retention pass', () => {
    it('refuses an upload that reads the fence after the thread was deleted, and writes no object', async () => {
        const root = await oldThread();
        const paused = pausedAtFence();
        const artifacts = createArtifactStore({
            sql: paused.sql,
            orgId: org,
            ready: Promise.resolve(),
            objects,
            prefix: PREFIX,
        });
        const settled = artifacts.putChunk(streamRef(root), 0, bytes('late')).catch((e: unknown) => e);
        await paused.arrived;

        await pass();
        expect(await stamped(root)).toBe(true);
        await age(root, DRAIN_MS);
        await pass();
        expect(await present(root)).toBe(false);
        paused.release();

        expect(await settled).toBeInstanceOf(ThreadExpiringError);
        expect(await keysLeft()).toEqual([]);
    });

    it('lists the prefixes only after the drain, so a write that passed the fence before the stamp is deleted too', async () => {
        const root = await oldThread();
        // A write that read the fence just before the stamp, its put held until the stamp is in.
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let arrive!: () => void;
        const arrived = new Promise<void>((resolve) => {
            arrive = resolve;
        });
        const slow: ObjectStore = {
            ...objects,
            put: (key, body, options) => {
                arrive();
                return held.then(() => objects.put(key, body, options));
            },
        };
        const artifacts = createArtifactStore({
            sql: db.sql,
            orgId: org,
            ready: Promise.resolve(),
            objects: slow,
            prefix: PREFIX,
        });
        const ref = streamRef(root);
        const write = artifacts.putChunk(ref, 0, bytes('in flight'));
        await arrived;
        await pass();
        expect(await stamped(root)).toBe(true);
        release();
        expect((await write).result).toBe('stored');
        await pass();
        expect(await keysLeft()).toEqual([chunkKey(PREFIX, org, ref, 0)]);
        expect(await present(root)).toBe(true);
        const [stamp] = await db.sql`select last_error from thread_expiry where root_job_id = ${root}`;
        expect(stamp?.last_error).toBeNull();

        await age(root, DRAIN_MS);
        await pass();
        expect(await present(root)).toBe(false);
        expect(await keysLeft()).toEqual([]);
    });
});

describe.skipIf(!enabled)('a stamped thread', () => {
    it('refuses a follow-up and a retry, so no member appears in a thread being deleted', async () => {
        const root = await oldThread();
        await pass();
        expect(await stamped(root)).toBe(true);
        expect(
            await createFollowUpRow(db.sql, { orgId: org, parentId: root, command: 'again', createdBy: user.id })
        ).toBe('missing');
        expect(await createRetryRow(db.sql, { orgId: org, id: root, createdBy: user.id })).toBe('missing');
        expect(await db.sql`select 1 from job where root_job_id = ${root}`).toHaveLength(1);
    });

    it('is lifted by an upgrade before anything is deleted, and takes follow-ups again', async () => {
        const root = await oldThread();
        await pass();
        await db.sql`insert into org_plan (org_id, plan, version, max_retention_days) values (${org}, 'enterprise', 1, 400)`;
        await age(root, DRAIN_MS);
        await pass();
        expect(await present(root)).toBe(true);
        expect(await stamped(root)).toBe(false);
        const followed = await createFollowUpRow(db.sql, {
            orgId: org,
            parentId: root,
            command: 'again',
            createdBy: user.id,
        });
        expect(typeof followed).toBe('object');
    });

    it('stays stamped and whole when its row step fails, and the next pass finishes it', async () => {
        const root = await oldThread();
        await createArtifactStore({
            sql: db.sql,
            orgId: org,
            ready: Promise.resolve(),
            objects,
            prefix: PREFIX,
        }).putChunk(streamRef(root), 0, bytes('transcript'));
        await pass();
        await age(root, DRAIN_MS);
        // A board lost mid-transaction: the row step's statements roll back together.
        await db.sql`create function retention_test_crash() returns trigger language plpgsql as $$
                     begin raise exception 'board lost'; end $$`;
        await db.sql`create trigger retention_test_crash before delete on job_pr
                     for each statement execute function retention_test_crash()`;
        try {
            await pass();
        } finally {
            await db.sql`drop trigger retention_test_crash on job_pr`;
            await db.sql`drop function retention_test_crash()`;
        }
        expect(await present(root)).toBe(true);
        expect(await stamped(root)).toBe(true);
        expect(
            await createFollowUpRow(db.sql, { orgId: org, parentId: root, command: 'again', createdBy: user.id })
        ).toBe('missing');

        await pass();
        expect(await present(root)).toBe(false);
        expect(await keysLeft()).toEqual([]);
    });

    it('once its deletion began, an upgrade never revives it: a failed row step is finished by the next pass', async () => {
        const root = await oldThread();
        await createArtifactStore({
            sql: db.sql,
            orgId: org,
            ready: Promise.resolve(),
            objects,
            prefix: PREFIX,
        }).putChunk(streamRef(root), 0, bytes('transcript'));
        await pass();
        await age(root, DRAIN_MS);
        await crashRowStep(() => pass());
        // The objects are gone; reviving the thread now would hand a follow-up a task with no transcripts.
        expect(await keysLeft()).toEqual([]);
        await upgradeTo(400);
        await pass();
        expect(await present(root)).toBe(false);
        expect(
            await db.sql`select 1 from thread_expiry where root_job_id = ${root} and rows_deleted_at is null`
        ).toHaveLength(0);
    });

    it('keeps a task when an upgrade commits between its stamp and the start of its deletion', async () => {
        const root = await oldThread();
        // The upgrade commits right after the pass took its org and stamped, before any unit is expired.
        let pushed = false;
        const racing = new Proxy(db.sql, {
            apply(target, self, args: unknown[]) {
                const strings = args[0] as readonly string[] | undefined;
                if (!pushed && Array.isArray(strings) && strings.join('').includes('group by unit')) {
                    pushed = true;
                    return upgradeTo(400).then(() => Reflect.apply(target, self, args));
                }
                return Reflect.apply(target, self, args);
            },
        });
        await pass({ sql: racing, writeDrainMs: 0 });
        expect(pushed).toBe(true);
        expect(await present(root)).toBe(true);
        expect(await stamped(root)).toBe(false);
    });
});
