import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore, TaskState } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { craftJob, testOrg, testUser, type CraftShape } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;

const ORG = testOrg();
const AUTHOR_USER = testUser('archive-cat');
const AUTHOR = AUTHOR_USER.id;

const db = useTestDb({ max: 8, orgs: [ORG], users: [AUTHOR_USER] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

const craft = (shape: CraftShape = {}) => craftJob({ sql, org: ORG, author: AUTHOR }, shape);

/** A finished, not-done task: the "review" bucket. */
const finished = () => craft({ status: 'succeeded', finishedMinutesAgo: 1 });

const idsIn = async (state: TaskState) =>
    (await store.listTasks({ state, sort: 'newest', limit: 50 })).page.items.map((item) => item.id);

describe.skipIf(!enabled)('archiving a task', () => {
    it('takes a finished task out of every active bucket and into the archived one, still readable', async () => {
        const archived = await finished();
        const kept = await finished();

        expect(await store.archiveThread(archived, AUTHOR)).toMatchObject({ result: 'ok', rootJobId: archived });

        for (const state of ['attention', 'review', 'past', 'running'] as const) {
            expect(await idsIn(state)).not.toContain(archived);
        }
        expect(await idsIn('review')).toContain(kept);
        expect(await idsIn('archived')).toEqual([archived]);

        const job = await store.get(archived);
        expect(job?.archivedAt).toEqual(expect.any(String));
        expect(job?.archivedBy?.id).toBe(AUTHOR);
        expect(await store.thread(archived)).toHaveLength(1);
        const { navigation } = await store.listTasks({ state: 'archived', sort: 'newest', limit: 5 });
        expect(navigation.counts).toMatchObject({ review: 1, archived: 1 });
    });

    it('archives a running task by stopping it first', async () => {
        const id = await craft({ status: 'running', lease: 'live' });

        expect(await store.archiveThread(id, AUTHOR)).toMatchObject({ result: 'ok' });

        const job = await store.get(id);
        expect(job?.cancelRequestedAt).toEqual(expect.any(String));
        expect(job?.archivedAt).toEqual(expect.any(String));
        expect(await idsIn('running')).not.toContain(id);
        expect(await idsIn('archived')).toContain(id);
    });

    it('stops a queued follow-up and archives the whole thread, whichever member is named', async () => {
        const root = await finished();
        const queued = await craft({ parent: root, root, status: 'queued' });

        expect(await store.archiveThread(root, AUTHOR)).toMatchObject({ result: 'ok' });

        expect((await store.get(queued))?.status).toBe('stopped');
        const members = (await store.thread(root))!;
        expect(members).toHaveLength(2);
        expect(members.every((member) => member.archivedAt !== null)).toBe(true);
    });

    it('is idempotent: a second archive keeps the first instant', async () => {
        const id = await finished();
        await store.archiveThread(id, AUTHOR);
        const first = (await store.get(id))!.archivedAt;

        expect(await store.archiveThread(id, null)).toMatchObject({ result: 'ok' });
        expect((await store.get(id))!.archivedAt).toBe(first);
    });

    it('answers missing for an unknown task', async () => {
        expect(await store.archiveThread(randomUUID(), AUTHOR)).toBe('missing');
    });

    it('refuses to follow up or retry an archived task until it is unarchived', async () => {
        const id = await finished();
        await store.archiveThread(id, AUTHOR);

        expect(await store.createFollowUp(id, 'again', AUTHOR)).toBe('task_archived');
        expect(await store.createRetry(id, AUTHOR)).toBe('task_archived');

        expect(await store.unarchiveThread(id)).toEqual({ result: 'ok' });
        expect(await store.createFollowUp(id, 'again', AUTHOR)).toMatchObject({ id: expect.any(String) });
    });
});

describe.skipIf(!enabled)('unarchiving a task', () => {
    it('returns each task to the bucket it left', async () => {
        const review = await finished();
        const past = await craft({ status: 'succeeded', finishedMinutesAgo: 1, doneMinutesAgo: 1 });
        await store.archiveThread(review, AUTHOR);
        await store.archiveThread(past, AUTHOR);

        await store.unarchiveThread(review);
        await store.unarchiveThread(past);

        expect(await idsIn('review')).toContain(review);
        expect(await idsIn('past')).toContain(past);
        expect(await idsIn('archived')).toEqual([]);
        expect((await store.get(review))?.archivedAt).toBeNull();
    });

    it('refuses a task that is not archived, and an unknown one', async () => {
        const id = await finished();
        expect(await store.unarchiveThread(id)).toBe('not_archived');
        expect(await store.unarchiveThread(randomUUID())).toBe('missing');
    });
});
