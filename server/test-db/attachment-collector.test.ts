import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { createAttachmentCollector } from '../src/attachments/attachment-collector.js';
import { attachmentKey } from '../src/attachments/attachment-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The attachment collector (docs/persistence.md): expiry of abandoned drafts, reconcile of `bound` files whose job is
 * gone, and the object delete that follows a committed `deleting`, on a real database and a filesystem object store.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('collector-alice');
const PREFIX = 'test/';
const TTL_HOURS = 24;
const RACE_ROUNDS = 25;

const db = useTestDb({ orgs: [ORG], users: [ALICE], max: 8 });
let sql: Sql;
let objects: ObjectStore;
let store: JobStore;

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    objects = createFilesystemStore(await mkdtemp(join(tmpdir(), 'attachment-collector-')));
    store = createJobStore({ sql, orgId: ORG });
});

const collectorOf = (over: Partial<ObjectStore> = {}, prefix = PREFIX) =>
    createAttachmentCollector({
        sql,
        ready: Promise.resolve(),
        objects: { ...objects, ...over } as ObjectStore,
        prefix,
        draftTtlHours: TTL_HOURS,
    });

/** One attachment row with its object written, `ageHours` old. */
const file = async (state: string, ageHours = 0, org = ORG): Promise<{ id: string; key: string }> => {
    const id = randomUUID();
    const key = attachmentKey(PREFIX, org, id);
    await objects.put(key, new TextEncoder().encode('body'));
    await sql`
        insert into input_attachment (org_id, id, uploader_id, name, media_type, size_bytes, sha256, object_key, state, created_at)
        values (${org}, ${id}, ${ALICE.id}, 'a.txt', 'text/plain', 4, ${randomUUID()}, ${key}, ${state},
                now() - make_interval(hours => ${ageHours}))
    `;
    return { id, key };
};

const stateOf = async (id: string): Promise<string> => {
    const [row] = await sql<{ state: string }[]>`select state from input_attachment where id = ${id}`;
    return row!.state;
};
const present = async (key: string): Promise<boolean> => (await objects.head(key)) !== null;
const create = async (ids: string[]) =>
    store.create('work', ALICE.id, { repo: null, executor: null, attachmentIds: ids });

describe.runIf(enabled)('attachment collector', () => {
    it('expires an old ready draft to deleting, deletes its object, and keeps a deleted tombstone row', async () => {
        const old = await file('ready', TTL_HOURS + 1);
        const stale = await file('pending', TTL_HOURS + 1);

        const summary = await collectorOf().collect();

        expect(summary).toMatchObject({ expired: expect.any(Number), deleted: expect.any(Number) });
        expect(await stateOf(old.id)).toBe('deleted');
        expect(await stateOf(stale.id)).toBe('deleted');
        expect(await present(old.key)).toBe(false);
        expect(await present(stale.key)).toBe(false);
    });

    it('leaves a draft inside the TTL alone', async () => {
        const fresh = await file('ready', TTL_HOURS - 1);
        const pending = await file('pending', 0);

        await collectorOf().collect();

        expect(await stateOf(fresh.id)).toBe('ready');
        expect(await stateOf(pending.id)).toBe('pending');
        expect(await present(fresh.key)).toBe(true);
    });

    it('leaves a bound file with a live job alone', async () => {
        const kept = await file('ready', TTL_HOURS + 1);
        const job = await create([kept.id]);
        if (typeof job === 'string') throw new Error(job);
        await sql`update input_attachment set created_at = now() - interval '100 hours' where id = ${kept.id}`;

        await collectorOf().collect();

        expect(await stateOf(kept.id)).toBe('bound');
        expect(await present(kept.key)).toBe(true);
    });

    it('reclaims a bound file whose job row was deleted outside removeThread', async () => {
        const orphan = await file('ready');
        const job = await create([orphan.id]);
        if (typeof job === 'string') throw new Error(job);
        await sql`delete from job where org_id = ${ORG} and id = ${job.id}`;

        await collectorOf().collect();

        expect(await stateOf(orphan.id)).toBe('deleted');
        expect(await present(orphan.key)).toBe(false);
    });

    it('deletes the originals of a removed thread after reads are already denied', async () => {
        const original = await file('ready');
        const job = await create([original.id]);
        if (typeof job === 'string') throw new Error(job);
        const claim = await store.claim('w1', 60);
        await store.complete(job.id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        await store.removeThread(job.id, ALICE.id);
        expect(await stateOf(original.id)).toBe('deleting');
        expect(await present(original.key)).toBe(true);

        await collectorOf().collect();

        expect(await stateOf(original.id)).toBe('deleted');
        expect(await present(original.key)).toBe(false);
    });

    it('keeps a row deleting when the object delete throws, and the next pass finishes it', async () => {
        const row = await file('ready', TTL_HOURS + 1);
        const failing = collectorOf({
            delete: async () => {
                throw new Error('store down');
            },
        });

        await failing.collect();
        expect(await stateOf(row.id)).toBe('deleting');
        expect(await present(row.key)).toBe(true);

        await collectorOf().collect();
        expect(await stateOf(row.id)).toBe('deleted');
        expect(await present(row.key)).toBe(false);
    });

    it('completes a row left deleting by a process that died between the flip and the delete', async () => {
        const row = await file('ready');
        await sql`update input_attachment set state = 'deleting', deleting_at = now() where id = ${row.id}`;

        await collectorOf().collect();

        expect(await stateOf(row.id)).toBe('deleted');
        expect(await present(row.key)).toBe(false);
    });

    it('never binds a deleting row', async () => {
        const row = await file('ready', TTL_HOURS + 1);
        await collectorOf({
            delete: async () => {
                throw new Error('store down');
            },
        }).collect();
        expect(await stateOf(row.id)).toBe('deleting');

        await expect(create([row.id])).rejects.toMatchObject({ name: 'AttachmentRefusedError' });
        expect(await stateOf(row.id)).toBe('deleting');
    });

    it('aborts the pass without deleting anything when the database answer is unconfirmed', async () => {
        const row = await file('ready');
        await sql`update input_attachment set state = 'deleting', deleting_at = now() where id = ${row.id}`;
        let deletes = 0;
        const broken = createAttachmentCollector({
            sql: new Proxy(sql, {
                apply: () => Promise.reject(new Error('connection lost')),
                get: (target, prop) =>
                    prop === 'begin' ? () => Promise.reject(new Error('connection lost')) : Reflect.get(target, prop),
            }) as Sql,
            ready: Promise.resolve(),
            objects: { ...objects, delete: async () => void deletes++ } as ObjectStore,
            prefix: PREFIX,
            draftTtlHours: TTL_HOURS,
        });

        await expect(broken.collect()).rejects.toThrow();
        expect(deletes).toBe(0);
        expect(await present(row.key)).toBe(true);
    });

    it('stops between items when the signal aborts, leaving rows deleting', async () => {
        const row = await file('ready');
        await sql`update input_attachment set state = 'deleting', deleting_at = now() where id = ${row.id}`;
        const controller = new AbortController();
        controller.abort();

        await collectorOf().collect({ signal: controller.signal });

        expect(await stateOf(row.id)).toBe('deleting');
        expect(await present(row.key)).toBe(true);
    });

    it('never deletes a key outside the attachment namespace', async () => {
        const id = randomUUID();
        const foreign = `${PREFIX}${ORG}/job/transcript`;
        await objects.put(foreign, new TextEncoder().encode('keep'));
        await sql`
            insert into input_attachment (org_id, id, uploader_id, name, media_type, size_bytes, sha256, object_key, state, deleting_at)
            values (${ORG}, ${id}, ${ALICE.id}, 'a.txt', 'text/plain', 4, ${randomUUID()}, ${foreign}, 'deleting', now())
        `;

        await collectorOf().collect();

        expect(await present(foreign)).toBe(true);
        expect(await stateOf(id)).toBe('deleting');
    });

    it('serializes a bind against an expiry of the same row: exactly one wins', async () => {
        for (let round = 0; round < RACE_ROUNDS; round++) {
            const row = await file('ready', TTL_HOURS + 1);
            const collector = collectorOf();

            const [created] = await Promise.allSettled([create([row.id]), collector.collect()]);
            await collector.collect();

            if (created.status === 'fulfilled') {
                expect(typeof created.value).not.toBe('string');
                expect(await stateOf(row.id)).toBe('bound');
                expect(await present(row.key)).toBe(true);
            } else {
                expect(await stateOf(row.id)).toBe('deleted');
                expect(await present(row.key)).toBe(false);
            }
        }
    });
});
