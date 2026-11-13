import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { isReservedSkillName, type SkillRequirements, SKILL_NAME, SKILL_NAME_LIMIT } from '@factory-ai/core';
import type { ObjectStore } from '../artifacts/object-store.js';
import type { SkillBundle } from '../skills/skill-bundle.js';
import { fencedPut } from './object-write-fence.js';

/**
 * The org and workspace skill store (docs/skills.md). A skill row is owned by an organization (`owner` null) or by one
 * member's workspace (`owner` = their user id), like `user-executor-store.ts`; every by-id operation names its owner in
 * the WHERE, so another member's id, an org id reached through the workspace door and another organization's id all
 * match nothing and answer `missing`. Content is a chain of immutable `skill_version` rows over create-only objects:
 * the object is stored first (content-addressed, create-only, outside any transaction), then ONE transaction on one
 * connection inserts the skill and/or version row and swaps `current_version_id`, so a row always has its whole object
 * and a failed or racing write leaves at most an unreferenced object (a stated limit, docs/skills.md). Races are decided
 * by the unique live-name index and `select … for update` on the skill row; there is no lock held across IO or a pool.
 */

/** The owner of a skill: null is the organization scope, a user id is that member's workspace. */
export type SkillOwner = string | null;

export type SkillScope = 'org' | 'workspace';

/** The object store (or its answer) could not be confirmed; no row was marked ready or deleted on it. */
export class SkillUnavailableError extends Error {
    constructor(what: string, cause?: unknown) {
        super(`skill storage unavailable: ${what}`, { cause });
        this.name = 'SkillUnavailableError';
    }
}

/** The object at a version's key is not the body the row recorded. */
export class SkillIntegrityError extends Error {
    constructor(what: string) {
        super(`skill integrity: ${what}`);
        this.name = 'SkillIntegrityError';
    }
}

/** A `ready` version whose object the store definitively does not hold. */
export class SkillGoneError extends Error {
    constructor() {
        super('skill gone: the stored object is absent');
        this.name = 'SkillGoneError';
    }
}

/** `<prefix>_skills/<org>/<sha256>`: the leading `_` fails the artifact key rule, so no artifact key collides. */
export const skillObjectKey = (prefix: string, orgId: string, sha256: string): string =>
    `${prefix}_skills/${orgId}/${sha256}`;

/** The namespace a sweep may delete under; a row's key outside it is data, never touched. */
export const skillKeyNamespace = (prefix: string): string => `${prefix}_skills/`;

/** A string key for `pg_advisory_xact_lock`: writers and the sweep serialize on one object key. */
export const lockObjectKey = (tx: Sql | TransactionSql, key: string) =>
    tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

export interface SkillVersionInfo {
    id: string;
    sha256: string;
    size: number;
    description: string;
    objectKey: string;
    createdAt: string;
    /** Who wrote the version; null for one written before the column existed, or once the user is deleted. */
    author: { id: string; login: string } | null;
}

export interface SkillRecord {
    id: string;
    name: string;
    scope: SkillScope;
    /** The workspace's member; null for an org skill. */
    userId: string | null;
    enabled: boolean;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
    current: SkillVersionInfo;
}

/** An enabled, live skill as a principal's catalog sees it. */
export interface EffectiveSkill {
    id: string;
    name: string;
    source: SkillScope;
    description: string;
    /** The tools and connections the current version declares (none for one stored before they were read). */
    requires: SkillRequirements;
    versionId: string;
    sha256: string;
    objectKey: string;
}

export interface SkillInput {
    name: string;
    bundle: SkillBundle;
    createdBy: string | null;
}

export type CreateResult =
    | { result: 'created'; skill: SkillRecord }
    | { result: 'name_taken' | 'reserved' | 'invalid_name' };
export type AddVersionResult =
    | { result: 'added' | 'exists'; skill: SkillRecord }
    | { result: 'missing' }
    | { result: 'stale' };

/** `expectedVersionId`: the write is refused as `stale` unless it is still the skill's current version. */
/** A skill row under this transaction's lock: the version it points at right now. */
interface LockedSkill {
    currentVersionId: string | null;
}

export interface AddVersionOptions {
    expectedVersionId?: string;
    /** The writer, recorded on a new version; an identical re-upload keeps its first author. */
    createdBy?: string | null;
}
export type PromoteResult = { result: 'promoted'; skill: SkillRecord } | { result: 'name_taken' | 'missing' };

/** `any` is the worker/pin path: whatever skill of this org owns the version. */
export type VersionAccess = { owner: SkillOwner } | 'any';

export interface SkillStore {
    create(owner: SkillOwner, input: SkillInput): Promise<CreateResult>;
    addVersion(
        owner: SkillOwner,
        id: string,
        bundle: SkillBundle,
        options?: AddVersionOptions
    ): Promise<AddVersionResult>;
    setEnabled(owner: SkillOwner, id: string, enabled: boolean): Promise<'ok' | 'missing'>;
    /** Soft delete: the row keeps its versions until the sweep's retention rule allows removing them. */
    remove(owner: SkillOwner, id: string): Promise<'deleted' | 'missing'>;
    /** Workspace → org; refused when an org skill already has the name. */
    promote(userId: string, id: string): Promise<PromoteResult>;
    listOrg(): Promise<SkillRecord[]>;
    listWorkspace(userId: string): Promise<SkillRecord[]>;
    get(owner: SkillOwner, id: string): Promise<SkillRecord | null>;
    /** Org skills plus the member's workspace skills; a caller with no member sees the org's alone. */
    effective(userId: string | null): Promise<EffectiveSkill[]>;
    /** The built-in skill names this org switched off; a read that fails rejects, never answers none. */
    switchedOff(): Promise<string[]>;
    /** Switches a built-in on or off for the org; idempotent. `by` is the admin's member id. */
    setBuiltinEnabled(name: string, enabled: boolean, by: string | null): Promise<void>;
    /**
     * A version's tar bytes verified against its sha256. Null when no such ready version is visible to `access`;
     * `SkillGoneError` when the store answers that the object is absent; an unconfirmed read throws
     * `SkillUnavailableError`.
     */
    readVersion(versionId: string, access: VersionAccess): Promise<{ sha256: string; body: Uint8Array } | null>;
}

interface RecordRow {
    id: string;
    name: string;
    user_id: string | null;
    enabled: boolean;
    created_by: string | null;
    created_at: string;
    updated_at: string;
    v_id: string;
    v_sha256: string;
    v_size: string | number;
    v_description: string;
    v_requires_tools: string[];
    v_requires_connections: string[];
    v_object_key: string;
    v_created_at: string;
    v_author_id: string | null;
    v_author_login: string | null;
}

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (error: unknown): boolean => (error as { code?: string }).code === UNIQUE_VIOLATION;
const NAME_PATTERN_OK = (name: string): boolean => name.length <= SKILL_NAME_LIMIT && SKILL_NAME.test(name);

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const recordOf = (row: RecordRow): SkillRecord => ({
    id: row.id,
    name: row.name,
    scope: row.user_id === null ? 'org' : 'workspace',
    userId: row.user_id,
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    current: {
        id: row.v_id,
        sha256: row.v_sha256,
        size: Number(row.v_size),
        description: row.v_description,
        objectKey: row.v_object_key,
        createdAt: String(row.v_created_at),
        author: row.v_author_id === null ? null : { id: row.v_author_id, login: row.v_author_login ?? '' },
    },
});

const effectiveOf = (row: RecordRow): EffectiveSkill => ({
    id: row.id,
    name: row.name,
    source: row.user_id === null ? 'org' : 'workspace',
    description: row.v_description,
    requires: { tools: row.v_requires_tools, connections: row.v_requires_connections },
    versionId: row.v_id,
    sha256: row.v_sha256,
    objectKey: row.v_object_key,
});

/** An object-store call whose failure is an unconfirmed answer, never a verdict about the object. */
async function confirmed<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        throw new SkillUnavailableError(what, error);
    }
}

export function createSkillStore({
    sql,
    objects,
    orgId,
    prefix,
}: {
    sql: Sql;
    objects: ObjectStore;
    orgId: string;
    /** Normalized: empty or one trailing slash (`ArtifactBackend.prefix`). */
    prefix: string;
}): SkillStore {
    const ownerIs = (owner: SkillOwner) => sql`s.user_id is not distinct from ${owner}`;

    /** Live skills with a ready current version: one owner's (optionally one id), or the enabled ones a member sees. */
    const select = (filter: { owner: SkillOwner; id?: string } | { effectiveFor: string | null }) => sql<RecordRow[]>`
        select s.id, s.name, s.user_id, s.enabled, s.created_by, s.created_at::text, s.updated_at::text,
               v.id as v_id, v.sha256 as v_sha256, v.size_bytes as v_size, v.description as v_description,
               v.requires_tools as v_requires_tools, v.requires_connections as v_requires_connections,
               v.object_key as v_object_key, v.created_at::text as v_created_at,
               au.id as v_author_id, au.github_login as v_author_login
        from skill s join skill_version v on v.id = s.current_version_id
        left join app_user au on au.id = v.created_by
        where s.org_id = ${orgId} and s.deleted_at is null
          and ${
              'effectiveFor' in filter
                  ? sql`s.enabled and (s.user_id is null or s.user_id = ${filter.effectiveFor}::uuid)`
                  : sql`${ownerIs(filter.owner)} and (${filter.id ?? null}::uuid is null or s.id = ${filter.id ?? null})`
}
        order by s.name, s.id
    `;

    async function getOwned(owner: SkillOwner, id: string): Promise<SkillRecord | null> {
        const [row] = await select({ owner, id });
        return row ? recordOf(row) : null;
    }

    /** Verifies the key's existing object is the version's bytes (a create-only put found it taken). */
    async function verifyHeld(key: string, sha256: string): Promise<void> {
        const held = await confirmed('get', () => objects.get(key));
        if (held === null) throw new SkillUnavailableError('the stored object could not be read back');
        if (sha256Of(held) !== sha256)
            throw new SkillIntegrityError('the stored body differs from the recorded sha256');
    }

    /** Stores the bundle's object first, outside any transaction: content-addressed and create-only, so a race is harmless. */
    async function storeObject(bundle: SkillBundle): Promise<string> {
        const key = skillObjectKey(prefix, orgId, bundle.sha256);
        const put = await confirmed('put', () => fencedPut({ sql, orgId, objects }, key, bundle.tar));
        if (put === 'exists') await verifyHeld(key, bundle.sha256);
        return key;
    }

    /**
     * Inside the write's transaction: serialize with the sweep on the object's key, and re-put the object if the sweep
     * removed it between the upload and now (the lock then keeps it). A tx lock dies with its connection.
     */
    async function holdObject(tx: TransactionSql, key: string, bundle: SkillBundle): Promise<void> {
        await lockObjectKey(tx, key);
        const there = await confirmed('head', () => objects.head(key));
        if (there === null) await confirmed('put', () => fencedPut({ sql: tx, orgId, objects }, key, bundle.tar));
    }

    /** Inserts the version (or finds the row for the same content) and makes it current. `exists` when it was known. */
    async function publishVersion(
        tx: TransactionSql,
        skillId: string,
        { key, bundle, createdBy }: { key: string; bundle: SkillBundle; createdBy: string | null }
    ): Promise<'added' | 'exists'> {
        await holdObject(tx, key, bundle);
        const [version] = await tx<{ id: string; inserted: boolean }[]>`
            insert into skill_version (skill_id, sha256, size_bytes, object_key, description, requires_tools, requires_connections, created_by)
            values (${skillId}, ${bundle.sha256}, ${bundle.size}, ${key}, ${bundle.description},
                    ${bundle.requires.tools}, ${bundle.requires.connections}, ${createdBy})
            on conflict (skill_id, sha256) do update set
                requires_tools = excluded.requires_tools, requires_connections = excluded.requires_connections
            returning id, (xmax = 0) as inserted
        `;
        await tx`update skill set current_version_id = ${version!.id}, updated_at = now() where id = ${skillId}`;
        return version!.inserted ? 'added' : 'exists';
    }

    /** The skill row, locked for this transaction; null when it is missing, foreign, or deleted. */
    const lockSkill = async (tx: TransactionSql, owner: SkillOwner, id: string): Promise<LockedSkill | null> => {
        const rows = await tx<{ current_version_id: string | null }[]>`
            select current_version_id from skill
            where id = ${id} and org_id = ${orgId} and deleted_at is null and user_id is not distinct from ${owner}
            for update
        `;
        return rows[0] ? { currentVersionId: rows[0].current_version_id } : null;
    };

    return {
        async create(owner, { name, bundle, createdBy }) {
            if (isReservedSkillName(name)) return { result: 'reserved' };
            if (!NAME_PATTERN_OK(name)) return { result: 'invalid_name' };
            const key = await storeObject(bundle);
            let id: string;
            try {
                // One transaction: the unique live-name index decides a race, and a loser leaves nothing behind.
                id = await sql.begin(async (tx) => {
                    const [row] = await tx<{ id: string }[]>`
                        insert into skill (org_id, user_id, name, created_by)
                        values (${orgId}, ${owner}, ${name}, ${createdBy}) returning id
                    `;
                    await publishVersion(tx, row!.id, { key, bundle, createdBy });
                    return row!.id;
                });
            } catch (error) {
                if (isUniqueViolation(error)) return { result: 'name_taken' };
                throw error;
            }
            const skill = await getOwned(owner, id);
            return skill ? { result: 'created', skill } : { result: 'name_taken' };
        },

        async addVersion(owner, id, bundle, options) {
            const key = await storeObject(bundle);
            const written = await sql.begin(async (tx) => {
                const locked = await lockSkill(tx, owner, id);
                if (!locked) return 'missing' as const;
                const expected = options?.expectedVersionId;
                if (expected !== undefined && locked.currentVersionId !== expected) return 'stale' as const;
                return publishVersion(tx, id, { key, bundle, createdBy: options?.createdBy ?? null });
            });
            if (written === 'missing' || written === 'stale') return { result: written };
            const skill = await getOwned(owner, id);
            return skill ? { result: written, skill } : { result: 'missing' };
        },

        async setEnabled(owner, id, enabled) {
            // One statement takes the row lock, so it waits for a version write and re-checks deleted_at after it.
            const rows = await sql`
                update skill set enabled = ${enabled}, updated_at = now()
                where id = ${id} and org_id = ${orgId} and deleted_at is null and user_id is not distinct from ${owner}
                returning id
            `;
            return rows.length > 0 ? 'ok' : 'missing';
        },

        async remove(owner, id) {
            const rows = await sql`
                update skill set deleted_at = now(), updated_at = now()
                where id = ${id} and org_id = ${orgId} and deleted_at is null and user_id is not distinct from ${owner}
                returning id
            `;
            return rows.length > 0 ? 'deleted' : 'missing';
        },

        async promote(userId, id) {
            try {
                // The unique live-name index decides a clash with an org skill, atomically with the owner change.
                const rows = await sql`
                    update skill set user_id = null, updated_at = now()
                    where id = ${id} and org_id = ${orgId} and deleted_at is null and user_id = ${userId}
                      and current_version_id is not null
                    returning id
                `;
                if (rows.length === 0) return { result: 'missing' };
            } catch (error) {
                if (isUniqueViolation(error)) return { result: 'name_taken' };
                throw error;
            }
            const skill = await getOwned(null, id);
            return skill ? { result: 'promoted', skill } : { result: 'missing' };
        },

        async listOrg() {
            return (await select({ owner: null })).map(recordOf);
        },

        async listWorkspace(userId) {
            return (await select({ owner: userId })).map(recordOf);
        },

        get: getOwned,

        async effective(userId) {
            const rows = await select({ effectiveFor: userId });
            return rows.map(effectiveOf);
        },

        async switchedOff() {
            const rows = await sql<{ name: string }[]>`select name from builtin_skill_off where org_id = ${orgId}`;
            return rows.map((row) => row.name);
        },

        async setBuiltinEnabled(name, enabled, by) {
            if (enabled) {
                await sql`delete from builtin_skill_off where org_id = ${orgId} and name = ${name}`;
                return;
            }
            await sql`
                insert into builtin_skill_off (org_id, name, switched_by) values (${orgId}, ${name}, ${by})
                on conflict (org_id, name) do nothing
            `;
        },

        async readVersion(versionId, access) {
            // Soft-deleted skills stay readable: a pin names a version, not a live skill.
            const [row] = await sql<{ sha256: string; object_key: string }[]>`
                select v.sha256, v.object_key
                from skill_version v join skill s on s.id = v.skill_id
                where v.id = ${versionId} and s.org_id = ${orgId}
                  and ${access === 'any' ? sql`true` : sql`s.user_id is not distinct from ${access.owner}`}
            `;
            if (!row) return null;
            const body = await confirmed('get', () => objects.get(row.object_key));
            if (body === null) throw new SkillGoneError();
            if (sha256Of(body) !== row.sha256)
                throw new SkillIntegrityError('the stored body differs from the recorded sha256');
            return { sha256: row.sha256, body };
        },
    };
}
