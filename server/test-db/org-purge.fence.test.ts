import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { createArtifactStore } from '../src/artifacts/artifact-store.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { createAttachmentRows } from '../src/attachments/attachment-rows.js';
import { UPLOAD_WRITE_BOUND_MS, attachmentKey } from '../src/attachments/attachment-store.js';
import { createAuthStore } from '../src/auth/store.js';
import {
    OBJECT_WRITE_BOUND_MS,
    OBJECT_WRITE_DRAIN_MS,
    OrgPurgingError,
    fencedPut,
} from '../src/db/object-write-fence.js';
import { type OrgPurgeDeps, orgObjectPrefixes, runOrgPurgePass } from '../src/db/org-purge.js';
import { createSkillStore } from '../src/db/skill-store.js';
import { bundleFromSkillMd } from '../src/skills/skill-bundle.js';
import { testSecretStore } from './env-secrets-harness.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The fence between an org's object writers and its purge (`object-write-fence.ts`): once a purge is requested every
 * writer — artifact chunks, attachment uploads, skill bundles — is refused, and the purge lists the org's prefixes only
 * after every write that passed the fence earlier has drained, so a write in flight can never land after the list
 * that confirmed the prefix empty.
 */
const org = testOrg();
const user = testUser('org-purge-fence');
const db = useTestDb({ orgs: [org], users: [user] });
const enabled = Boolean(db.url);

const PREFIX = 'factory/';
const DRAIN_MS = 60_000;
const bytes = (text: string) => new TextEncoder().encode(text);
const streamRef = () => ({
    member: 'member-1',
    root: randomUUID(),
    job: randomUUID(),
    claimSeq: 1,
    executor: 'claude-code',
    session: randomUUID(),
    stream: 'raw',
});

let objects: ObjectStore;

beforeEach(async () => {
    if (!enabled) return;
    objects = createFilesystemStore(await mkdtemp(join(tmpdir(), 'factory-fence-')));
});

const deps = (over: Partial<OrgPurgeDeps> = {}): OrgPurgeDeps => ({
    sql: db.sql,
    secrets: testSecretStore(db.sql),
    objects,
    prefix: PREFIX,
    deploymentMode: 'cloud',
    log: () => {},
    writeDrainMs: DRAIN_MS,
    ...over,
});

async function requestPurge(): Promise<void> {
    await db.sql`update organization set status = 'suspended', operator_status = 'suspended' where id = ${org}`;
    expect((await createAuthStore({ sql: db.sql }).requestOrgDelete(org, user.id)).outcome).toBe('requested');
}

/** The request as if it were made `ms` ago: the drain counts from it on the database clock. */
const age = (ms: number) =>
    db.sql`update org_purge set requested_at = now() - make_interval(secs => ${ms / 1000}) where org_id = ${org}`;

async function keysLeft(): Promise<string[]> {
    const found: string[] = [];
    for (const prefix of orgObjectPrefixes(PREFIX, org)) found.push(...(await objects.list(prefix)));
    return found;
}

const purgeRow = async () =>
    (
        await db.sql<{ step: string; last_error: string | null }[]>`
        select step, last_error from org_purge where org_id = ${org}
    `
    )[0];

/**
 * The pool with its fence read held back: the writer gets as far as the fence, waits there while the test purges the
 * whole org, and only then reads it — the schedule of a writer paused between its earlier steps and its put.
 */
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

/** Purges the org to the end: requested, drained, every step run, the org row gone. */
async function purgeCompletely(): Promise<void> {
    await requestPurge();
    await age(DRAIN_MS);
    await runOrgPurgePass(deps());
    expect(await db.sql`select 1 from organization where id = ${org}`).toHaveLength(0);
}

describe.skipIf(!enabled)('object writes against an org purge', () => {
    it('refuses an artifact upload that resumes after the purge completed, and writes no object', async () => {
        const paused = pausedAtFence();
        const artifacts = createArtifactStore({
            sql: paused.sql,
            orgId: org,
            ready: Promise.resolve(),
            objects,
            prefix: PREFIX,
        });
        const write = artifacts.putChunk(streamRef(), 0, bytes('late'));
        const settled = write.catch((e: unknown) => e);
        await paused.arrived;

        await purgeCompletely();
        paused.release();

        expect(await settled).toBeInstanceOf(OrgPurgingError);
        expect(await keysLeft()).toEqual([]);
    });

    it('refuses a skill bundle that resumes after the purge completed, and writes no object', async () => {
        const paused = pausedAtFence();
        const skills = createSkillStore({ sql: paused.sql, objects, orgId: org, prefix: PREFIX });
        const bundle = bundleFromSkillMd('deploy', '---\nname: deploy\ndescription: deploy helps\n---\nDo it.\n');
        const write = skills.create(null, { name: 'deploy', bundle, createdBy: user.id });
        const settled = write.then(
            () => null,
            (e: unknown) => e
        );
        await paused.arrived;

        await purgeCompletely();
        paused.release();

        expect(await settled).toBeInstanceOf(Error);
        expect(await keysLeft()).toEqual([]);
    });

    it('refuses an attachment attempt and a fenced put for an org that no longer exists', async () => {
        await purgeCompletely();
        await expect(
            fencedPut({ sql: db.sql, orgId: org, objects }, `${PREFIX}${org}/x`, bytes('x'))
        ).rejects.toBeInstanceOf(OrgPurgingError);
        const rows = createAttachmentRows({ sql: db.sql, orgId: org, ready: Promise.resolve() });
        expect(await rows.beginAttempt(randomUUID())).toBeNull();
        expect(await keysLeft()).toEqual([]);
    });

    it('refuses every writer once the purge is requested', async () => {
        await requestPurge();

        await expect(
            fencedPut({ sql: db.sql, orgId: org, objects }, `${PREFIX}${org}/x`, bytes('x'))
        ).rejects.toBeInstanceOf(OrgPurgingError);
        const artifacts = createArtifactStore({
            sql: db.sql,
            orgId: org,
            ready: Promise.resolve(),
            objects,
            prefix: PREFIX,
        });
        await expect(artifacts.putChunk(streamRef(), 0, bytes('log'))).rejects.toBeInstanceOf(OrgPurgingError);

        const skills = createSkillStore({ sql: db.sql, objects, orgId: org, prefix: PREFIX });
        const bundle = bundleFromSkillMd('deploy', '---\nname: deploy\ndescription: deploy helps\n---\nDo it.\n');
        await expect(skills.create(null, { name: 'deploy', bundle, createdBy: user.id })).rejects.toThrow();

        const rows = createAttachmentRows({ sql: db.sql, orgId: org, ready: Promise.resolve() });
        const id = randomUUID();
        await rows.insertPending({
            id,
            uploaderId: user.id,
            name: 'a.txt',
            mediaType: 'text/plain',
            sizeBytes: 1,
            sha256: 'a'.repeat(64),
            objectKey: attachmentKey(PREFIX, org, id),
        });
        expect(await rows.beginAttempt(id)).toBeNull();

        expect(await keysLeft()).toEqual([]);
    });

    it('lists nothing until the writes that passed the fence have drained, so a delayed PUT is purged too', async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered!: () => void;
        const inFlight = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const slow: ObjectStore = {
            ...objects,
            put: async (key, body, options) => {
                entered();
                await held;
                return objects.put(key, body, options);
            },
        };
        const artifacts = createArtifactStore({
            sql: db.sql,
            orgId: org,
            ready: Promise.resolve(),
            objects: slow,
            prefix: PREFIX,
        });
        const write = artifacts.putChunk(streamRef(), 0, bytes('late'));
        await inFlight;
        await requestPurge();

        await runOrgPurgePass(deps());
        expect(await purgeRow()).toEqual({ step: 'objects', last_error: 'writes-draining' });

        release();
        expect((await write).result).toBe('stored');
        expect(await keysLeft()).toHaveLength(1);

        await age(DRAIN_MS);
        await runOrgPurgePass(deps());

        expect(await db.sql`select 1 from organization where id = ${org}`).toHaveLength(0);
        expect(await keysLeft()).toEqual([]);
    });

    it('drains for longer than the bound every writer runs under, the attachment upload included', () => {
        expect(UPLOAD_WRITE_BOUND_MS).toBe(OBJECT_WRITE_BOUND_MS);
        expect(OBJECT_WRITE_DRAIN_MS).toBeGreaterThan(OBJECT_WRITE_BOUND_MS);
    });
});
