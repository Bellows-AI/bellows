import {
    ADMIN_ROLE,
    CONTENT_TYPE_HEADER,
    ERROR_CODES,
    MAX_SKILL_BYTES,
    SKILL_NAME,
    type Skill,
} from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { Caller } from '../auth/store.js';
import {
    SkillGoneError,
    SkillIntegrityError,
    SkillUnavailableError,
    type SkillOwner,
    type SkillRecord,
    type SkillStore,
} from '../db/skill-store.js';
import type { OrgRegistry } from '../orgs.js';
import {
    bundleFromSkillMd,
    bundleFromZip,
    bundleReplacingSkillMd,
    filesOfTar,
    type BundleFile,
    SkillBundleError,
    type SkillBundle,
} from '../skills/skill-bundle.js';
import { zipOfFiles } from '../skills/skill-zip.js';
import { bad, body as jsonBody } from './helpers.js';

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;
const HTTP_UNAVAILABLE = 503;

const BYTES_PER_KIB = 1024;
const ZIP_HEADROOM_KIB = 256;
/** Headroom over the inflated cap for the zip's own headers; the codec bounds the inflated bytes. */
const ZIP_BODY_LIMIT = MAX_SKILL_BYTES + ZIP_HEADROOM_KIB * BYTES_PER_KIB;
const CONTROL_BODY_LIMIT = 4096;
const ZIP_CONTENT_TYPE = 'application/zip';

type Door = 'org' | 'workspace';

/** The wire shape of a skill: the version's address in the object store is internal and never leaves the board. */
function wireOf(skill: SkillRecord) {
    const { objectKey: _objectKey, ...current } = skill.current;
    return {
        id: skill.id,
        name: skill.name,
        scope: skill.scope,
        enabled: skill.enabled,
        createdBy: skill.createdBy,
        createdAt: skill.createdAt,
        updatedAt: skill.updatedAt,
        current,
    };
}

interface Context {
    store: SkillStore;
    caller: Caller | null;
    /** Who the by-id operations name as owner: null for the org door, the member's id for the workspace door. */
    owner: SkillOwner;
}

/**
 * The store and owner of a request, or null once the refusal is sent. The workspace door needs a signed-in member; the
 * org door's reads are open to any caller and its writes to an org admin (like `org-executors.ts`).
 */
async function contextOf(
    orgs: OrgRegistry,
    request: FastifyRequest,
    reply: FastifyReply,
    { door, write }: { door: Door; write: boolean }
): Promise<Context | null> {
    const rt = await orgs.for(orgOf(request));
    if (!rt?.skills) {
        bad(reply, ERROR_CODES.WORKSPACE_UNAVAILABLE, 'No skill store for this organization', HTTP_UNAVAILABLE);
        return null;
    }
    const caller = callerOf(request);
    if (door === 'workspace' || write) {
        if (!caller) {
            bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
            return null;
        }
    }
    if (door === 'org' && write && caller?.role !== ADMIN_ROLE) {
        bad(reply, ERROR_CODES.FORBIDDEN, 'Only an organization admin can manage organization skills', HTTP_FORBIDDEN);
        return null;
    }
    return { store: rt.skills, caller, owner: door === 'org' ? null : (caller?.user.id ?? null) };
}

const notFound = (reply: FastifyReply) => bad(reply, ERROR_CODES.SKILL_NOT_FOUND, 'No such skill', HTTP_NOT_FOUND);

/** An id that is not a uuid can match no row; Postgres would otherwise reject the cast as a 503. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (request: FastifyRequest): string | null => {
    const { id } = request.params as { id?: string };
    return typeof id === 'string' && UUID.test(id) ? id : null;
};

/** A store failure is a 503 with the cause; a lost object is a 410, never an empty skill. */
function storeFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
    request.log.error({ err: error });
    if (error instanceof SkillGoneError) {
        return bad(reply, ERROR_CODES.SKILL_GONE, 'The stored skill content is gone', HTTP_GONE);
    }
    const message =
        error instanceof SkillUnavailableError || error instanceof SkillIntegrityError
            ? error.message
            : 'The skill store is unavailable';
    return bad(reply, ERROR_CODES.UNAVAILABLE, message, HTTP_UNAVAILABLE);
}

/** Runs a store call; a failure is answered and `undefined` returned. */
async function attempt<T>(request: FastifyRequest, reply: FastifyReply, run: () => Promise<T>) {
    try {
        return { value: await run() };
    } catch (error) {
        storeFailure(request, reply, error);
    }
}

function bundleRefusal(reply: FastifyReply, error: SkillBundleError) {
    return reply
        .code(HTTP_UNPROCESSABLE)
        .send({ error: error.message, code: ERROR_CODES.SKILL_BUNDLE_INVALID, reason: error.reason });
}

/** A zip create with no `?name=` at all takes its name from SKILL.md; an empty `?name=` is a bad name. */
const isDerived = (isZip: boolean, given: unknown): boolean => isZip && given === undefined;

/**
 * The bundle a write carries: raw `application/zip` (the name from `?name=`, else from its SKILL.md, on create) or JSON
 * `{ name, skillMd }`. Null once the refusal is sent.
 */
function bundleOf(
    request: FastifyRequest,
    reply: FastifyReply,
    name: string | null
): { name: string; bundle: SkillBundle } | null {
    const isZip = request.headers[CONTENT_TYPE_HEADER]?.startsWith(ZIP_CONTENT_TYPE) === true;
    const fromBody = isZip ? null : jsonBody(request.body);
    const given = name ?? (isZip ? (request.query as { name?: unknown }).name : fromBody?.name);
    if (!isDerived(isZip, given) && (typeof given !== 'string' || given === '')) {
        bad(reply, ERROR_CODES.BAD_NAME, 'name is required');
        return null;
    }
    try {
        if (isZip) {
            if (!Buffer.isBuffer(request.body)) {
                bad(reply, ERROR_CODES.BAD_BODY, 'The body must be a zip archive');
                return null;
            }
            const bundle = bundleFromZip(given === undefined ? null : (given as string), request.body);
            return { name: bundle.name, bundle };
        }
        if (typeof fromBody?.skillMd !== 'string') {
            bad(reply, ERROR_CODES.BAD_BODY, 'skillMd must be a string');
            return null;
        }
        return { name: given as string, bundle: bundleFromSkillMd(given as string, fromBody.skillMd) };
    } catch (error) {
        if (error instanceof SkillBundleError) {
            bundleRefusal(reply, error);
            return null;
        }
        throw error;
    }
}

async function handleList(orgs: OrgRegistry, door: Door, request: FastifyRequest, reply: FastifyReply) {
    const context = await contextOf(orgs, request, reply, { door, write: false });
    if (!context) return reply;
    const owner = context.owner;
    const listed = await attempt(request, reply, () =>
        owner === null ? context.store.listOrg() : context.store.listWorkspace(owner)
    );
    if (!listed) return reply;
    return reply.code(HTTP_OK).send({ skills: listed.value.map(wireOf) });
}

/** The files of a skill's current version, or null once the refusal is sent (404 gone row, 410, 503). */
async function readCurrentFiles(
    request: FastifyRequest,
    reply: FastifyReply,
    context: Context,
    skill: SkillRecord
): Promise<BundleFile[] | null> {
    const read = await attempt(request, reply, () =>
        context.store.readVersion(skill.current.id, { owner: context.owner })
    );
    if (!read) return null;
    if (read.value === null) {
        notFound(reply);
        return null;
    }
    try {
        return filesOfTar(read.value.body);
    } catch (error) {
        storeFailure(request, reply, new SkillIntegrityError((error as Error).message));
        return null;
    }
}

async function handleGet(orgs: OrgRegistry, door: Door, request: FastifyRequest, reply: FastifyReply) {
    const context = await contextOf(orgs, request, reply, { door, write: false });
    if (!context) return reply;
    const id = idOf(request);
    if (id === null) return notFound(reply);
    const found = await attempt(request, reply, () => context.store.get(context.owner, id));
    if (!found) return reply;
    if (found.value === null) return notFound(reply);
    const skill = found.value;
    const files = await readCurrentFiles(request, reply, context, skill);
    if (!files) return reply;
    const main = files.find((file) => file.path === 'SKILL.md');
    return reply.code(HTTP_OK).send({
        skill: wireOf(skill),
        skillMd: main?.bytes.toString('utf8') ?? '',
        files: files.map((file) => ({ path: file.path, size: file.bytes.length })),
    });
}

async function handleZip(orgs: OrgRegistry, door: Door, request: FastifyRequest, reply: FastifyReply) {
    const context = await contextOf(orgs, request, reply, { door, write: false });
    if (!context) return reply;
    const id = idOf(request);
    if (id === null) return notFound(reply);
    const found = await attempt(request, reply, () => context.store.get(context.owner, id));
    if (!found) return reply;
    if (found.value === null) return notFound(reply);
    const skill = found.value;
    const files = await readCurrentFiles(request, reply, context, skill);
    if (!files) return reply;
    // The name was validated at create; re-check it so it can never break out of the header.
    const name = SKILL_NAME.test(skill.name) ? skill.name : 'skill';
    return reply
        .code(HTTP_OK)
        .header(CONTENT_TYPE_HEADER, ZIP_CONTENT_TYPE)
        .header('content-disposition', `attachment; filename="${name}.zip"`)
        .header('cache-control', 'no-store')
        .send(zipOfFiles(files));
}

async function handleCreate(orgs: OrgRegistry, door: Door, request: FastifyRequest, reply: FastifyReply) {
    const context = await contextOf(orgs, request, reply, { door, write: true });
    if (!context) return reply;
    const parsed = bundleOf(request, reply, null);
    if (!parsed) return reply;
    const { name, bundle } = parsed;
    const created = await attempt(request, reply, () =>
        context.store.create(context.owner, { name, bundle, createdBy: context.caller?.user.id ?? null })
    );
    if (!created) return reply;
    const result = created.value;
    if (result.result === 'created') return reply.code(HTTP_CREATED).send({ skill: wireOf(result.skill) });
    if (result.result === 'name_taken') {
        return bad(reply, ERROR_CODES.NAME_TAKEN, `A skill named "${name}" already exists`, HTTP_CONFLICT);
    }
    const reason = result.result === 'reserved' ? 'reserved_name' : 'bad_name';
    return reply
        .code(HTTP_UNPROCESSABLE)
        .send({ error: `"${name}" cannot be a skill name`, code: ERROR_CODES.SKILL_BUNDLE_INVALID, reason });
}

const staleVersion = (reply: FastifyReply) =>
    bad(
        reply,
        ERROR_CODES.SKILL_VERSION_STALE,
        'The skill changed since it was read; reload it and edit again',
        HTTP_CONFLICT
    );

/**
 * The bundle of an inline (JSON) edit: the current version's files with SKILL.md replaced, so a helper file survives. The
 * edit names the version it was made on; any other current version is stale. Null once the refusal is sent.
 */
async function editBundleOf(
    request: FastifyRequest,
    reply: FastifyReply,
    context: Context,
    skill: SkillRecord
): Promise<{ name: string; bundle: SkillBundle } | null> {
    const { skillMd, baseVersionId } = jsonBody(request.body);
    if (typeof skillMd !== 'string') {
        bad(reply, ERROR_CODES.BAD_BODY, 'skillMd must be a string');
        return null;
    }
    if (typeof baseVersionId !== 'string' || !UUID.test(baseVersionId)) {
        bad(reply, ERROR_CODES.BAD_BODY, 'baseVersionId must be the uuid of the version the edit was made on');
        return null;
    }
    if (baseVersionId !== skill.current.id) {
        staleVersion(reply);
        return null;
    }
    const files = await readCurrentFiles(request, reply, context, skill);
    if (!files) return null;
    try {
        return { name: skill.name, bundle: bundleReplacingSkillMd(skill.name, files, skillMd) };
    } catch (error) {
        if (error instanceof SkillBundleError) {
            bundleRefusal(reply, error);
            return null;
        }
        throw error;
    }
}

async function handleAddVersion(orgs: OrgRegistry, door: Door, request: FastifyRequest, reply: FastifyReply) {
    const context = await contextOf(orgs, request, reply, { door, write: true });
    if (!context) return reply;
    const id = idOf(request);
    if (id === null) return notFound(reply);
    const existing = await attempt(request, reply, () => context.store.get(context.owner, id));
    if (!existing) return reply;
    if (existing.value === null) return notFound(reply);
    const skill = existing.value;
    const isZip = request.headers[CONTENT_TYPE_HEADER]?.startsWith(ZIP_CONTENT_TYPE) === true;
    const parsed = isZip ? bundleOf(request, reply, skill.name) : await editBundleOf(request, reply, context, skill);
    if (!parsed) return reply;
    const { bundle } = parsed;
    const options = isZip ? undefined : { expectedVersionId: skill.current.id };
    const added = await attempt(request, reply, () => context.store.addVersion(context.owner, id, bundle, options));
    if (!added) return reply;
    const result = added.value;
    if (result.result === 'missing') return notFound(reply);
    if (result.result === 'stale') return staleVersion(reply);
    return reply.code(result.result === 'added' ? HTTP_CREATED : HTTP_OK).send({ skill: wireOf(result.skill) });
}

async function handleEnabled(orgs: OrgRegistry, door: Door, request: FastifyRequest, reply: FastifyReply) {
    const context = await contextOf(orgs, request, reply, { door, write: true });
    if (!context) return reply;
    const id = idOf(request);
    if (id === null) return notFound(reply);
    const { enabled } = jsonBody(request.body);
    if (typeof enabled !== 'boolean') return bad(reply, ERROR_CODES.BAD_BODY, 'enabled must be a boolean');
    const set = await attempt(request, reply, async () => {
        if ((await context.store.setEnabled(context.owner, id, enabled)) === 'missing') return null;
        return context.store.get(context.owner, id);
    });
    if (!set) return reply;
    if (set.value === null) return notFound(reply);
    return reply.code(HTTP_OK).send({ skill: wireOf(set.value) });
}

/** Admin only: switches one of the board's built-in skills on or off for this organization. Idempotent. */
async function handleBuiltinEnabled(
    orgs: OrgRegistry,
    builtin: readonly Skill[],
    request: FastifyRequest,
    reply: FastifyReply
) {
    const context = await contextOf(orgs, request, reply, { door: 'org', write: true });
    if (!context) return reply;
    const { name } = request.params as { name: string };
    if (!builtin.some((skill) => skill.name === name)) return notFound(reply);
    const { enabled } = jsonBody(request.body);
    if (typeof enabled !== 'boolean') return bad(reply, ERROR_CODES.BAD_BODY, 'enabled must be a boolean');
    const set = await attempt(request, reply, () =>
        context.store.setBuiltinEnabled(name, enabled, context.caller?.user.id ?? null)
    );
    if (!set) return reply;
    return reply.code(HTTP_OK).send({ name, enabled });
}

async function handleDelete(orgs: OrgRegistry, door: Door, request: FastifyRequest, reply: FastifyReply) {
    const context = await contextOf(orgs, request, reply, { door, write: true });
    if (!context) return reply;
    const id = idOf(request);
    if (id === null) return notFound(reply);
    const removed = await attempt(request, reply, () => context.store.remove(context.owner, id));
    if (!removed) return reply;
    if (removed.value === 'missing') return notFound(reply);
    return reply.code(HTTP_NO_CONTENT).send();
}

/** Workspace → org. Admin only; the skill must be the caller's own. */
async function handlePromote(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const context = await contextOf(orgs, request, reply, { door: 'workspace', write: true });
    if (!context) return reply;
    if (context.caller?.role !== ADMIN_ROLE) {
        return bad(
            reply,
            ERROR_CODES.FORBIDDEN,
            'Only an organization admin can publish a skill to the organization',
            HTTP_FORBIDDEN
        );
    }
    const id = idOf(request);
    if (id === null) return notFound(reply);
    if (jsonBody(request.body).scope !== 'org') return bad(reply, ERROR_CODES.BAD_SCOPE, 'scope must be "org"');
    const userId = context.owner;
    if (userId === null) return notFound(reply);
    const promoted = await attempt(request, reply, () => context.store.promote(userId, id));
    if (!promoted) return reply;
    const result = promoted.value;
    if (result.result === 'promoted') return reply.code(HTTP_OK).send({ skill: wireOf(result.skill) });
    if (result.result === 'name_taken') {
        return bad(reply, ERROR_CODES.NAME_TAKEN, 'An organization skill already has this name', HTTP_CONFLICT);
    }
    return notFound(reply);
}

/**
 * The org and workspace skill routes (docs/skills.md). Both doors share the handlers; they differ in who owns the row
 * the by-id store call names.
 */
export const skillStoreRoutes =
    ({ orgs, builtin }: { orgs: OrgRegistry; builtin: () => Skill[] }): FastifyPluginAsync =>
    async (app) => {
        // A child scope, so the raw-zip parser reaches only these routes.
        await app.register(async (scope) => {
            scope.addContentTypeParser(ZIP_CONTENT_TYPE, { parseAs: 'buffer' }, (_request, raw, done) =>
                done(null, raw)
            );
            for (const door of ['org', 'workspace'] as const) {
                const base = `/api/${door}/skills`;
                scope.get(base, { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
                    handleList(orgs, door, request, reply)
                );
                scope.get(`${base}/:id`, { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
                    handleGet(orgs, door, request, reply)
                );
                scope.get(`${base}/:id/zip`, { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
                    handleZip(orgs, door, request, reply)
                );
                scope.post(base, { bodyLimit: ZIP_BODY_LIMIT }, (request, reply) =>
                    handleCreate(orgs, door, request, reply)
                );
                scope.post(`${base}/:id/versions`, { bodyLimit: ZIP_BODY_LIMIT }, (request, reply) =>
                    handleAddVersion(orgs, door, request, reply)
                );
                scope.put(`${base}/:id/enabled`, { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
                    handleEnabled(orgs, door, request, reply)
                );
                scope.delete(`${base}/:id`, { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
                    handleDelete(orgs, door, request, reply)
                );
            }
            scope.put('/api/org/skills/builtin/:name/enabled', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
                handleBuiltinEnabled(orgs, builtin(), request, reply)
            );
            scope.post('/api/workspace/skills/:id/scope', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
                handlePromote(orgs, request, reply)
            );
        });
    };
