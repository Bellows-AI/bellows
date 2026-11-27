import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
    type DeploymentMode,
    ERROR_CODES,
    executorConnectionFields,
    type ProviderConnectionMeta,
    subscriptionTokenAllowed,
} from '@factory-ai/core';
import { isBridged } from '../auth/bridge-binding.js';
import { callerOf, orgOf } from '../auth/plugin.js';
import { bad, badSegment, body as jsonBody, guard } from './helpers.js';
import {
    executorFieldRefusal,
    executorFieldStatus,
    HTTP_CONNECTION_REFUSED,
    isConnectionRefusal,
    lifecycleRefusal,
    selectionRefusal,
    MAX_EXECUTORS_PER_USER,
    parseExecutorFields,
    parseExecutorId,
    personalRunnerClassRefusal,
    visibleConnections,
} from './executor-fields.js';
import {
    ConfiguredDefaultUnusableError,
    type DefaultSelection,
    type ExecutorProfile,
    type ResolvedDefault,
} from '../db/user-executor-store.js';
import type { UserExecutorStore } from '../db/user-executor-store.js';
import type { ProviderConnectionStore } from '../db/provider-connection-store.js';
import type { RunnerClassOption } from '../config-runner-classes.js';
import type { OrgRegistry } from '../orgs.js';
import { agentDefaultRoutes } from './agent-default.js';

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

const BYTES_PER_KIB = 1024;
const BODY_LIMIT_KIB = 64;
const BODY_LIMIT = BODY_LIMIT_KIB * BYTES_PER_KIB;

/**
 * One PERSONAL executor entry: the shared fields plus the tamper refusals. The personal PUT writes
 * the caller's own rows and nothing else — an entry claiming an org scope, another owner or the
 * old default flag is refused loudly rather than rewritten (issue 391): scope and ownership are
 * decided by the route, never by the body.
 */
function parseExecutorEntry(
    entry: unknown,
    deploymentMode: DeploymentMode,
    subscriptionAllowed: boolean
): ExecutorEntry | string {
    const item = entry as {
        scope?: unknown;
        userId?: unknown;
        isDefault?: unknown;
        name?: unknown;
    };
    if (item?.scope !== undefined) {
        return 'scope in a personal entry is an organization tamper attempt; organization profiles are managed through /api/org/executors';
    }
    if (item?.userId !== undefined) {
        return 'userId in a personal entry is an ownership tamper attempt';
    }
    if (item?.isDefault !== undefined) {
        return 'isDefault is set through PUT /api/workspace/executors/default, not on the row';
    }
    const fields = parseExecutorFields(entry, deploymentMode, subscriptionAllowed);
    if (typeof fields === 'string') return fields;
    const id = parseExecutorId(entry);
    if (typeof id === 'object') return id.refusal;
    const classRefusal = personalRunnerClassRefusal(fields.runnerClass);
    if (classRefusal) return classRefusal;
    // Optional (issue 440): the edit dialog carries a row's suspension through a rename; an entry
    // that omits it keeps whatever its same-named predecessor carried.
    const { suspended } = entry as { suspended?: unknown };
    if (suspended !== undefined && typeof suspended !== 'boolean') return 'suspended must be a boolean';
    return { ...fields, ...(id === undefined ? {} : { id }), ...(suspended === undefined ? {} : { suspended }) };
}

/**
 * The authoritative structural validation for a pasted executor list; the client's copy is UX only.
 *
 * No field-level schema inside `config` for now: the contract is "raw JSON the member pastes", and
 * deepening validation belongs to the day an actual consumer exists and can be wrong about the
 * fields. The route guards shape; the check constraints guard the row.
 */
function parseExecutors(
    raw: unknown,
    deploymentMode: DeploymentMode,
    subscriptionAllowed: boolean
): ExecutorEntry[] | string {
    const list = jsonBody(raw).executors;
    if (!Array.isArray(list)) return 'executors must be an array of { name, type, config }';
    if (list.length > MAX_EXECUTORS_PER_USER) {
        return `at most ${MAX_EXECUTORS_PER_USER} executors can be configured at once`;
    }
    const parsed: ExecutorEntry[] = [];
    for (const entry of list) {
        const one = parseExecutorEntry(entry, deploymentMode, subscriptionAllowed);
        if (typeof one === 'string') return one;
        parsed.push(one);
    }
    return parsed;
}

type ExecutorEntry = {
    id?: string;
    name: string;
    type: string;
    config: Record<string, unknown>;
    gateFixRounds: number;
    suspended?: boolean;
    providerConnectionId?: string | null;
};

/**
 * The connection fields a row carries when the read knows the caller's visible connections: the name, provider and
 * scope beside the id, and whether the pasted config overrides the connection. Safe metadata only (docs/api.md).
 */
function connectionFields(row: ExecutorProfile, visible: ReadonlyMap<string, ProviderConnectionMeta> | undefined) {
    if (visible === undefined) return {};
    return {
        ...executorConnectionFields(row.providerConnectionId, visible),
        configOverridesConnection: row.configOverridesConnection === true,
    };
}

/** A personal row as the poll and the PUT answer it — never `config`, which may hold credentials. */
function personalRow(row: ExecutorProfile, visible?: ReadonlyMap<string, ProviderConnectionMeta>) {
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        createdAt: row.createdAt,
        gateFixRounds: row.gateFixRounds,
        suspended: row.suspended,
        providerConnectionId: row.providerConnectionId,
        ...connectionFields(row, visible),
    };
}

/** `resolvedDefault`, with a configured default that cannot run now answered as itself rather than failing the poll. */
async function resolvedOrUnusable(
    executors: Pick<UserExecutorStore, 'resolvedDefault'>,
    userId: string
): Promise<ResolvedDefault | ConfiguredDefaultUnusableError | null> {
    try {
        return await executors.resolvedDefault(userId);
    } catch (error) {
        if (error instanceof ConfiguredDefaultUnusableError) return error;
        throw error;
    }
}

interface WorkspaceDeps {
    orgs: OrgRegistry;
    runnerClasses: readonly RunnerClassOption[];
    deploymentMode: DeploymentMode;
    cloudSubscriptionOrgIds: ReadonlySet<string>;
}

/** The caller's org's executor store, or the reason a route cannot serve them. */
async function runtimeOf(
    orgs: OrgRegistry,
    request: Parameters<typeof callerOf>[0]
): Promise<
    | { userExecutors: UserExecutorStore | undefined; providerConnections: ProviderConnectionStore | undefined }
    | { error: string; code: string; status: number }
> {
    const rt = await orgs.for(orgOf(request));
    if (!rt) {
        return {
            error: 'No workspace store for this organization',
            code: ERROR_CODES.WORKSPACE_UNAVAILABLE,
            status: HTTP_UNAVAILABLE,
        };
    }
    return { userExecutors: rt.userExecutors, providerConnections: rt.providerConnections };
}

/** `list`'s per-entry name-shape and duplicate-name checks, in one place. */
function validateExecutorList(
    raw: unknown,
    deploymentMode: DeploymentMode,
    subscriptionAllowed: boolean
): { ok: true; value: ExecutorEntry[] } | { ok: false; code: string; message: string; status?: number | undefined } {
    const list = parseExecutors(raw, deploymentMode, subscriptionAllowed);
    if (typeof list === 'string') {
        return { ok: false, code: executorFieldRefusal(list), message: list, status: executorFieldStatus(list) };
    }
    for (const executor of list) {
        const reason = badSegment('name', executor.name);
        if (reason) {
            return {
                ok: false,
                code: ERROR_CODES.BAD_EXECUTOR_NAME,
                message: `"${executor.name}" cannot be used as an executor name: ${reason}`,
            };
        }
    }
    // A duplicate name in one body would otherwise surface as a primary-key violation, which the
    // member would see as a 503.
    const names = new Set(list.map((executor) => executor.name));
    if (names.size !== list.length) {
        return { ok: false, code: ERROR_CODES.EXECUTOR_NAME_CONFLICT, message: 'executor names must be unique' };
    }
    return { ok: true, value: list };
}

const NO_EXECUTOR_STORE = {
    error: 'No executor store is configured for this deployment',
    code: ERROR_CODES.UNAVAILABLE,
};

async function handleGetWorkspace(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);

    const rt = await runtimeOf(deps.orgs, request);
    if ('error' in rt) return bad(reply, rt.code, rt.error, rt.status);
    const { userExecutors: executors } = rt;

    const loaded = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () =>
            executors
                ? Promise.all([
                      executors.list(caller.user.id),
                      executors.listOrg(),
                      resolvedOrUnusable(executors, caller.user.id),
                      visibleConnections(rt.providerConnections, caller.user.id),
                      executors.selectedDefault(null),
                  ])
                : ([[], [], null, new Map(), null] as [
                      ExecutorProfile[],
                      ExecutorProfile[],
                      ResolvedDefault | ConfiguredDefaultUnusableError | null,
                      ReadonlyMap<string, ProviderConnectionMeta>,
                      DefaultSelection | null,
                  ])
    );
    if (!loaded.ok) return reply;

    const [executorRows, orgExecutorRows, resolvedOrRefused, visible, orgDefault] = loaded.value;
    const unusable = resolvedOrRefused instanceof ConfiguredDefaultUnusableError ? resolvedOrRefused : null;
    const resolved = resolvedOrRefused instanceof ConfiguredDefaultUnusableError ? null : resolvedOrRefused;

    return reply.code(HTTP_OK).send({
        // `config` is deliberately absent from these rows: it may hold credentials the member
        // pasted, and this payload is fetched by a poll that can run every two seconds. The org
        // rows are selection metadata for the same reason — their configuration answers to the
        // admin list, never to the poll every member's browser runs.
        executors: executorRows.map((row) => personalRow(row, visible)),
        orgExecutors: orgExecutorRows.map((row: ExecutorProfile) => ({
            id: row.id,
            name: row.name,
            type: row.type,
            createdAt: row.createdAt,
            suspended: row.suspended,
            runnerClass: row.runnerClass,
            // Whether the organization's configured default names this row: the admin's Clear action reads it.
            orgDefault: orgDefault?.executorId === row.id,
            providerConnectionId: row.providerConnectionId,
            ...connectionFields(row, visible),
        })),
        // The member's resolved default: their stored preference while it still resolves, else the
        // deterministic fallback the store computes — what a new task draft autoselects. When an agent default wins,
        // no profile is the default: `agentDefault` names the agent, the model and whose row it is.
        // A configured default that cannot run now (suspended) is still named, with the reason: the poll never invents
        // another default in its place.
        defaultExecutor: unusable
            ? { scope: unusable.scope, name: unusable.executorName, unusable: unusable.reason }
            : resolved?.kind === 'profile'
              ? { scope: resolved.scope, name: resolved.name }
              : null,
        agentDefault:
            resolved?.kind === 'agent'
                ? { agentType: resolved.agentType, model: resolved.model, from: resolved.from }
                : null,
        // False where this board has no executor store: the empty lists above are then "nothing was read",
        // which a client that must not report a confirmed "none" (the MCP list_executors tool) can tell apart.
        executorsAvailable: executors !== undefined,
    });
}

// The edit dialog's opening read: the member's own rows, config included. The poll on
// GET /api/workspace never carries configs — they may hold credentials and that payload is
// fetched every few seconds — so this on-demand read is the one place a client gets them back,
// once per dialog open rather than on a poll.
async function handleGetExecutors(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await personalExecutorContext(deps, request, reply);
    if (!ctx) return reply;
    const { userId, executors } = ctx;

    const loaded = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () =>
            Promise.all([executors.listWithConfigs(userId), visibleConnections(ctx.providerConnections, userId)])
    );
    if (!loaded.ok) return reply;
    const [rows, visible] = loaded.value;

    return reply.code(HTTP_OK).send({
        // A bridged (MCP) caller never reads the configuration, which may hold provider credentials.
        executors: rows.map((row) =>
            isBridged(request.raw) ? personalRow(row, visible) : { ...personalRow(row, visible), config: row.config }
        ),
        // The classes an org profile may name (RUNNER_CLASSES), each with whether it gets a docker daemon.
        runnerClasses: deps.runnerClasses,
    });
}

// PUT, whole-list replace. The body is the entire list,
// so replaying it after a dropped connection changes nothing.
async function handlePutExecutors(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await personalExecutorContext(deps, request, reply);
    if (!ctx) return reply;
    const { userId, executors } = ctx;

    const parsed = validateExecutorList(
        request.body,
        deps.deploymentMode,
        subscriptionTokenAllowed(deps, orgOf(request))
    );
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message, parsed.status);
    const { value: list } = parsed;

    const saved = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () => {
            try {
                await executors.replace(userId, list);
            } catch (error) {
                if (isConnectionRefusal(error) || lifecycleRefusal(error)) return { refused: error as Error };
                throw error;
            }
            // Answered from the store, not echoed from the body: created_at is the database's.
            return { rows: await executors.list(userId) };
        }
    );
    if (!saved.ok) return reply;
    if ('refused' in saved.value) {
        const { refused } = saved.value;
        if (isConnectionRefusal(refused)) {
            return bad(reply, ERROR_CODES.PROVIDER_CONNECTION_REFUSED, refused.message, HTTP_CONNECTION_REFUSED);
        }
        const refusal = lifecycleRefusal(refused)!;
        return bad(reply, refusal.code, refusal.message, refusal.status);
    }

    // 200, not 202: nothing runs in the background — the rows are written by the time this returns.
    return reply.code(HTTP_OK).send({ executors: saved.value.rows.map((row) => personalRow(row)) });
}

/** Resolves the caller and the executor store the personal by-id routes share. */
async function personalExecutorContext(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) {
        bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
        return null;
    }
    const rt = await runtimeOf(deps.orgs, request);
    if ('error' in rt) {
        bad(reply, rt.code, rt.error, rt.status);
        return null;
    }
    if (!rt.userExecutors) {
        reply.code(HTTP_UNAVAILABLE).send(NO_EXECUTOR_STORE);
        return null;
    }
    return { userId: caller.user.id, executors: rt.userExecutors, providerConnections: rt.providerConnections };
}

/**
 * Removes ONE of the caller's own personal profiles by id (issue 440). Unlike the whole-list PUT it
 * cannot clobber a row the caller's page never saw; another member's id, an org id and an unknown id
 * all answer the same 404.
 */
async function handleDeleteExecutor(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await personalExecutorContext(deps, request, reply);
    if (!ctx) return reply;
    const { id } = request.params as { id?: string };
    if (typeof id !== 'string' || !id) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a string');
    const removed = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () => {
            try {
                return await ctx.executors.removePersonal(ctx.userId, id);
            } catch (error) {
                // A default still names it: the caller clears or replaces the default first.
                const refusal = lifecycleRefusal(error);
                if (refusal) return refusal;
                throw error;
            }
        }
    );
    if (!removed.ok) return reply;
    if (typeof removed.value === 'object') {
        return bad(reply, removed.value.code, removed.value.message, removed.value.status);
    }
    if (!removed.value) return reply.code(HTTP_NOT_FOUND).send({ error: 'No such executor' });
    return reply.code(HTTP_OK).send({ id, removed: true });
}

/** Suspends or resumes one of the caller's own personal profiles by id (issue 440). */
async function handleSuspendExecutor(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await personalExecutorContext(deps, request, reply);
    if (!ctx) return reply;
    const { id } = request.params as { id?: string };
    if (typeof id !== 'string' || !id) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a string');
    const { suspended } = jsonBody(request.body);
    if (typeof suspended !== 'boolean') return bad(reply, ERROR_CODES.BAD_BODY, 'suspended must be a boolean');
    const updated = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => ctx.executors.setPersonalSuspended(ctx.userId, id, suspended)
    );
    if (!updated.ok) return reply;
    if (!updated.value) return reply.code(HTTP_NOT_FOUND).send({ error: 'No such executor' });
    return reply.code(HTTP_OK).send(personalRow(updated.value));
}

/**
 * Configures the member's default executor by the profile's stable id (`{ executorId }`): a rename never severs it, and
 * it outranks the legacy preference and the fallback chain. Every default write names an id; a body without one is a
 * 400. The store refuses a profile the caller may not select; its typed refusals are 404 and 409 answers, not failures.
 */
type PersonalContext = NonNullable<Awaited<ReturnType<typeof personalExecutorContext>>>;

async function putDefaultById({ userId, executors }: PersonalContext, reply: FastifyReply, executorId: unknown) {
    if (typeof executorId !== 'string' || !executorId) {
        return bad(reply, ERROR_CODES.BAD_BODY, 'executorId must be a string');
    }
    try {
        const selected = await executors.selectDefault(userId, executorId);
        return reply.code(HTTP_OK).send({ defaultExecutor: { scope: selected.scope, name: selected.name } });
    } catch (error) {
        const refused = selectionRefusal(reply, error, `executor "${executorId}"`);
        if (refused) return refused;
        throw error;
    }
}

async function handlePutDefaultExecutor(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await personalExecutorContext(deps, request, reply);
    if (!ctx) return reply;
    return putDefaultById(ctx, reply, jsonBody(request.body).executorId);
}

/** Clears the member's configured default; the organization's, then the legacy chain, apply again. */
async function handleClearDefaultExecutor(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await personalExecutorContext(deps, request, reply);
    if (!ctx) return reply;
    const cleared = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => ctx.executors.clearDefault(ctx.userId)
    );
    if (!cleared.ok) return reply;
    return reply.code(HTTP_OK).send({ cleared: cleared.value });
}

export interface WorkspaceRoutesDeps {
    /** The per-org runtimes; the executor store is the caller's org's. */
    readonly orgs: OrgRegistry;
    /** `config.deploymentMode`: cloud refuses a Claude subscription OAuth token in a config. */
    readonly deploymentMode: DeploymentMode;
    /** `config.cloudSubscriptionOrgIds`: the cloud orgs exempt from that refusal (`subscriptionTokenAllowed`). */
    readonly cloudSubscriptionOrgIds: ReadonlySet<string>;
    /** The board's runner classes (RUNNER_CLASSES), listed for the executor dialog. */
    readonly runnerClasses: readonly RunnerClassOption[];
}

export const workspaceRoutes =
    ({ orgs, deploymentMode, cloudSubscriptionOrgIds, runnerClasses }: WorkspaceRoutesDeps): FastifyPluginAsync =>
    async (app) => {
        const deps: WorkspaceDeps = { orgs, deploymentMode, cloudSubscriptionOrgIds, runnerClasses };

        app.get('/api/workspace', (request, reply) => handleGetWorkspace(deps, request, reply));
        app.get('/api/workspace/executors', (request, reply) => handleGetExecutors(deps, request, reply));
        app.put('/api/workspace/executors', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handlePutExecutors(deps, request, reply)
        );
        app.put('/api/workspace/executors/default', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handlePutDefaultExecutor(deps, request, reply)
        );
        app.delete('/api/workspace/executors/default', (request, reply) =>
            handleClearDefaultExecutor(deps, request, reply)
        );
        app.delete('/api/workspace/executors/:id', (request, reply) => handleDeleteExecutor(deps, request, reply));
        app.post('/api/workspace/executors/:id/suspension', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handleSuspendExecutor(deps, request, reply)
        );
        // The agent default sits beside the executor profiles it is resolved with.
        await app.register(agentDefaultRoutes({ orgs }));
    };
