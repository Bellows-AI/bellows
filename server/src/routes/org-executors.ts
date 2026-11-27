import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
    ADMIN_ROLE,
    type DeploymentMode,
    ERROR_CODES,
    executorConnectionFields,
    ORG_SCOPE,
    type ProviderConnectionMeta,
    USER_SCOPE,
    type ExecutorScope,
} from '@factory-ai/core';
import { isBridged } from '../auth/bridge-binding.js';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { Caller } from '../auth/store.js';
import type { RunnerClassOption } from '../config-runner-classes.js';
import type { OrgRegistry } from '../orgs.js';
import type { UserExecutorStore } from '../db/user-executor-store.js';
import { bad, badSegment, body as jsonBody, guard } from './helpers.js';
import {
    executorFieldRefusal,
    executorFieldStatus,
    HTTP_CONNECTION_REFUSED,
    isConnectionRefusal,
    type LifecycleRefusal,
    lifecycleRefusal,
    MAX_EXECUTORS_PER_ORG,
    MAX_EXECUTORS_PER_USER,
    orgRunnerClassRefusal,
    parseExecutorFields,
    selectionRefusal,
    visibleConnections,
} from './executor-fields.js';

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;

const BYTES_PER_KIB = 1024;
const BODY_LIMIT_KIB = 64;
const BODY_LIMIT = BODY_LIMIT_KIB * BYTES_PER_KIB;
/** No payload past an id or a scope pair needs more than a control route's headroom. */
const CONTROL_BODY_LIMIT = 4096;

/** No store behind the caller's org — every route here refuses the same way. */
function noStore(reply: FastifyReply) {
    return bad(reply, ERROR_CODES.WORKSPACE_UNAVAILABLE, 'No executor store for this organization', HTTP_UNAVAILABLE);
}

/** The organization's executor profiles are the caller's org's — the same resolution every route makes. */
async function storeOf(orgs: OrgRegistry, request: FastifyRequest): Promise<UserExecutorStore | null> {
    const rt = await orgs.for(orgOf(request));
    return rt?.userExecutors ?? null;
}

/** Whether the caller administers the org: an admin reads the profiles' config, a member only selects them. */
function requireAdmin(caller: Caller): boolean {
    return caller.role === ADMIN_ROLE;
}

/** Whether the error is the unique violation a per-scope name index raises — anything else rethrows. */
function isNameTaken(error: unknown): boolean {
    if ((error as { code?: string }).code === '23505') return true;
    throw error;
}

/**
 * The store and caller every mutating route needs — or null once the refusal is sent. Every mutating route is an
 * `admin` row in `ROUTE_CLASSES`, so the auth hook has already refused a member.
 */
async function adminContext(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeOf(orgs, request);
    if (!store) {
        noStore(reply);
        return null;
    }
    const caller = callerOf(request);
    if (!caller) {
        bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
        return null;
    }
    return { store, caller };
}

/** The `:id` path segment, or null once the BAD_ID refusal is sent. */
function idParam(request: FastifyRequest, reply: FastifyReply): string | null {
    const { id } = request.params as { id?: string };
    if (typeof id !== 'string' || !id) {
        bad(reply, ERROR_CODES.BAD_ID, 'id must be a string');
        return null;
    }
    return id;
}

/**
 * Runs a write, answering `{ taken: true }` for the unique-name violation, `{ refused }` for a provider connection
 * selection the store refused and `{ ok }` otherwise.
 */
function saveOrTaken<T>(request: FastifyRequest, reply: FastifyReply, write: () => Promise<T>) {
    return guard(
        reply,
        (e) => request.log.error({ err: e }),
        async (): Promise<{ ok: T } | { taken: true } | { refused: string } | { blocked: LifecycleRefusal }> => {
            try {
                return { ok: await write() };
            } catch (error) {
                if (isConnectionRefusal(error)) return { refused: error.message };
                const refusal = lifecycleRefusal(error);
                if (refusal) return { blocked: refusal };
                if (isNameTaken(error)) return { taken: true };
                throw error;
            }
        }
    );
}

/** The refusal a write answers when a default still names the executor (or its id is not the caller's). */
const blocked = (reply: FastifyReply, refusal: LifecycleRefusal) =>
    bad(reply, refusal.code, refusal.message, refusal.status);

/** The 409 a refused connection selection answers, once the write's answer says so. */
const connectionRefused = (reply: FastifyReply, message: string) =>
    bad(reply, ERROR_CODES.PROVIDER_CONNECTION_REFUSED, message, HTTP_CONNECTION_REFUSED);

/**
 * The route-level name rules for an org profile, restating the row check the way the personal PUT
 * does: a name arrives in a JSON body now, so the route guards the request and
 * `user_executor_name_ck` guards the row (the constraint kept 012's name through 047's table rename).
 */
function badProfileName(name: string): string | null {
    return badSegment('name', name);
}

type VisibleConnections = ReadonlyMap<string, ProviderConnectionMeta>;

/**
 * A row's connection fields beside its id, when the read knows the caller's visible connections: safe name, provider
 * and scope, and whether the pasted config overrides the connection — never a key or a secret reference.
 */
function connectionFields(
    row: { providerConnectionId: string | null; configOverridesConnection?: boolean },
    visible: VisibleConnections | undefined
) {
    if (visible === undefined) return {};
    return {
        ...executorConnectionFields(row.providerConnectionId, visible),
        configOverridesConnection: row.configOverridesConnection === true,
    };
}

/** Selection metadata every member may see. */
function selectionMetadata(
    row: {
        id: string;
        name: string;
        type: string;
        createdAt: string;
        suspended: boolean;
        runnerClass: string | null;
        providerConnectionId: string | null;
        configOverridesConnection?: boolean;
    },
    visible?: VisibleConnections
): Record<string, unknown> {
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        createdAt: row.createdAt,
        suspended: row.suspended,
        runnerClass: row.runnerClass,
        providerConnectionId: row.providerConnectionId,
        ...connectionFields(row, visible),
    };
}

/**
 * The create and edit body: the shared fields, the name shape and the runner class this board declares —
 * or null once the refusal is sent. A class refusal is a 422 naming `runnerClass`.
 */
function parseOrgFields(
    request: FastifyRequest,
    reply: FastifyReply,
    { deploymentMode, runnerClasses }: Pick<OrgExecutorRoutesDeps, 'deploymentMode' | 'runnerClasses'>
) {
    const fields = parseExecutorFields(jsonBody(request.body), deploymentMode);
    if (typeof fields === 'string') {
        bad(reply, executorFieldRefusal(fields), fields, executorFieldStatus(fields));
        return null;
    }
    const reason = badProfileName(fields.name);
    if (reason) {
        bad(reply, ERROR_CODES.BAD_EXECUTOR_NAME, `"${fields.name}": ${reason}`);
        return null;
    }
    const refusal = orgRunnerClassRefusal(fields.runnerClass, runnerClasses);
    if (refusal) {
        bad(reply, executorFieldRefusal(refusal), refusal, executorFieldStatus(refusal));
        return null;
    }
    return fields;
}

/** The admin list's row: the metadata plus the configuration and the audit fields. */
function adminRow(
    row: {
        id: string;
        name: string;
        type: string;
        createdAt: string;
        updatedAt: string;
        gateFixRounds: number;
        createdBy: string | null;
        suspended: boolean;
        runnerClass: string | null;
        providerConnectionId: string | null;
        configOverridesConnection?: boolean;
        config: Record<string, unknown>;
    },
    visible?: VisibleConnections
): Record<string, unknown> {
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        suspended: row.suspended,
        gateFixRounds: row.gateFixRounds,
        createdBy: row.createdBy,
        runnerClass: row.runnerClass,
        providerConnectionId: row.providerConnectionId,
        ...connectionFields(row, visible),
        config: row.config,
    };
}

async function handleListOrgExecutors(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const rt = await orgs.for(orgOf(request));
    const store = rt?.userExecutors;
    if (!store) return noStore(reply);
    const connections = rt.providerConnections;
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);

    // The config may hold provider credentials: it travels to the admins who manage it, never to
    // the members who only select it — the same visibility split the workspace poll makes.
    // A bridged (MCP) caller gets the member view even as an admin: an MCP grant never reads credentials.
    if (requireAdmin(caller) && !isBridged(request.raw)) {
        const loaded = await guard(
            reply,
            (e) => request.log.error({ err: e }),
            async () => Promise.all([store.listOrgWithConfigs(), visibleConnections(connections, caller.user.id)])
        );
        if (!loaded.ok) return reply;
        const [rows, visible] = loaded.value;
        return reply.code(HTTP_OK).send({ executors: rows.map((row) => adminRow(row, visible)) });
    }
    const loaded = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () => Promise.all([store.listOrg(), visibleConnections(connections, caller.user.id)])
    );
    if (!loaded.ok) return reply;
    const [rows, visible] = loaded.value;
    return reply.code(HTTP_OK).send({ executors: rows.map((row) => selectionMetadata(row, visible)) });
}

async function handleCreateOrgExecutor(deps: OrgExecutorRoutesDeps, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await adminContext(deps.orgs, request, reply);
    if (!ctx) return reply;
    const { store, caller } = ctx;

    const fields = parseOrgFields(request, reply, deps);
    if (!fields) return reply;

    const counted = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.orgCount()
    );
    if (!counted.ok) return reply;
    if (counted.value >= MAX_EXECUTORS_PER_ORG) {
        return bad(
            reply,
            ERROR_CODES.TOO_MANY_EXECUTORS,
            `at most ${MAX_EXECUTORS_PER_ORG} organization executors can be configured at once`
        );
    }

    const saved = await saveOrTaken(request, reply, () => store.createOrg({ ...fields, createdBy: caller.user.id }));
    if (!saved.ok) return reply;
    if ('refused' in saved.value) return connectionRefused(reply, saved.value.refused);
    if ('blocked' in saved.value) return blocked(reply, saved.value.blocked);
    if ('taken' in saved.value) {
        return bad(
            reply,
            ERROR_CODES.NAME_TAKEN,
            `an organization executor named "${fields.name}" already exists`,
            HTTP_CONFLICT
        );
    }
    return reply.code(HTTP_CREATED).send(saved.value.ok);
}

async function handleUpdateOrgExecutor(deps: OrgExecutorRoutesDeps, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await adminContext(deps.orgs, request, reply);
    if (!ctx) return reply;
    const { store } = ctx;
    const id = idParam(request, reply);
    if (id === null) return reply;

    const raw = jsonBody(request.body);
    // Scope is not a field: it moves only through the scope route, loudly — quietly accepting it
    // here would let a caller believe they moved a profile between scopes when nothing changed.
    if ('scope' in raw) return bad(reply, ERROR_CODES.BAD_SCOPE, 'scope changes only through the scope route');

    // The body is the whole entry: a runnerClass it leaves out (or nulls) returns the profile to the default class.
    const fields = parseOrgFields(request, reply, deps);
    if (!fields) return reply;

    const saved = await saveOrTaken(request, reply, () => store.updateOrg(id, fields));
    if (!saved.ok) return reply;
    if ('refused' in saved.value) return connectionRefused(reply, saved.value.refused);
    if ('blocked' in saved.value) return blocked(reply, saved.value.blocked);
    if ('taken' in saved.value) {
        return bad(
            reply,
            ERROR_CODES.NAME_TAKEN,
            `an organization executor named "${fields.name}" already exists`,
            HTTP_CONFLICT
        );
    }
    if (!saved.value.ok) return reply.code(HTTP_NOT_FOUND).send({ error: 'No such organization executor' });
    return reply.code(HTTP_OK).send(saved.value.ok);
}

async function handleDeleteOrgExecutor(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await adminContext(orgs, request, reply);
    if (!ctx) return reply;
    const { store } = ctx;
    const id = idParam(request, reply);
    if (id === null) return reply;

    const removed = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () => {
            try {
                return { removed: await store.deleteOrg(id) };
            } catch (error) {
                const refusal = lifecycleRefusal(error);
                if (refusal) return { refusal };
                throw error;
            }
        }
    );
    if (!removed.ok) return reply;
    if ('refusal' in removed.value) return blocked(reply, removed.value.refusal);
    if (!removed.value.removed) return reply.code(HTTP_NOT_FOUND).send({ error: 'No such organization executor' });
    return reply.code(HTTP_OK).send({ id, removed: true });
}

/** Suspends or resumes an org profile for every member (issue 440): admin-gated, id-keyed. */
async function handleSuspendOrgExecutor(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await adminContext(orgs, request, reply);
    if (!ctx) return reply;
    const { store } = ctx;
    const id = idParam(request, reply);
    if (id === null) return reply;
    const { suspended } = jsonBody(request.body);
    if (typeof suspended !== 'boolean') return bad(reply, ERROR_CODES.BAD_BODY, 'suspended must be a boolean');

    const updated = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.setOrgSuspended(id, suspended)
    );
    if (!updated.ok) return reply;
    if (!updated.value) return reply.code(HTTP_NOT_FOUND).send({ error: 'No such organization executor' });
    return reply.code(HTTP_OK).send(selectionMetadata(updated.value));
}

/**
 * Configures the organization's default executor `{ executorId }`: an organization profile only, which every member
 * without a default of their own then launches on. Replacing it is this same call; clearing it is the DELETE.
 */
async function handlePutOrgDefault(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await adminContext(orgs, request, reply);
    if (!ctx) return reply;
    const { executorId } = jsonBody(request.body);
    if (typeof executorId !== 'string' || !executorId) {
        return bad(reply, ERROR_CODES.BAD_BODY, 'executorId must be a string');
    }
    try {
        const selected = await ctx.store.selectDefault(null, executorId);
        return reply.code(HTTP_OK).send({ defaultExecutorId: selected.executorId, name: selected.name });
    } catch (error) {
        const refused = selectionRefusal(reply, error, `the organization executor "${executorId}"`);
        if (refused) return refused;
        throw error;
    }
}

async function handleClearOrgDefault(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await adminContext(orgs, request, reply);
    if (!ctx) return reply;
    const cleared = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => ctx.store.clearDefault(null)
    );
    if (!cleared.ok) return reply;
    return reply.code(HTTP_OK).send({ cleared: cleared.value });
}

/**
 * The one route a profile's scope moves through: an administrator promotes their OWN personal row
 * to org scope, or demotes an org row into their own personal list. The store's WHERE clause holds
 * the ownership, and this route holds the role check — both halves of the same enforcement.
 */
async function handleChangeOrgExecutorScope(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await adminContext(orgs, request, reply);
    if (!ctx) return reply;
    const { store, caller } = ctx;
    const id = idParam(request, reply);
    if (id === null) return reply;

    const raw = jsonBody(request.body);
    const scope = raw.scope as ExecutorScope | undefined;
    if (scope !== USER_SCOPE && scope !== ORG_SCOPE) {
        return bad(reply, ERROR_CODES.BAD_SCOPE, `scope must be "${USER_SCOPE}" or "${ORG_SCOPE}"`);
    }
    // Each direction lands the row in a list with a cap, enforced before the move: a promotion
    // adds to the organization's list exactly as the create route does, a demotion to the calling
    // admin's personal list.
    const caps = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () => ({
            org: scope === ORG_SCOPE ? await store.orgCount() : 0,
            personal: scope === USER_SCOPE ? (await store.list(caller.user.id)).length : 0,
        })
    );
    if (!caps.ok) return reply;
    if (scope === ORG_SCOPE && caps.value.org >= MAX_EXECUTORS_PER_ORG) {
        return bad(
            reply,
            ERROR_CODES.TOO_MANY_EXECUTORS,
            `at most ${MAX_EXECUTORS_PER_ORG} organization executors can be configured at once`
        );
    }
    if (scope === USER_SCOPE && caps.value.personal >= MAX_EXECUTORS_PER_USER) {
        return bad(
            reply,
            ERROR_CODES.TOO_MANY_EXECUTORS,
            `at most ${MAX_EXECUTORS_PER_USER} executors can be configured at once`
        );
    }

    const moved = await saveOrTaken(request, reply, () => store.changeScope(id, scope, caller.user.id));
    if (!moved.ok) return reply;
    if ('refused' in moved.value) return connectionRefused(reply, moved.value.refused);
    if ('blocked' in moved.value) return blocked(reply, moved.value.blocked);
    if ('taken' in moved.value) {
        return bad(
            reply,
            ERROR_CODES.NAME_TAKEN,
            'an executor with that name already exists in the target scope',
            HTTP_CONFLICT
        );
    }
    if (!moved.value.ok) return reply.code(HTTP_NOT_FOUND).send({ error: 'No such executor to move' });
    return reply.code(HTTP_OK).send(moved.value.ok);
}

/**
 * Organization-scoped executor profiles (issue 391): the administrators' CRUD over the profiles
 * every member of the organization may select. A person's surface, like the workflow routes it
 * mirrors — a driver credential never gets past the auth wall here, because executor management is a
 * human's decision.
 *
 * - `GET /api/org/executors` — every member reads selection metadata (id, name, type, createdAt);
 *   the full configuration answers to admins only.
 * - `POST /api/org/executors` — create, admin-gated; `runnerClass` names a declared class or null.
 * - `PUT /api/org/executors/:id` — edit, admin-gated; `scope` in the body is a BAD_SCOPE refusal.
 * - `DELETE /api/org/executors/:id` — delete, admin-gated; refused while it is the organization default.
 * - `PUT /api/org/executors/default` `{executorId}` / `DELETE` — configure or clear the organization default, admin-gated.
 * - `POST /api/org/executors/:id/suspension` — suspend/resume `{suspended}`, admin-gated.
 * - `POST /api/org/executors/:id/scope` — promote/demote, admin-gated; the store only ever moves
 *   the calling admin's own personal row up.
 */
interface OrgExecutorRoutesDeps {
    readonly orgs: OrgRegistry;
    /** `config.deploymentMode`: cloud refuses a Claude subscription OAuth token in a config. */
    readonly deploymentMode: DeploymentMode;
    /** The classes an org profile may name (RUNNER_CLASSES): any other is a 422 naming `runnerClass`. */
    readonly runnerClasses: readonly RunnerClassOption[];
}

export const orgExecutorRoutes =
    (deps: OrgExecutorRoutesDeps): FastifyPluginAsync =>
    async (app) => {
        const { orgs } = deps;
        app.get('/api/org/executors', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleListOrgExecutors(orgs, request, reply)
        );
        app.post('/api/org/executors', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handleCreateOrgExecutor(deps, request, reply)
        );
        app.put('/api/org/executors/:id', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handleUpdateOrgExecutor(deps, request, reply)
        );
        app.put('/api/org/executors/default', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handlePutOrgDefault(orgs, request, reply)
        );
        app.delete('/api/org/executors/default', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleClearOrgDefault(orgs, request, reply)
        );
        app.delete('/api/org/executors/:id', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleDeleteOrgExecutor(orgs, request, reply)
        );
        app.post('/api/org/executors/:id/suspension', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleSuspendOrgExecutor(orgs, request, reply)
        );
        app.post('/api/org/executors/:id/scope', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleChangeOrgExecutorScope(orgs, request, reply)
        );
    };
