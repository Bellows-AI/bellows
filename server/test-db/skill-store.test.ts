import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import {
    createSkillStore,
    skillObjectKey,
    SkillGoneError,
    SkillIntegrityError,
    SkillUnavailableError,
    type SkillStore,
} from '../src/db/skill-store.js';
import { createSkillCollector } from '../src/skills/skill-collector.js';
import { bundleFromSkillMd } from '../src/skills/skill-bundle.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/** The skill store and its retention sweep (docs/skills.md) on a real database and a filesystem object store. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const ALICE = testUser('skill-alice');
const BOB = testUser('skill-bob');
const PREFIX = 'test/';
const RETENTION_DAYS = 30;

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ALICE, BOB] });
let sql: Sql;
let objects: ObjectStore;
let root: string;

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    root = await mkdtemp(join(tmpdir(), 'skill-store-'));
    objects = createFilesystemStore(root);
});

const storeOf = (orgId = ORG, over: Partial<ObjectStore> = {}): SkillStore =>
    createSkillStore({ sql, objects: { ...objects, ...over } as ObjectStore, orgId, prefix: PREFIX });

const md = (name: string, body = 'Do the thing.', description = `${name} helps`) =>
    bundleFromSkillMd(name, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);

const created = async (store: SkillStore, owner: string | null, name: string, body?: string) => {
    const r = await store.create(owner, { name, bundle: md(name, body), createdBy: ALICE.id });
    if (r.result !== 'created') throw new Error(`create ${name}: ${r.result}`);
    return r.skill;
};

const versionRows = async (skillId: string) =>
    sql<{ id: string; sha256: string; status: string; object_key: string }[]>`
        select id, sha256, status, object_key from skill_version where skill_id = ${skillId} order by created_at, id
    `;

const deletedAgo = (skillId: string, days: number) =>
    sql`update skill set deleted_at = now() - make_interval(days => ${days}) where id = ${skillId}`;

const collectorOf = (over: Partial<ObjectStore> = {}, referenced?: (ids: string[]) => Promise<Set<string>>) =>
    createSkillCollector({
        sql,
        objects: { ...objects, ...over } as ObjectStore,
        prefix: PREFIX,
        retentionDays: RETENTION_DAYS,
        pendingGraceMs: 0,
        ...(referenced ? { referenced } : {}),
    });

describe.skipIf(!enabled)('the skill store', () => {
    it('creates org and workspace skills; the same name is allowed across scopes, refused within one', async () => {
        const store = storeOf();
        const org = await created(store, null, 'deploy');
        const mine = await created(store, ALICE.id, 'deploy');
        expect(org.scope).toBe('org');
        expect(mine.scope).toBe('workspace');
        expect(org.current.description).toBe('deploy helps');

        expect(await store.create(null, { name: 'deploy', bundle: md('deploy'), createdBy: ALICE.id })).toEqual({
            result: 'name_taken',
        });
        expect(await store.create(ALICE.id, { name: 'deploy', bundle: md('deploy'), createdBy: ALICE.id })).toEqual({
            result: 'name_taken',
        });
        expect((await store.create(BOB.id, { name: 'deploy', bundle: md('deploy'), createdBy: BOB.id })).result).toBe(
            'created'
        );
    });

    it('refuses factory-* and malformed names at the store boundary', async () => {
        const store = storeOf();
        const bundle = md('ok-name');
        expect((await store.create(null, { name: 'factory-fix', bundle, createdBy: ALICE.id })).result).toBe(
            'reserved'
        );
        expect((await store.create(null, { name: 'Bad Name', bundle, createdBy: ALICE.id })).result).toBe(
            'invalid_name'
        );
        expect(await store.listOrg()).toEqual([]);
    });

    it('isolates owners: another member and another org match nothing, on every by-id operation', async () => {
        const store = storeOf();
        const alices = await created(store, ALICE.id, 'private');
        const orgs = await created(store, null, 'shared');
        const bobs = storeOf(); // same org: the owner argument is the door
        const foreign = storeOf(OTHER_ORG);

        expect(await bobs.get(BOB.id, alices.id)).toBeNull();
        expect(await bobs.addVersion(BOB.id, alices.id, md('private', 'x'))).toEqual({ result: 'missing' });
        expect(await bobs.setEnabled(BOB.id, alices.id, false)).toBe('missing');
        expect(await bobs.remove(BOB.id, alices.id)).toBe('missing');
        expect(await bobs.promote(BOB.id, alices.id)).toEqual({ result: 'missing' });
        // The org id reached through the workspace door, and a workspace id through the org door.
        expect(await bobs.setEnabled(BOB.id, orgs.id, false)).toBe('missing');
        expect(await bobs.setEnabled(null, alices.id, false)).toBe('missing');
        expect(await foreign.get(null, orgs.id)).toBeNull();
        expect(await foreign.setEnabled(null, orgs.id, false)).toBe('missing');
        expect(await foreign.remove(null, orgs.id)).toBe('missing');
        expect(await foreign.listOrg()).toEqual([]);
        expect(await bobs.listWorkspace(BOB.id)).toEqual([]);

        const after = await store.get(ALICE.id, alices.id);
        expect(after).toMatchObject({ enabled: true, current: { sha256: alices.current.sha256 } });
        expect(await store.get(null, orgs.id)).toMatchObject({ enabled: true });
    });

    it('keeps versions immutable: new content is a new row, equal content reuses one', async () => {
        const store = storeOf();
        const skill = await created(store, null, 'versioned', 'v1');
        const first = skill.current;

        const second = await store.addVersion(null, skill.id, md('versioned', 'v2'));
        expect(second.result).toBe('added');
        const rows = await versionRows(skill.id);
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.id === first.id)).toMatchObject({ sha256: first.sha256, status: 'ready' });
        expect((await store.get(null, skill.id))?.current.id).not.toBe(first.id);

        const again = await store.addVersion(null, skill.id, md('versioned', 'v2'));
        expect(again.result).toBe('exists');
        expect(await versionRows(skill.id)).toHaveLength(2);

        // Back to v1's content: the old version row is reused, not duplicated.
        const back = await store.addVersion(null, skill.id, md('versioned', 'v1'));
        expect(back.result).toBe('exists');
        expect((await store.get(null, skill.id))?.current.id).toBe(first.id);
        expect(await versionRows(skill.id)).toHaveLength(2);
    });

    it('converges after a crash between the pending row and the object write', async () => {
        const store = storeOf(ORG, {
            put: () => Promise.reject(new Error('node reclaimed')),
        });
        const bundle = md('crashy');
        await expect(store.create(null, { name: 'crashy', bundle, createdBy: ALICE.id })).rejects.toBeInstanceOf(
            SkillUnavailableError
        );
        // Not visible: no current version yet.
        expect(await store.listOrg()).toEqual([]);

        const retry = await storeOf().create(null, { name: 'crashy', bundle, createdBy: ALICE.id });
        expect(retry.result).toBe('created');
        const [count] = await sql<{ n: string }[]>`
            select count(*)::text as n from skill_version v join skill s on s.id = v.skill_id where s.name = 'crashy'
        `;
        expect(count?.n).toBe('1');
        expect(await storeOf().listOrg()).toHaveLength(1);
    });

    it('lists org skills for an org and workspace skills for their member, never deleted ones', async () => {
        const store = storeOf();
        await created(store, null, 'zeta');
        await created(store, null, 'alpha');
        const gone = await created(store, null, 'gone');
        await created(store, ALICE.id, 'mine');
        await store.remove(null, gone.id);

        expect((await store.listOrg()).map((s) => s.name)).toEqual(['alpha', 'zeta']);
        expect((await store.listWorkspace(ALICE.id)).map((s) => s.name)).toEqual(['mine']);
        expect(await store.get(null, gone.id)).toBeNull();
        // Soft delete frees the name.
        expect((await store.create(null, { name: 'gone', bundle: md('gone'), createdBy: ALICE.id })).result).toBe(
            'created'
        );
    });

    it('answers the enabled skills effective for a principal: org plus their workspace', async () => {
        const store = storeOf();
        const org = await created(store, null, 'org-on');
        const off = await created(store, null, 'org-off');
        await created(store, ALICE.id, 'alice-on');
        const aliceOff = await created(store, ALICE.id, 'alice-off');
        await created(store, BOB.id, 'bob-on');
        const deleted = await created(store, null, 'org-deleted');
        await store.setEnabled(null, off.id, false);
        await store.setEnabled(ALICE.id, aliceOff.id, false);
        await store.remove(null, deleted.id);

        const effective = await store.effective(ALICE.id);
        expect(effective.map((s) => `${s.source}:${s.name}`).sort()).toEqual(['org:org-on', 'workspace:alice-on']);
        expect(effective.find((s) => s.name === 'org-on')).toMatchObject({
            versionId: org.current.id,
            sha256: org.current.sha256,
            description: 'org-on helps',
            objectKey: skillObjectKey(PREFIX, ORG, org.current.sha256),
        });
        expect((await storeOf(OTHER_ORG).effective(ALICE.id)).length).toBe(0);
    });

    it('answers a caller with no member the organization skills alone', async () => {
        const store = storeOf();
        await created(store, null, 'org-only');
        await created(store, ALICE.id, 'alice-only');
        const effective = await store.effective(null);
        expect(effective.map((s) => `${s.source}:${s.name}`)).toEqual(['org:org-only']);
    });

    it('promotes a workspace skill to the org, and refuses an existing org name', async () => {
        const store = storeOf();
        const mine = await created(store, ALICE.id, 'promoted');
        const clash = await created(store, ALICE.id, 'clash');
        await created(store, null, 'clash');

        const r = await store.promote(ALICE.id, mine.id);
        expect(r).toMatchObject({ result: 'promoted', skill: { scope: 'org', id: mine.id } });
        expect(await store.get(ALICE.id, mine.id)).toBeNull();
        expect(await store.get(null, mine.id)).toMatchObject({ name: 'promoted' });

        expect(await store.promote(ALICE.id, clash.id)).toEqual({ result: 'name_taken' });
        expect(await store.get(ALICE.id, clash.id)).toMatchObject({ scope: 'workspace' });
    });

    it('reads a version verified against its sha256, and tells absent from unavailable', async () => {
        const store = storeOf();
        const skill = await created(store, ALICE.id, 'readable');
        const { id, sha256 } = skill.current;

        const read = await store.readVersion(id, { owner: ALICE.id });
        expect(read?.sha256).toBe(sha256);
        expect(Buffer.from(read!.body).equals(md('readable').tar)).toBe(true);
        expect(await store.readVersion(id, { owner: BOB.id })).toBeNull();
        expect(await store.readVersion(id, 'any')).not.toBeNull();
        expect(await storeOf(OTHER_ORG).readVersion(id, 'any')).toBeNull();

        await expect(
            storeOf(ORG, { get: () => Promise.reject(new Error('503')) }).readVersion(id, 'any')
        ).rejects.toBeInstanceOf(SkillUnavailableError);
        await expect(storeOf(ORG, { get: () => Promise.resolve(null) }).readVersion(id, 'any')).rejects.toBeInstanceOf(
            SkillGoneError
        );
        await writeFile(join(root, skillObjectKey(PREFIX, ORG, sha256)), 'tampered');
        await expect(store.readVersion(id, 'any')).rejects.toBeInstanceOf(SkillIntegrityError);
    });
});

describe.skipIf(!enabled)('the skill retention sweep', () => {
    const objectOf = (key: string) => objects.get(key);

    it('keeps a deleted skill inside the retention window and a live skill always', async () => {
        const store = storeOf();
        const live = await created(store, null, 'keep-live');
        await store.addVersion(null, live.id, md('keep-live', 'v2'));
        const recent = await created(store, null, 'keep-recent');
        await store.remove(null, recent.id);
        await deletedAgo(recent.id, RETENTION_DAYS - 1);

        const summary = await collectorOf().collect();
        expect(summary.versions).toBe(0);
        expect(await versionRows(live.id)).toHaveLength(2);
        expect(await versionRows(recent.id)).toHaveLength(1);
        expect(await objectOf(recent.current.objectKey)).not.toBeNull();
    });

    it('sweeps a skill deleted past the window: versions, objects and the skill row', async () => {
        const store = storeOf();
        const skill = await created(store, null, 'sweep-me', 'a');
        const second = await store.addVersion(null, skill.id, md('sweep-me', 'b'));
        const keys = (await versionRows(skill.id)).map((r) => r.object_key);
        await store.remove(null, skill.id);
        await deletedAgo(skill.id, RETENTION_DAYS + 1);

        const summary = await collectorOf().collect();
        expect(second.result).toBe('added');
        expect(summary).toMatchObject({ versions: 2, objects: 2, skills: 1, failed: 0 });
        for (const key of keys) expect(await objectOf(key)).toBeNull();
        expect(await sql`select 1 from skill where id = ${skill.id}`).toHaveLength(0);
    });

    it('keeps a shared object until the last row naming it is swept', async () => {
        const store = storeOf();
        const a = await created(store, null, 'twin-a', 'same body');
        const b = await created(store, ALICE.id, 'twin-b', 'same body');
        // The same bundle under two skills of one org names one object.
        const shared = md('twin-a', 'same body');
        await store.addVersion(ALICE.id, b.id, shared);
        const key = skillObjectKey(PREFIX, ORG, shared.sha256);
        expect((await versionRows(a.id)).map((r) => r.object_key)).toContain(key);
        expect((await versionRows(b.id)).map((r) => r.object_key)).toContain(key);

        await store.remove(null, a.id);
        await deletedAgo(a.id, RETENTION_DAYS + 1);
        await collectorOf().collect();
        expect(await objectOf(key)).not.toBeNull(); // b still names it

        await store.remove(ALICE.id, b.id);
        await deletedAgo(b.id, RETENTION_DAYS + 1);
        await collectorOf().collect();
        expect(await objectOf(key)).toBeNull();
    });

    it('never sweeps a version a job references, and sweeps it once the reference is gone', async () => {
        const store = storeOf();
        const skill = await created(store, null, 'pinned');
        await store.remove(null, skill.id);
        await deletedAgo(skill.id, RETENTION_DAYS + 1);
        const held = new Set([skill.current.id]);

        const kept = await collectorOf({}, async () => held).collect();
        expect(kept.versions).toBe(0);
        expect(await objectOf(skill.current.objectKey)).not.toBeNull();

        held.clear();
        expect((await collectorOf({}, async () => held).collect()).versions).toBe(1);
        expect(await objectOf(skill.current.objectKey)).toBeNull();
    });

    it('deletes nothing when the reference check cannot be confirmed', async () => {
        const store = storeOf();
        const skill = await created(store, null, 'unconfirmed');
        await store.remove(null, skill.id);
        await deletedAgo(skill.id, RETENTION_DAYS + 1);

        const failing = collectorOf({}, () => Promise.reject(new Error('timeout')));
        await expect(failing.collect()).rejects.toThrow('timeout');
        expect(await versionRows(skill.id)).toHaveLength(1);
        expect(await objectOf(skill.current.objectKey)).not.toBeNull();
    });

    it('leaves the row when the object delete is unconfirmed, and retries next pass', async () => {
        const store = storeOf();
        const skill = await created(store, null, 'flaky-delete');
        await store.remove(null, skill.id);
        await deletedAgo(skill.id, RETENTION_DAYS + 1);

        const failed = await collectorOf({ delete: () => Promise.reject(new Error('503')) }).collect();
        expect(failed).toMatchObject({ versions: 0, failed: 1 });
        expect(await versionRows(skill.id)).toHaveLength(1);

        expect((await collectorOf().collect()).versions).toBe(1);
        expect(await objectOf(skill.current.objectKey)).toBeNull();
    });

    it('sweeps an abandoned pending version after its grace and keeps a fresh one', async () => {
        const store = storeOf();
        const skill = await created(store, null, 'abandoned');
        const bundle = md('abandoned', 'next');
        await expect(
            storeOf(ORG, { put: () => Promise.reject(new Error('lost')) }).addVersion(null, skill.id, bundle)
        ).rejects.toBeInstanceOf(SkillUnavailableError);
        expect((await versionRows(skill.id)).filter((r) => r.status === 'pending')).toHaveLength(1);

        const fresh = createSkillCollector({
            sql,
            objects,
            prefix: PREFIX,
            retentionDays: RETENTION_DAYS,
            pendingGraceMs: 3_600_000,
        });
        expect((await fresh.collect()).versions).toBe(0);

        expect((await collectorOf().collect()).versions).toBe(1);
        const rows = await versionRows(skill.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe(skill.current.id);
        expect(await objectOf(skill.current.objectKey)).not.toBeNull();
    });

    it('never touches a key outside the skill namespace', async () => {
        const store = storeOf();
        const skill = await created(store, null, 'foreign-key');
        await sql`update skill_version set object_key = ${'test/_attachments/x/y'} where skill_id = ${skill.id}`;
        await objects.put('test/_attachments/x/y', new TextEncoder().encode('b'));
        await store.remove(null, skill.id);
        await deletedAgo(skill.id, RETENTION_DAYS + 1);

        const summary = await collectorOf().collect();
        expect(summary.failed).toBe(1);
        expect(await objectOf('test/_attachments/x/y')).not.toBeNull();
    });
});
