import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';

/**
 * a task's title lives on the thread root (BEL-252): set at create or by a rename, never carried by a
 * follow-up, retry or successor, and every write leaves one audit row.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const WORKER = 'worker-1';
const LEASE_SECONDS = 60;
const AUTHOR = testUser('title-author');
const STRANGER = testUser('title-stranger');
const ADMIN = testUser('title-admin');
const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [AUTHOR, STRANGER, ADMIN], max: 8 });

let sql: Sql;
let store: JobStore;
let otherStore: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    otherStore = createJobStore({ sql, orgId: OTHER_ORG });
});

async function queue(title?: string | null, command = 'fix the flaky login test'): Promise<string> {
    const created = await store.create(command, AUTHOR.id, {
        repo: null,
        executor: null,
        ...(title === undefined ? {} : { title }),
    });
    if (typeof created === 'string') throw new Error(created);
    return created.id;
}

async function claim(): Promise<Claim> {
    const claimed = (await store.claim(WORKER, LEASE_SECONDS)) as Claim | null;
    expect(claimed).not.toBeNull();
    return claimed!;
}

async function finish(claimed: Claim, status: 'succeeded' | 'failed' = 'succeeded') {
    await store.session(claimed.id, claimed.leaseToken, randomUUID());
    await store.complete(claimed.id, claimed.leaseToken, {
        status,
        exitCode: status === 'succeeded' ? 0 : 1,
        output: '',
    });
}

const titleRow = async (id: string) => {
    const [row] = await sql<
        { title: string | null; title_origin: string | null; title_revision: number }[]
    >`select title, title_origin, title_revision from job where id = ${id}`;
    return row!;
};

const events = (root: string) =>
    sql<{ revision: number; origin: string; title: string; actor_user_id: string | null }[]>`
        select revision, origin, title, actor_user_id from job_title_event where root_job_id = ${root} order by revision
    `;

describe.skipIf(!enabled)('task title — database', () => {
    it('create with title stores it, origin user, revision 1, one audit row', async () => {
        const id = await queue('Fix login');
        expect(await titleRow(id)).toEqual({ title: 'Fix login', title_origin: 'user', title_revision: 1 });
        expect(await events(id)).toEqual([
            { revision: 1, origin: 'user', title: 'Fix login', actor_user_id: AUTHOR.id },
        ]);
    });

    it('create without title stores null and no audit row', async () => {
        for (const given of [undefined, null]) {
            const id = await queue(given);
            expect(await titleRow(id)).toEqual({ title: null, title_origin: null, title_revision: 0 });
            expect(await events(id)).toEqual([]);
        }
    });

    it('a follow-up and a retry never carry or change the root title', async () => {
        const root = await queue('Root title');
        const first = await claim();
        await finish(first, 'failed');
        const retry = await store.createRetry(root, AUTHOR.id);
        if (typeof retry === 'string') throw new Error(retry);
        const second = await claim();
        await finish(second);
        const followUp = await store.createFollowUp(root, 'and more', AUTHOR.id);
        if (typeof followUp === 'string') throw new Error(followUp);
        for (const id of [retry.id, followUp.id]) {
            expect((await titleRow(id)).title).toBeNull();
        }
        expect(await titleRow(root)).toEqual({ title: 'Root title', title_origin: 'user', title_revision: 1 });
        expect((await store.get(followUp.id))?.title).toBe('Root title');
    });

    it('rename sets title, origin user, bumps revision, writes one audit row', async () => {
        const id = await queue(null);
        const renamed = await store.renameTask(id, { title: 'Better name', revision: 0, caller: AUTHOR.id });
        expect(renamed).toEqual({ ok: true, title: 'Better name', origin: 'user', revision: 1 });
        expect(await titleRow(id)).toEqual({ title: 'Better name', title_origin: 'user', title_revision: 1 });
        const again = await store.renameTask(id, { title: 'Even better', revision: 1, caller: AUTHOR.id });
        expect(again).toEqual({ ok: true, title: 'Even better', origin: 'user', revision: 2 });
        expect((await events(id)).map((e) => [e.revision, e.title, e.actor_user_id])).toEqual([
            [1, 'Better name', AUTHOR.id],
            [2, 'Even better', AUTHOR.id],
        ]);
    });

    it('rename with a stale revision is stale, carries the current title and changes nothing', async () => {
        const id = await queue('Current');
        const stale = await store.renameTask(id, { title: 'Mine', revision: 0, caller: AUTHOR.id });
        expect(stale).toEqual({ ok: false, refusal: 'stale', title: 'Current', origin: 'user', revision: 1 });
        expect(await titleRow(id)).toEqual({ title: 'Current', title_origin: 'user', title_revision: 1 });
        expect(await events(id)).toHaveLength(1);
    });

    it('two concurrent renames on the same revision: exactly one wins', async () => {
        const id = await queue(null);
        const results = await Promise.all([
            store.renameTask(id, { title: 'First', revision: 0, caller: AUTHOR.id }),
            store.renameTask(id, { title: 'Second', revision: 0, caller: AUTHOR.id }),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok && r.refusal === 'stale')).toHaveLength(1);
        expect((await titleRow(id)).title_revision).toBe(1);
        expect(await events(id)).toHaveLength(1);
    });

    it('rename on a follow-up id writes the root', async () => {
        const root = await queue(null);
        await finish(await claim());
        const followUp = await store.createFollowUp(root, 'more', AUTHOR.id);
        if (typeof followUp === 'string') throw new Error(followUp);
        const renamed = await store.renameTask(followUp.id, { title: 'On the thread', revision: 0, caller: AUTHOR.id });
        expect(renamed).toMatchObject({ ok: true, title: 'On the thread' });
        expect((await titleRow(root)).title).toBe('On the thread');
        expect((await titleRow(followUp.id)).title).toBeNull();
    });

    it('rename by a non-author non-admin is forbidden; by an admin succeeds', async () => {
        const id = await queue(null);
        expect(await store.renameTask(id, { title: 'Nope', revision: 0, caller: STRANGER.id })).toEqual({
            ok: false,
            refusal: 'forbidden',
        });
        expect(await store.renameTask(id, { title: 'Nope', revision: 0, caller: null })).toEqual({
            ok: false,
            refusal: 'forbidden',
        });
        expect((await titleRow(id)).title).toBeNull();
        expect(
            await store.renameTask(id, { title: 'Admin pick', revision: 0, caller: ADMIN.id, admin: true })
        ).toMatchObject({ ok: true });
        expect((await events(id))[0]).toMatchObject({ actor_user_id: ADMIN.id });
    });

    it("another org's id is missing, and an unknown id is missing", async () => {
        const id = await queue(null);
        expect(await otherStore.renameTask(id, { title: 'x', revision: 0, caller: AUTHOR.id })).toEqual({
            ok: false,
            refusal: 'missing',
        });
        expect(await store.renameTask(randomUUID(), { title: 'x', revision: 0, caller: AUTHOR.id })).toEqual({
            ok: false,
            refusal: 'missing',
        });
    });

    it('thread, get, list, terminal list and task summary reads carry the root title', async () => {
        const root = await queue('Read me');
        const first = await claim();
        await finish(first);
        const followUp = await store.createFollowUp(root, 'again', AUTHOR.id);
        if (typeof followUp === 'string') throw new Error(followUp);
        const expected = { title: 'Read me', titleOrigin: 'user', titleRevision: 1 };

        expect((await store.thread(root))!.map((job) => [job.title, job.titleOrigin, job.titleRevision])).toEqual([
            ['Read me', 'user', 1],
            ['Read me', 'user', 1],
        ]);
        expect(await store.get(followUp.id)).toMatchObject(expected);
        expect((await store.list({ limit: 10 })).find((job) => job.id === followUp.id)).toMatchObject(expected);
        await finish(await claim());
        expect((await store.list({ status: 'terminal', limit: 10 })).find((job) => job.id === root)).toMatchObject(
            expected
        );
        const tasks = (await store.listTasks({ state: 'review', sort: 'newest', limit: 10 })).page.items;
        expect(tasks.find((task) => task.id === root)).toMatchObject(expected);
    });

    it('an untitled task reads null title and revision 0', async () => {
        const id = await queue(null);
        expect(await store.get(id)).toMatchObject({ title: null, titleOrigin: null, titleRevision: 0 });
    });

    it('the claim payload carries no title', async () => {
        await queue('Not for the prompt', 'do the work');
        const claimed = await claim();
        expect(JSON.stringify(claimed)).not.toContain('Not for the prompt');
        expect(claimed).not.toHaveProperty('title');
    });

    it('a command edit of a queued task leaves the title untouched', async () => {
        const id = await queue('Stays', 'old command');
        const edited = await store.editCommand(id, 'new command', AUTHOR.id);
        expect(edited).toMatchObject({ result: 'ok' });
        expect(await titleRow(id)).toEqual({ title: 'Stays', title_origin: 'user', title_revision: 1 });
    });
});
