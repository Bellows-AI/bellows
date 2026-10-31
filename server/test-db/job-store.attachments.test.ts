import { randomUUID } from 'node:crypto';
import { MAX_FILES_PER_REQUEST, MAX_REQUEST_BYTES } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { AttachmentRefusedError } from '../src/db/jobs/job-store-attachments.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * Binding uploaded files to tasks: a create or follow-up names ready files, and they are bound in the
 * transaction that inserts the job or not at all. The thread read and the removal follow the binding.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const ALICE = testUser('att-alice');
const BOB = testUser('att-bob');
const LEASE_SECONDS = 60;
const SMALL = 1024;
const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ALICE, BOB], max: 8 });

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

type State = 'pending' | 'ready' | 'bound';

/** One attachment row written directly: this file is about binding, not the upload path. */
const file = async (
    uploader: string,
    options: { org?: string; state?: State; size?: number; name?: string } = {}
): Promise<string> => {
    const { org = ORG, state = 'ready', size = SMALL, name = 'notes.txt' } = options;
    const id = randomUUID();
    await sql`
        insert into input_attachment (org_id, id, uploader_id, name, media_type, size_bytes, sha256, object_key, state)
        values (${org}, ${id}, ${uploader}, ${name}, 'text/plain', ${size}, ${randomUUID()}, ${`k/${id}`}, ${state})
    `;
    return id;
};

interface AttachmentRowState {
    state: string;
    bound_job_id: string | null;
    root_job_id: string | null;
    position: number | null;
}

const rowOrNull = async (id: string): Promise<AttachmentRowState | null> => {
    const [row] = await sql<AttachmentRowState[]>`
        select state, bound_job_id, root_job_id, position from input_attachment where id = ${id}
    `;
    return row ?? null;
};

const rowOf = async (id: string): Promise<AttachmentRowState> => (await rowOrNull(id))!;

const create = async (by: string | null, attachmentIds: string[]): Promise<{ id: string }> => {
    const ref = await store.create('do the work', by, { repo: null, executor: null, attachmentIds });
    if (typeof ref === 'string') throw new Error(ref);
    return ref;
};

const jobsBy = async (by: string): Promise<number> => {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from job where created_by = ${by}`;
    return row!.n;
};

const finish = async (id: string): Promise<void> => {
    const claim = await store.claim('w1', LEASE_SECONDS);
    await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
};

const refusal = async (run: Promise<unknown>): Promise<AttachmentRefusedError> => {
    const error = await run.then(
        () => null,
        (e: unknown) => e
    );
    expect(error).toBeInstanceOf(AttachmentRefusedError);
    return error as AttachmentRefusedError;
};

describe.runIf(enabled)('binding files on create', () => {
    it('binds every listed file to the new task, in the order named', async () => {
        const first = await file(ALICE.id);
        const second = await file(ALICE.id);

        const job = await create(ALICE.id, [second, first]);

        expect(await rowOf(second)).toEqual({ state: 'bound', bound_job_id: job.id, root_job_id: job.id, position: 0 });
        expect(await rowOf(first)).toEqual({ state: 'bound', bound_job_id: job.id, root_job_id: job.id, position: 1 });
    });

    it.each([
        ['another member', async () => file(BOB.id)],
        ['another organization', async () => file(ALICE.id, { org: OTHER_ORG })],
        ['a pending file', async () => file(ALICE.id, { state: 'pending' })],
        ['an already bound file', async () => file(ALICE.id, { state: 'bound' })],
        ['an unknown id', async () => randomUUID()],
    ])('refuses %s and creates nothing, leaving every listed row as it was', async (_name, make) => {
        const good = await file(ALICE.id);
        const bad = await make();
        const before = [await rowOrNull(good), await rowOrNull(bad)];

        const error = await refusal(create(ALICE.id, [good, bad]));

        expect(error.reason).toBe('not-authorized');
        expect(await jobsBy(ALICE.id)).toBe(0);
        expect([await rowOrNull(good), await rowOrNull(bad)]).toEqual(before);
    });

    it('refuses more files than a request may carry', async () => {
        const ids = await Promise.all(Array.from({ length: MAX_FILES_PER_REQUEST + 1 }, () => file(ALICE.id)));

        const error = await refusal(create(ALICE.id, ids));

        expect(error.reason).toBe('too-many');
        expect(await jobsBy(ALICE.id)).toBe(0);
        expect((await rowOf(ids[0]!)).state).toBe('ready');
    });

    it('refuses a request whose files together exceed the request limit', async () => {
        const half = Math.floor(MAX_REQUEST_BYTES / 2);
        const ids = [
            await file(ALICE.id, { size: half }),
            await file(ALICE.id, { size: half }),
            await file(ALICE.id, { size: 1 }),
        ];

        const error = await refusal(create(ALICE.id, ids));

        expect(error.reason).toBe('too-large');
        expect(await jobsBy(ALICE.id)).toBe(0);
        expect((await rowOf(ids[0]!)).state).toBe('ready');
    });

    it('refuses an id listed twice', async () => {
        const id = await file(ALICE.id);

        const error = await refusal(create(ALICE.id, [id, id]));

        expect(error.reason).toBe('duplicate');
        expect(await jobsBy(ALICE.id)).toBe(0);
    });

    it('refuses files for a task with no author', async () => {
        const id = await file(ALICE.id);

        expect((await refusal(create(null, [id]))).reason).toBe('not-authorized');
        expect((await rowOf(id)).state).toBe('ready');
    });

    it('lets exactly one of two creates bind the same ready file', async () => {
        const id = await file(ALICE.id);

        const settled = await Promise.allSettled([create(ALICE.id, [id]), create(ALICE.id, [id])]);

        expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason).toBeInstanceOf(AttachmentRefusedError);
        expect(await jobsBy(ALICE.id)).toBe(1);
    });
});

describe.runIf(enabled)('binding files on a follow-up', () => {
    it('binds the new file to the follow-up and leaves the parent files alone', async () => {
        const original = await file(ALICE.id);
        const parent = await create(ALICE.id, [original]);
        await finish(parent.id);
        const added = await file(ALICE.id);

        const followUp = await store.createFollowUp(parent.id, 'again', ALICE.id, undefined, [], undefined, [added]);

        if (typeof followUp === 'string') throw new Error(followUp);
        expect(await rowOf(original)).toMatchObject({
            state: 'bound',
            bound_job_id: parent.id,
            root_job_id: parent.id,
        });
        expect(await rowOf(added)).toMatchObject({ state: 'bound', bound_job_id: followUp.id, root_job_id: parent.id });
    });

    it('binds nothing when the follow-up itself is refused', async () => {
        const parent = await create(ALICE.id, []);
        const added = await file(ALICE.id);

        expect(await store.createFollowUp(parent.id, 'again', ALICE.id, undefined, [], undefined, [added])).toBe(
            'not_finished'
        );
        expect((await rowOf(added)).state).toBe('ready');
    });
});

describe.runIf(enabled)('thread history and removal', () => {
    it('shows each file on the request that carried it, and only while its job exists', async () => {
        const original = await file(ALICE.id, { name: 'spec.txt' });
        const parent = await create(ALICE.id, [original]);
        await finish(parent.id);
        const added = await file(ALICE.id, { name: 'more.txt' });
        const followUp = await store.createFollowUp(parent.id, 'again', ALICE.id, undefined, [], undefined, [added]);
        if (typeof followUp === 'string') throw new Error(followUp);

        const rows = (await store.thread(parent.id))!;

        expect(rows.map((r) => r.attachments.map((a) => a.id))).toEqual([[original], [added]]);
        expect(rows[0]!.attachments[0]).toMatchObject({ name: 'spec.txt', mediaType: 'text/plain', state: 'bound' });

        await sql`delete from job where id = ${followUp.id}`;
        expect((await store.thread(parent.id))!.flatMap((r) => r.attachments.map((a) => a.id))).toEqual([original]);
    });

    it('moves every bound file of the thread to deleting when the thread is removed', async () => {
        const original = await file(ALICE.id);
        const parent = await create(ALICE.id, [original]);
        await finish(parent.id);
        const added = await file(ALICE.id);
        const followUp = await store.createFollowUp(parent.id, 'again', ALICE.id, undefined, [], undefined, [added]);
        if (typeof followUp === 'string') throw new Error(followUp);
        await finish(followUp.id);
        const unrelated = await file(ALICE.id);
        await create(ALICE.id, [unrelated]);

        expect(await store.removeThread(parent.id, ALICE.id)).toMatchObject({ result: 'ok' });

        expect((await rowOf(original)).state).toBe('deleting');
        expect((await rowOf(added)).state).toBe('deleting');
        expect((await rowOf(unrelated)).state).toBe('bound');
        const [counted] = await sql<{ n: number }[]>`
            select count(*)::int as n from input_attachment where root_job_id = ${parent.id} and state = 'bound'
        `;
        expect(counted!.n).toBe(0);
    });
});
