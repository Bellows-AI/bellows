import { CONTENT_TYPE_HEADER, type SkillSource, SKILL_SOURCES } from '@factory-ai/core';
import { request, type RequestOptions, type RequestResult } from './request.js';

/**
 * The skills' client half: the org and workspace stores (`/api/<door>/skills`), the built-in switches and
 * the catalog (`GET /api/skills`). A read validates every field the UI uses and fails whole on a malformed
 * row — a row is never dropped, so a list is never shorter than the server's. A refusal is carried as the
 * route sent it: its sentence, its `code` and the bundle `reason`.
 */

export type SkillDoor = 'org' | 'workspace';

export interface SkillAuthor {
    id: string;
    login: string;
}

export interface SkillVersion {
    id: string;
    sha256: string;
    size: number;
    description: string;
    createdAt: string;
    /** Null for a version written before authors were recorded, or once the author is deleted. */
    author: SkillAuthor | null;
}

/** One stored (org or workspace) skill, as `GET /api/<door>/skills` lists it. */
export interface StoredSkill {
    id: string;
    name: string;
    scope: 'org' | 'workspace';
    enabled: boolean;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
    current: SkillVersion;
}

export interface SkillFile {
    path: string;
    size: number;
}

export interface SkillConnectionRequirement {
    name: string;
    env: string[];
    selectedBy: 'connections' | null;
}

export interface CatalogRequirements {
    tools: string[];
    connections: SkillConnectionRequirement[];
}

/** One entry of `GET /api/skills`; `switchedOff` marks a built-in the org turned off (never selectable). */
export interface CatalogSkill {
    name: string;
    description: string;
    source: SkillSource;
    shadowedBy?: SkillSource;
    switchedOff?: boolean;
    requires: CatalogRequirements;
}

/** `GET /api/skills/builtin/:name`: a built-in's files and the release that ships them. */
export interface BuiltinSkill {
    name: string;
    description: string;
    requires: CatalogRequirements;
    skillMd: string;
    files: SkillFile[];
    version: string;
}

/** A refusal as the route sent it. `reason` is a bundle refusal's detail (422 `SKILL_BUNDLE_INVALID`). */
export interface SkillRefusal {
    ok: false;
    error: string;
    code?: string;
    reason?: string;
}

export type SkillResult<T> = ({ ok: true } & T) | SkillRefusal;

const HTTP_STATUS_NO_CONTENT = 204;
const ZIP_CONTENT_TYPE = 'application/zip';
const ZIP_HEADERS = { [CONTENT_TYPE_HEADER]: ZIP_CONTENT_TYPE };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isStrings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

const isVersion = (value: unknown): value is SkillVersion => {
    if (!isRecord(value)) return false;
    const { author } = value;
    return (
        typeof value.id === 'string' &&
        typeof value.sha256 === 'string' &&
        typeof value.size === 'number' &&
        typeof value.description === 'string' &&
        typeof value.createdAt === 'string' &&
        (author === null || (isRecord(author) && typeof author.id === 'string' && typeof author.login === 'string'))
    );
};

const isStoredSkill = (value: unknown): value is StoredSkill =>
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.scope === 'org' || value.scope === 'workspace') &&
    typeof value.enabled === 'boolean' &&
    (value.createdBy === null || typeof value.createdBy === 'string') &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    isVersion(value.current);

const isFile = (value: unknown): value is SkillFile =>
    isRecord(value) && typeof value.path === 'string' && typeof value.size === 'number';

const isRequirements = (value: unknown): value is CatalogRequirements =>
    isRecord(value) &&
    isStrings(value.tools) &&
    Array.isArray(value.connections) &&
    value.connections.every(
        (c) =>
            isRecord(c) &&
            typeof c.name === 'string' &&
            isStrings(c.env) &&
            (c.selectedBy === 'connections' || c.selectedBy === null)
    );

const isSource = (value: unknown): value is SkillSource => SKILL_SOURCES.includes(value as SkillSource);

const isCatalogSkill = (value: unknown): value is CatalogSkill =>
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    isSource(value.source) &&
    (value.shadowedBy === undefined || isSource(value.shadowedBy)) &&
    (value.switchedOff === undefined || typeof value.switchedOff === 'boolean') &&
    isRequirements(value.requires);

const isBuiltin = (value: unknown): value is BuiltinSkill =>
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    isRequirements(value.requires) &&
    typeof value.skillMd === 'string' &&
    Array.isArray(value.files) &&
    value.files.every(isFile) &&
    typeof value.version === 'string';

const unexpected = (what: string): SkillRefusal => ({
    ok: false,
    error: `Could not ${what}: unexpected response shape.`,
});

/** A failed request as a skill refusal: its sentence, `code` and `reason` as sent. */
const refused = (failed: Extract<RequestResult<unknown>, { ok: false }>): SkillRefusal => {
    const { error, code, body } = failed;
    return {
        ok: false,
        error,
        ...(code ? { code } : {}),
        ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
    };
};

/** One request: a failed one is its refusal, an ok one is handed to `parse`, which returns the result or null for a bad shape. */
const call = async <T>(
    verb: string,
    url: string,
    init: RequestOptions<unknown>,
    parse: (body: unknown) => SkillResult<T> | null
): Promise<SkillResult<T>> => {
    const result = await request<unknown>(url, { ...init, verb: `Could not ${verb}` });
    if (!result.ok) return refused(result);
    return parse(result.value) ?? unexpected(verb);
};

const bodyOf = (body: unknown): Record<string, unknown> => (isRecord(body) ? body : {});

const skillOf = (body: unknown): SkillResult<{ skill: StoredSkill }> | null => {
    const { skill } = bodyOf(body);
    return isStoredSkill(skill) ? { ok: true, skill } : null;
};

const json = (method: 'POST' | 'PUT', body: unknown): RequestOptions<unknown> => ({ method, body });

const base = (door: SkillDoor) => `/api/${door}/skills`;
const itemUrl = (door: SkillDoor, id: string) => `${base(door)}/${encodeURIComponent(id)}`;

export const listSkills = (door: SkillDoor) =>
    call<{ skills: StoredSkill[] }>('load the skills', base(door), {}, (body) => {
        const { skills } = bodyOf(body);
        return Array.isArray(skills) && skills.every(isStoredSkill) ? { ok: true, skills } : null;
    });

export const getSkill = (door: SkillDoor, id: string) =>
    call<{ skill: StoredSkill; skillMd: string; files: SkillFile[] }>(
        'load the skill',
        itemUrl(door, id),
        {},
        (body) => {
            const { skill, skillMd, files } = bodyOf(body);
            return isStoredSkill(skill) && typeof skillMd === 'string' && Array.isArray(files) && files.every(isFile)
                ? { ok: true, skill, skillMd, files }
                : null;
        }
    );

export const getBuiltin = (name: string) =>
    call<{ builtin: BuiltinSkill }>(
        'load the built-in skill',
        `/api/skills/builtin/${encodeURIComponent(name)}`,
        {},
        (body) => {
            return isBuiltin(body) ? { ok: true, builtin: body } : null;
        }
    );

export const listCatalog = () =>
    call<{ skills: CatalogSkill[] }>('load the catalog', '/api/skills', {}, (body) => {
        const { skills } = bodyOf(body);
        return Array.isArray(skills) && skills.every(isCatalogSkill) ? { ok: true, skills } : null;
    });

/** A create from SKILL.md names the skill; a zip create sends no `?name=`, the name is SKILL.md's own. */
export const createSkill = (door: SkillDoor, input: { name: string; skillMd: string } | { zip: File }) =>
    call(
        'create the skill',
        base(door),
        'zip' in input
            ? { method: 'POST', headers: ZIP_HEADERS, body: input.zip }
            : json('POST', { name: input.name, skillMd: input.skillMd }),
        skillOf
    );

export const editSkillMd = (door: SkillDoor, id: string, skillMd: string, baseVersionId: string) =>
    call('save the skill', `${itemUrl(door, id)}/versions`, json('POST', { skillMd, baseVersionId }), skillOf);

export const uploadVersion = (door: SkillDoor, id: string, zip: File) =>
    call(
        'upload the version',
        `${itemUrl(door, id)}/versions`,
        { method: 'POST', headers: ZIP_HEADERS, body: zip },
        skillOf
    );

export const setEnabled = (door: SkillDoor, id: string, enabled: boolean) =>
    call('switch the skill', `${itemUrl(door, id)}/enabled`, json('PUT', { enabled }), skillOf);

export const setBuiltinEnabled = (name: string, enabled: boolean) =>
    call<{ name: string; enabled: boolean }>(
        'switch the built-in skill',
        `/api/org/skills/builtin/${encodeURIComponent(name)}/enabled`,
        json('PUT', { enabled }),
        (answer) => {
            const body = bodyOf(answer);
            return typeof body.name === 'string' && typeof body.enabled === 'boolean'
                ? { ok: true, name: body.name, enabled: body.enabled }
                : null;
        }
    );

export const deleteSkill = async (door: SkillDoor, id: string): Promise<SkillResult<object>> => {
    const result = await request(itemUrl(door, id), {
        method: 'DELETE',
        verb: 'Could not delete the skill',
        empty: true,
    });
    if (!result.ok) return refused(result);
    return result.status === HTTP_STATUS_NO_CONTENT ? { ok: true } : unexpected('delete the skill');
};

export const promote = (id: string) =>
    call('promote the skill', `${itemUrl('workspace', id)}/scope`, json('POST', { scope: 'org' }), skillOf);

/** Fetches the zip, then clicks an object-URL anchor. A non-200 is the refusal: an error body is never saved as a file. */
export const downloadZip = async (door: SkillDoor, id: string, name: string): Promise<SkillResult<object>> => {
    const result = await request<Blob>(`${itemUrl(door, id)}/zip`, {
        blob: true,
        verb: 'Could not download the skill',
    });
    if (!result.ok) return refused(result);
    const url = URL.createObjectURL(result.value);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name}.zip`;
    document.body.append(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return { ok: true };
};
