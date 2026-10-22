import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODES, type ExecutorScope, ORG_SCOPE, USER_SCOPE } from '@factory-ai/core';
import { callerOf, orgOf } from '../auth/plugin.js';
import { bad, badSegment, body as jsonBody, guard } from './helpers.js';
import { executorFieldRefusal, MAX_EXECUTORS_PER_USER, parseExecutorFields } from './executor-fields.js';
import {
    ExecutorDefaultNotFoundError,
    ExecutorSuspendedError,
    type ExecutorProfile,
} from '../db/user-executor-store.js';
import type { UserExecutorStore } from '../db/user-executor-store.js';
import type { OrgRegistry } from '../orgs.js';

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
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
function parseExecutorEntry(entry: unknown): ExecutorEntry | string {
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
    const fields = parseExecutorFields(entry);
    if (typeof fields === 'string') return fields;
    // Optional (issue 440): the edit dialog carries a row's suspension through a rename; an entry
    // that omits it keeps whatever its same-named predecessor carried.
    const { suspended } = entry as { suspended?: unknown };
    if (suspended !== undefined && typeof suspended !== 'boolean') return 'suspended must be a boolean';
    return suspended === undefined ? fields : { ...fields, suspended };
}

/**
 * The authoritative structural validation for a pasted executor list; the client's copy is UX only.
 *
 * No field-level schema inside `config` for now: the contract is "raw JSON the member pastes", and
 * deepening validation belongs to the day an actual consumer exists and can be wrong about the
 * fields. The route guards shape; the check constraints guard the row.
 */
function parseExecutors(raw: unknown): ExecutorEntry[] | string {
    const list = jsonBody(raw).executors;
    if (!Array.isArray(list)) return 'executors must be an array of { name, type, config }';
    if (list.length > MAX_EXECUTORS_PER_USER) {
        return `at most ${MAX_EXECUTORS_PER_USER} executors can be configured at once`;
    }
    const parsed: ExecutorEntry[] = [];
    for (const entry of list) {
        const one = parseExecutorEntry(entry);
        if (typeof one === 'string') return one;
        parsed.push(one);
    }
    return parsed;
}

type ExecutorEntry = {
    name: string;
    type: string;
    config: Record<string, unknown>;
    gateFixRounds: number;
    suspended?: boolean;
};

/** A personal row as the poll and the PUT answer it — never `config`, which may hold credentials. */
function personalRow(row: ExecutorProfile) {
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        createdAt: row.createdAt,
        gateFixRounds: row.gateFixRounds,
        suspended: row.suspended,
    };
}

interface WorkspaceDeps {
    orgs: OrgRegistry;
}

/** The caller's org's executor store, or the reason a route cannot serve them. */
async function runtimeOf(
    orgs: OrgRegistry,
    request: Parameters<typeof callerOf>[0]
): Promise<{ userExecutors: UserExecutorStore | undefined } | { error: string; code: string; status: number }> {
    const rt = await orgs.for(orgOf(request));
    if (!rt) {
        return {
            error: 'No workspace store for this organization',
            code: ERROR_CODES.WORKSPACE_UNAVAILABLE,
            status: HTTP_UNAVAILABLE,
        };
    }
    return { userExecutors: rt.userExecutors };
}

/** `list`'s per-entry name-shape and duplicate-name checks, in one place. */
function validateExecutorList(
    raw: unknown
): { ok: true; value: ExecutorEntry[] } | { ok: false; code: string; message: string } {
    const list = parseExecutors(raw);
    if (typeof list === 'string') {
        return { ok: false, code: executorFieldRefusal(list), message: list };
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
                      executors.resolvedDefault(caller.user.id),
                  ])
                : ([[], [], null] as [ExecutorProfile[], ExecutorProfile[], null])
    );
    if (!loaded.ok) return reply;

    const [executorRows, orgExecutorRows, defaultExecutor] = loaded.value;

    return reply.code(HTTP_OK).send({
        // `config` is deliberately absent from these rows: it may hold credentials the member
        // pasted, and this payload is fetched by a poll that can run every two seconds. The org
        // rows are selection metadata for the same reason — their configuration answers to the
        // admin list, never to the poll every member's browser runs.
        executors: executorRows.map(personalRow),
        orgExecutors: orgExecutorRows.map((row: ExecutorProfile) => ({
            name: row.name,
            type: row.type,
            createdAt: row.createdAt,
            suspended: row.suspended,
        })),
        // The member's resolved default: their stored preference while it still resolves, else the
        // deterministic fallback the store computes — what a new task draft autoselects.
        defaultExecutor,
    });
}

// The edit dialog's opening read: the member's own rows, config included. The poll on
// GET /api/workspace never carries configs — they may hold credentials and that payload is
// fetched every few seconds — so this on-demand read is the one place a client gets them back,
// once per dialog open rather than on a poll.
async function handleGetExecutors(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    const rt = await runtimeOf(deps.orgs, request);
    if ('error' in rt) return bad(reply, rt.code, rt.error, rt.status);
    const { userExecutors: executors } = rt;
    if (!executors) return reply.code(HTTP_UNAVAILABLE).send(NO_EXECUTOR_STORE);

    const loaded = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => executors.listWithConfigs(caller.user.id)
    );
    if (!loaded.ok) return reply;

    return reply.code(HTTP_OK).send({
        executors: loaded.value.map((row) => ({ ...personalRow(row), config: row.config })),
    });
}

// PUT, whole-list replace. The body is the entire list,
// so replaying it after a dropped connection changes nothing.
async function handlePutExecutors(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    const rt = await runtimeOf(deps.orgs, request);
    if ('error' in rt) return bad(reply, rt.code, rt.error, rt.status);
    const { userExecutors: executors } = rt;
    if (!executors) return reply.code(HTTP_UNAVAILABLE).send(NO_EXECUTOR_STORE);

    const parsed = validateExecutorList(request.body);
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);
    const { value: list } = parsed;

    const saved = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () => {
            await executors.replace(caller.user.id, list);
            // Answered from the store, not echoed from the body: created_at is the database's.
            return executors.list(caller.user.id);
        }
    );
    if (!saved.ok) return reply;

    // 200, not 202: nothing runs in the background — the rows are written by the time this returns.
    return reply.code(HTTP_OK).send({ executors: saved.value.map(personalRow) });
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
    return { userId: caller.user.id, executors: rt.userExecutors };
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
        () => ctx.executors.removePersonal(ctx.userId, id)
    );
    if (!removed.ok) return reply;
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
 * The member's default-executor preference (issue 391): names a profile by scope and name, either
 * scope, without touching the shared profile or anyone else's default. The store refuses a
 * preference naming no accessible profile, which is this route's 404 — a selection the caller
 * cannot resolve is not a default they can hold.
 */
async function handlePutDefaultExecutor(deps: WorkspaceDeps, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    const rt = await runtimeOf(deps.orgs, request);
    if ('error' in rt) return bad(reply, rt.code, rt.error, rt.status);
    const { userExecutors: executors } = rt;
    if (!executors) return reply.code(HTTP_UNAVAILABLE).send(NO_EXECUTOR_STORE);

    const fields = jsonBody(request.body);
    const name = fields.executor;
    const scope = fields.executorScope;
    if (typeof name !== 'string' || !name) return bad(reply, ERROR_CODES.BAD_BODY, 'executor must be a string');
    if (scope !== USER_SCOPE && scope !== ORG_SCOPE) {
        return bad(reply, ERROR_CODES.BAD_EXECUTOR_SCOPE, `executorScope must be one of: ${USER_SCOPE}, ${ORG_SCOPE}`);
    }

    // Not under `guard`: a preference naming no accessible profile is a 404 answer, not a
    // failure — the store throws the typed refusal, this route names it; anything else is a real
    // failure and reaches the error handler as one.
    try {
        await executors.setDefault(caller.user.id, { scope: scope as ExecutorScope, name });
    } catch (error) {
        if (error instanceof ExecutorSuspendedError) {
            return bad(
                reply,
                ERROR_CODES.EXECUTOR_SUSPENDED,
                `the ${scope} executor "${name}" is suspended; resume it before making it the default`,
                HTTP_CONFLICT
            );
        }
        if (!(error instanceof ExecutorDefaultNotFoundError)) throw error;
        return bad(
            reply,
            ERROR_CODES.NOT_FOUND,
            `no ${scope} executor named "${name}" is available to you`,
            HTTP_NOT_FOUND
        );
    }
    return reply.code(HTTP_OK).send({ defaultExecutor: { scope, name } });
}

export interface WorkspaceRoutesDeps {
    /** The per-org runtimes; the executor store is the caller's org's. */
    readonly orgs: OrgRegistry;
}

export const workspaceRoutes =
    ({ orgs }: WorkspaceRoutesDeps): FastifyPluginAsync =>
    async (app) => {
        const deps: WorkspaceDeps = { orgs };

        app.get('/api/workspace', (request, reply) => handleGetWorkspace(deps, request, reply));
        app.get('/api/workspace/executors', (request, reply) => handleGetExecutors(deps, request, reply));
        app.put('/api/workspace/executors', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handlePutExecutors(deps, request, reply)
        );
        app.put('/api/workspace/executors/default', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handlePutDefaultExecutor(deps, request, reply)
        );
        app.delete('/api/workspace/executors/:id', (request, reply) => handleDeleteExecutor(deps, request, reply));
        app.post('/api/workspace/executors/:id/suspension', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handleSuspendExecutor(deps, request, reply)
        );
    };
