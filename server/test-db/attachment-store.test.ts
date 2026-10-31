import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import {
    AttachmentIntegrityError,
    AttachmentUnavailableError,
    attachmentKey,
    createAttachmentStore,
} from '../src/attachments/attachment-store.js';
import { createAttachmentCollector } from '../src/attachments/attachment-collector.js';
import { createAttachmentRows } from '../src/attachments/attachment-rows.js';
import { craftJob, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/** The attachment index (114) over a filesystem object store: the state machine and its scoping, on a real database. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const OWNER = testUser('attachment-owner');
const STRANGER = testUser('attachment-stranger');
const PREFIX = 'test/';

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [OWNER, STRANGER] });
let sql: Sql;
let objects: ObjectStore;
beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    objects = createFilesystemStore(await mkdtemp(join(tmpdir(), 'attachments-')));
});

const storeOf = (org: string, over: ObjectStore | Partial<ObjectStore> = {}) =>
    createAttachmentStore({
        rows: createAttachmentRows({ sql, orgId: org, ready: Promise.resolve() }),
        objects: { ...objects, ...over } as ObjectStore,
        orgId: org,
        prefix: PREFIX,
    });

const bytes = (text: string) => new TextEncoder().encode(text);
const upload = (text: string, over: { uploaderId?: string; idempotencyKey?: string } = {}) => ({
    uploaderId: OWNER.id,
    name: 'note.txt',
    mediaType: 'text/plain',
    bytes: bytes(text),
    ...over,
});
const rowOf = async (id: string) => {
    const [row] = await sql<
        {
            state: string;
            ready_at: Date | null;
            deleting_at: Date | null;
            deleted_at: Date | null;
            object_key: string;
        }[]
    >`select state, ready_at, deleting_at, deleted_at, object_key from input_attachment where org_id = ${ORG} and id = ${id}`;
    return row!;
};

describe.skipIf(!enabled)('attachment store', () => {
    it('records the row, writes the object, then marks it ready with ready_at stamped', async () => {
        const { meta, replayed } = await storeOf(ORG).upload(upload('hello'));
        expect(replayed).toBe(false);
        expect(meta).toMatchObject({
            name: 'note.txt',
            mediaType: 'text/plain',
            size: 5,
            sha256: createHash('sha256').update('hello').digest('hex'),
            state: 'ready',
        });
        const row = await rowOf(meta.id);
        expect(row.state).toBe('ready');
        expect(row.ready_at).not.toBeNull();
        expect(row.object_key).toBe(attachmentKey(PREFIX, ORG, meta.id));
        expect(row.object_key).toContain('_attachments/');
        expect(new TextDecoder().decode((await objects.get(row.object_key)) ?? undefined)).toBe('hello');
    });

    it('finishes a pending row on retry when the object already exists with the recorded sha256', async () => {
        const key = `idem-${randomUUID()}`;
        const failing = storeOf(ORG, {
            async head() {
                throw new Error('head unavailable');
            },
        });
        await expect(failing.upload(upload('retry me', { idempotencyKey: key }))).rejects.toBeInstanceOf(
            AttachmentUnavailableError
        );
        const [pending] = await sql<{ id: string; state: string }[]>`
            select id, state from input_attachment where org_id = ${ORG} and idempotency_key = ${key}`;
        expect(pending!.state).toBe('pending');

        const { meta, replayed } = await storeOf(ORG).upload(upload('retry me', { idempotencyKey: key }));
        expect(replayed).toBe(true);
        expect(meta.id).toBe(pending!.id);
        expect(meta.state).toBe('ready');
    });

    it('leaves a pending row pending, never ready, when the stored body has another sha256', async () => {
        const key = `idem-${randomUUID()}`;
        const failing = storeOf(ORG, {
            async head() {
                throw new Error('head unavailable');
            },
        });
        await expect(failing.upload(upload('original', { idempotencyKey: key }))).rejects.toBeInstanceOf(
            AttachmentUnavailableError
        );
        const [pending] = await sql<{ id: string }[]>`
            select id from input_attachment where org_id = ${ORG} and idempotency_key = ${key}`;
        const { object_key: objectKey } = await rowOf(pending!.id);
        await objects.delete(objectKey);
        await objects.put(objectKey, bytes('tampered'));

        await expect(storeOf(ORG).upload(upload('original', { idempotencyKey: key }))).rejects.toBeInstanceOf(
            AttachmentIntegrityError
        );
        expect((await rowOf(pending!.id)).state).toBe('pending');
    });

    it('treats an unconfirmed read during the exists arbitration as inconclusive', async () => {
        const key = `idem-${randomUUID()}`;
        const failingHead = storeOf(ORG, {
            async head() {
                throw new Error('head unavailable');
            },
        });
        await expect(failingHead.upload(upload('same', { idempotencyKey: key }))).rejects.toBeInstanceOf(
            AttachmentUnavailableError
        );
        const unreadable = storeOf(ORG, {
            async get() {
                return null;
            },
        });
        await expect(unreadable.upload(upload('same', { idempotencyKey: key }))).rejects.toBeInstanceOf(
            AttachmentUnavailableError
        );
        const [row] = await sql<{ state: string }[]>`
            select state from input_attachment where org_id = ${ORG} and idempotency_key = ${key}`;
        expect(row!.state).toBe('pending');
    });

    it('replays a keyed upload as the recorded row and refuses the key for a different body', async () => {
        const key = `idem-${randomUUID()}`;
        const first = await storeOf(ORG).upload(upload('one', { idempotencyKey: key }));
        const again = await storeOf(ORG).upload(upload('one', { idempotencyKey: key }));
        expect(again.replayed).toBe(true);
        expect(again.meta.id).toBe(first.meta.id);
        await expect(storeOf(ORG).upload(upload('two', { idempotencyKey: key }))).rejects.toThrow(/different request/);
        // A bound row still replays (a client rerun after the task bound it).
        await sql`update input_attachment set state = 'bound' where org_id = ${ORG} and id = ${first.meta.id}`;
        expect((await storeOf(ORG).upload(upload('one', { idempotencyKey: key }))).meta.state).toBe('bound');
    });

    it('scopes a key to the uploader', async () => {
        const key = `idem-${randomUUID()}`;
        const mine = await storeOf(ORG).upload(upload('x', { idempotencyKey: key }));
        const theirs = await storeOf(ORG).upload(upload('x', { idempotencyKey: key, uploaderId: STRANGER.id }));
        expect(theirs.meta.id).not.toBe(mine.meta.id);
    });

    it('reads a draft only for its uploader and its org', async () => {
        const { meta } = await storeOf(ORG).upload(upload('private'));
        expect((await storeOf(ORG).meta(meta.id, OWNER.id))?.id).toBe(meta.id);
        expect(await storeOf(ORG).meta(meta.id, STRANGER.id)).toBeNull();
        expect(await storeOf(OTHER_ORG).meta(meta.id, OWNER.id)).toBeNull();
        expect(await storeOf(ORG).read(meta.id, STRANGER.id)).toBeNull();
        expect(await storeOf(OTHER_ORG).read(meta.id, OWNER.id)).toBeNull();
        expect(new TextDecoder().decode((await storeOf(ORG).read(meta.id, OWNER.id))!.body)).toBe('private');
    });

    const bindTo = async (id: string, jobId: string) =>
        sql`update input_attachment set state = 'bound', bound_job_id = ${jobId}, root_job_id = ${jobId}
            where org_id = ${ORG} and id = ${id}`;

    it('lets any member of the org read a bound file, and no other org', async () => {
        const { meta } = await storeOf(ORG).upload(upload('shared'));
        await bindTo(meta.id, await craftJob({ sql, org: ORG, author: OWNER.id }));
        expect((await storeOf(ORG).meta(meta.id, STRANGER.id))?.state).toBe('bound');
        expect(await storeOf(OTHER_ORG).meta(meta.id, STRANGER.id)).toBeNull();
    });

    it('stops serving a bound file once its job row is gone, whatever deleted it', async () => {
        const { meta } = await storeOf(ORG).upload(upload('orphaned'));
        const jobId = await craftJob({ sql, org: ORG, author: OWNER.id });
        await bindTo(meta.id, jobId);
        expect(await storeOf(ORG).read(meta.id, STRANGER.id)).not.toBeNull();

        await sql`delete from job where org_id = ${ORG} and id = ${jobId}`;

        expect(await storeOf(ORG).meta(meta.id, STRANGER.id)).toBeNull();
        expect(await storeOf(ORG).read(meta.id, STRANGER.id)).toBeNull();
    });

    it('flips a draft to deleting, leaves the object to the sweep, and is idempotent', async () => {
        const { meta } = await storeOf(ORG).upload(upload('gone'));
        const { object_key: key } = await rowOf(meta.id);
        expect(await storeOf(ORG).remove(meta.id, STRANGER.id)).toBe('not-found');
        expect(await storeOf(OTHER_ORG).remove(meta.id, OWNER.id)).toBe('not-found');
        expect(await objects.head(key)).not.toBeNull();

        expect(await storeOf(ORG).remove(meta.id, OWNER.id)).toBe('deleted');
        const row = await rowOf(meta.id);
        expect(row.state).toBe('deleting');
        expect(row.deleting_at).not.toBeNull();
        expect(await objects.head(key)).not.toBeNull();
        expect(await storeOf(ORG).meta(meta.id, OWNER.id)).toBeNull();
        await sql`update input_attachment set deleting_at = now() - interval '1 day' where id = ${meta.id}`;
        await createAttachmentCollector({
            sql,
            ready: Promise.resolve(),
            objects,
            prefix: PREFIX,
            draftTtlHours: 24,
        }).collect();
        expect((await rowOf(meta.id)).state).toBe('deleted');
        expect(await objects.head(key)).toBeNull();

        expect(await storeOf(ORG).remove(meta.id, OWNER.id)).toBe('deleted');
        expect(await storeOf(ORG).meta(meta.id, OWNER.id)).toBeNull();
    });

    it('answers deleted for a draft that is already deleting', async () => {
        const { meta } = await storeOf(ORG).upload(upload('half'));
        await sql`update input_attachment set state = 'deleting', deleting_at = now()
            where org_id = ${ORG} and id = ${meta.id}`;
        expect(await storeOf(ORG).remove(meta.id, OWNER.id)).toBe('deleted');
        expect((await rowOf(meta.id)).state).toBe('deleting');
    });

    it('does not remove a bound file as a draft', async () => {
        const { meta } = await storeOf(ORG).upload(upload('kept'));
        await sql`update input_attachment set state = 'bound' where org_id = ${ORG} and id = ${meta.id}`;
        expect(await storeOf(ORG).remove(meta.id, OWNER.id)).toBe('not-found');
        expect((await rowOf(meta.id)).state).toBe('bound');
    });
});
