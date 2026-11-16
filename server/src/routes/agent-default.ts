import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODES, EXECUTOR_TYPES, type ExecutorType } from '@factory-ai/core';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { OrgRegistry } from '../orgs.js';
import type { AgentDefault, UserExecutorStore } from '../db/user-executor-store.js';
import { bad, guard } from './helpers.js';

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNAVAILABLE = 503;
/** The body is one agent type and one model name. */
const BODY_LIMIT = 4096;
/** 157_agent_default.sql's `agent_default_model_ck`. */
export const MAX_AGENT_MODEL_LENGTH = 200;
const BODY_KEYS = ['agentType', 'model'];

/** The store and caller every route needs — or null once the refusal is sent. */
async function contextOf(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) {
        bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
        return null;
    }
    const store: UserExecutorStore | undefined = (await orgs.for(orgOf(request)))?.userExecutors;
    if (!store) {
        bad(reply, ERROR_CODES.WORKSPACE_UNAVAILABLE, 'No executor store for this organization', HTTP_UNAVAILABLE);
        return null;
    }
    return { store, userId: caller.user.id };
}

/** The body as an agent default, or the refusal reason. */
function parseAgentDefault(raw: unknown): AgentDefault | { error: string; code: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: 'body must be { agentType, model }', code: ERROR_CODES.BAD_BODY };
    }
    const fields = raw as Record<string, unknown>;
    const extra = Object.keys(fields).find((key) => !BODY_KEYS.includes(key));
    if (extra !== undefined) return { error: `unknown field ${extra}`, code: ERROR_CODES.BAD_BODY };
    if (!(EXECUTOR_TYPES as readonly unknown[]).includes(fields.agentType)) {
        return { error: `agentType must be one of ${EXECUTOR_TYPES.join(', ')}`, code: ERROR_CODES.BAD_EXECUTOR_TYPE };
    }
    const model = typeof fields.model === 'string' ? fields.model.trim() : '';
    if (!model || model.length > MAX_AGENT_MODEL_LENGTH) {
        return {
            error: `model must be a name of 1 to ${MAX_AGENT_MODEL_LENGTH} characters`,
            code: ERROR_CODES.BAD_BODY,
        };
    }
    return { agentType: fields.agentType as ExecutorType, model };
}

async function handleGet(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    // A failed read is a 503, never "no default": the client must not offer to set what may already be set.
    const read = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'agent default read failed'),
        () => ctx.store.agentDefaults(ctx.userId)
    );
    if (!read.ok) return reply;
    return reply.code(HTTP_OK).send(read.value);
}

async function handlePut(orgs: OrgRegistry, owner: 'org' | 'personal', request: FastifyRequest, reply: FastifyReply) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    const parsed = parseAgentDefault(request.body);
    if ('error' in parsed) return bad(reply, parsed.code, parsed.error);
    const saved = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'agent default write failed'),
        () => ctx.store.setAgentDefault(owner === 'org' ? null : ctx.userId, parsed)
    );
    if (!saved.ok) return reply;
    return reply.code(HTTP_OK).send(parsed);
}

async function handleDelete(
    orgs: OrgRegistry,
    owner: 'org' | 'personal',
    request: FastifyRequest,
    reply: FastifyReply
) {
    const ctx = await contextOf(orgs, request, reply);
    if (!ctx) return reply;
    const removed = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'agent default delete failed'),
        () => ctx.store.deleteAgentDefault(owner === 'org' ? null : ctx.userId)
    );
    if (!removed.ok) return reply;
    return reply.code(HTTP_OK).send({ removed: removed.value });
}

/**
 * The agent default: the agent and model a task naming no executor runs on, ahead of the first profile.
 *
 * - `GET /api/agent-default` — `{ org, personal }`, each `{ agentType, model }` or null, for any member.
 * - `PUT` / `DELETE /api/agent-default/org` — the organization's row; `admin` in `ROUTE_CLASSES`, so the auth hook
 *   refuses a member before the handler runs.
 * - `PUT` / `DELETE /api/agent-default/personal` — the caller's own row.
 */
export const agentDefaultRoutes =
    ({ orgs }: { orgs: OrgRegistry }): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/agent-default', { bodyLimit: BODY_LIMIT }, (request, reply) => handleGet(orgs, request, reply));
        for (const owner of ['org', 'personal'] as const) {
            app.put(`/api/agent-default/${owner}`, { bodyLimit: BODY_LIMIT }, (request, reply) =>
                handlePut(orgs, owner, request, reply)
            );
            app.delete(`/api/agent-default/${owner}`, { bodyLimit: BODY_LIMIT }, (request, reply) =>
                handleDelete(orgs, owner, request, reply)
            );
        }
    };
