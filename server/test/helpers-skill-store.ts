import { randomUUID } from 'node:crypto';
import { isReservedSkillName, SKILL_NAME, SKILL_NAME_LIMIT } from '@factory-ai/core';
import {
    SkillGoneError,
    type SkillOwner,
    type SkillRecord,
    type SkillStore,
    type SkillVersionInfo,
} from '../src/db/skill-store.js';
import type { SkillBundle } from '../src/skills/skill-bundle.js';

export interface MemorySkillStore extends SkillStore {
    /** Makes a version's object absent, as a lost object store key would. */
    loseObjects(): void;
    /** Makes every call reject, as an unreachable database would. */
    breakAll(): void;
}

interface Row {
    id: string;
    name: string;
    userId: string | null;
    enabled: boolean;
    createdBy: string | null;
    deleted: boolean;
    versions: SkillVersionInfo[];
    current: string;
}

/** An in-memory SkillStore for route tests: the owner rules of the SQL store, one organization, no object store. */
export function memorySkillStore(): MemorySkillStore {
    const rows = new Map<string, Row>();
    const bodies = new Map<string, Uint8Array>();
    const off = new Set<string>();
    const requirements = new Map<string, SkillBundle['requires']>();
    let lost = false;
    let broken = false;
    const check = () => {
        if (broken) throw new Error('database is down');
    };
    const recordOf = (row: Row): SkillRecord => ({
        id: row.id,
        name: row.name,
        scope: row.userId === null ? 'org' : 'workspace',
        userId: row.userId,
        enabled: row.enabled,
        createdBy: row.createdBy,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        current: row.versions.find((v) => v.id === row.current)!,
    });
    const owned = (owner: SkillOwner, id: string): Row | undefined => {
        const row = rows.get(id);
        return row && !row.deleted && row.userId === owner ? row : undefined;
    };
    const versionOf = (bundle: SkillBundle): SkillVersionInfo => {
        const id = randomUUID();
        bodies.set(id, bundle.tar);
        requirements.set(id, bundle.requires);
        return {
            id,
            sha256: bundle.sha256,
            size: bundle.size,
            description: bundle.description,
            objectKey: `_skills/org/${bundle.sha256}`,
            createdAt: '2026-01-01T00:00:00Z',
        };
    };
    const live = (owner: SkillOwner) => [...rows.values()].filter((row) => !row.deleted && row.userId === owner);

    return {
        loseObjects: () => {
            lost = true;
        },
        breakAll: () => {
            broken = true;
        },
        async create(owner, { name, bundle, createdBy }) {
            check();
            if (isReservedSkillName(name)) return { result: 'reserved' };
            if (name.length > SKILL_NAME_LIMIT || !SKILL_NAME.test(name)) return { result: 'invalid_name' };
            if (live(owner).some((row) => row.name === name)) return { result: 'name_taken' };
            const version = versionOf(bundle);
            const row: Row = {
                id: randomUUID(),
                name,
                userId: owner,
                enabled: true,
                createdBy,
                deleted: false,
                versions: [version],
                current: version.id,
            };
            rows.set(row.id, row);
            return { result: 'created', skill: recordOf(row) };
        },
        async addVersion(owner, id, bundle) {
            check();
            const row = owned(owner, id);
            if (!row) return { result: 'missing' };
            const same = row.versions.find((v) => v.sha256 === bundle.sha256);
            if (same) {
                requirements.set(same.id, bundle.requires);
                row.current = same.id;
                return { result: 'exists', skill: recordOf(row) };
            }
            const version = versionOf(bundle);
            row.versions.push(version);
            row.current = version.id;
            return { result: 'added', skill: recordOf(row) };
        },
        async setEnabled(owner, id, enabled) {
            check();
            const row = owned(owner, id);
            if (!row) return 'missing';
            row.enabled = enabled;
            return 'ok';
        },
        async remove(owner, id) {
            check();
            const row = owned(owner, id);
            if (!row) return 'missing';
            row.deleted = true;
            return 'deleted';
        },
        async promote(userId, id) {
            check();
            const row = owned(userId, id);
            if (!row) return { result: 'missing' };
            if (live(null).some((other) => other.name === row.name)) return { result: 'name_taken' };
            row.userId = null;
            return { result: 'promoted', skill: recordOf(row) };
        },
        async listOrg() {
            check();
            return live(null).map(recordOf);
        },
        async listWorkspace(userId) {
            check();
            return live(userId).map(recordOf);
        },
        async get(owner, id) {
            check();
            const row = owned(owner, id);
            return row ? recordOf(row) : null;
        },
        async effective(userId) {
            check();
            return [...rows.values()]
                .filter((row) => !row.deleted && row.enabled && (row.userId === null || row.userId === userId))
                .map((row) => {
                    const version = recordOf(row).current;
                    return {
                        id: row.id,
                        name: row.name,
                        source: row.userId === null ? ('org' as const) : ('workspace' as const),
                        description: version.description,
                        requires: requirements.get(version.id) ?? { tools: [], connections: [] },
                        versionId: version.id,
                        sha256: version.sha256,
                        objectKey: version.objectKey,
                    };
                });
        },
        async switchedOff() {
            check();
            return [...off];
        },
        async setBuiltinEnabled(name, enabled) {
            check();
            if (enabled) off.delete(name);
            else off.add(name);
        },
        async readVersion(versionId, access) {
            check();
            const row = [...rows.values()].find((r) => r.versions.some((v) => v.id === versionId));
            if (!row) return null;
            if (access !== 'any' && row.userId !== access.owner) return null;
            if (lost) throw new SkillGoneError();
            const version = row.versions.find((v) => v.id === versionId)!;
            return { sha256: version.sha256, body: bodies.get(versionId)! };
        },
    };
}
