import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ADMIN_ROLE, ERROR_CODES } from '@factory-ai/core';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { ConnectorRegistry } from '../notifications/connector.js';
import { parseSubscriptionFields } from '../notifications/subscription-fields.js';
import type { NotificationSubscriptionStore } from '../notifications/subscription-store.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, guard } from './helpers.js';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CREATED = 201;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

const BYTES_PER_KIB = 1024;
const BODY_LIMIT_KIB = 64;
const BODY_LIMIT = BODY_LIMIT_KIB * BYTES_PER_KIB;
const CONTROL_BODY_LIMIT = 4096;

const PATH = '/api/org/notification-subscriptions';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Gate = { store: NotificationSubscriptionStore } | null;

/**
 * Store (503) then caller (401), then, for a write, admin (403). Answers the refusal itself and
 * returns null; a member may read, only an admin writes.
 */
async function gate(
    orgs: OrgRegistry,
    request: FastifyRequest,
    reply: FastifyReply,
    { write }: { write: boolean }
): Promise<Gate> {
    const store = (await orgs.for(orgOf(request)))?.notificationSubscriptions;
    if (!store) {
        bad(reply, ERROR_CODES.WORKSPACE_UNAVAILABLE, 'No subscription store for this organization', HTTP_UNAVAILABLE);
        return null;
    }
    const caller = callerOf(request);
    if (!caller) {
        bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
        return null;
    }
    if (write && caller.role !== ADMIN_ROLE) {
        bad(
            reply,
            ERROR_CODES.FORBIDDEN,
            'Only an organization admin can manage notification subscriptions',
            HTTP_FORBIDDEN
        );
        return null;
    }
    return { store };
}

const log = (request: FastifyRequest) => (e: Error) => request.log.error({ err: e });

const noSuchSubscription = (reply: FastifyReply) =>
    reply.code(HTTP_NOT_FOUND).send({ error: 'No such notification subscription' });

/** An id that cannot be a uuid names no row; asking Postgres would raise 22P02 and read as a 503. */
function idOf(request: FastifyRequest): string | null {
    const { id } = request.params as { id?: string };
    return typeof id === 'string' && UUID.test(id) ? id : null;
}

export const notificationSubscriptionRoutes =
    ({ orgs, connectors }: { orgs: OrgRegistry; connectors: ConnectorRegistry }): FastifyPluginAsync =>
    async (app) => {
        app.get(PATH, { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
            const ctx = await gate(orgs, request, reply, { write: false });
            if (!ctx) return reply;
            const loaded = await guard(reply, log(request), () => ctx.store.list());
            if (!loaded.ok) return reply;
            return reply.code(HTTP_OK).send({ subscriptions: loaded.value });
        });

        app.post(PATH, { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const ctx = await gate(orgs, request, reply, { write: true });
            if (!ctx) return reply;
            const parsed = parseSubscriptionFields(request.body, connectors);
            if (!parsed.ok) return refusal(reply, parsed);
            const saved = await guard(reply, log(request), () => ctx.store.create(parsed.fields));
            if (!saved.ok) return reply;
            return reply.code(HTTP_CREATED).send(saved.value);
        });

        app.put(`${PATH}/:id`, { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const ctx = await gate(orgs, request, reply, { write: true });
            if (!ctx) return reply;
            const id = idOf(request);
            if (!id) return noSuchSubscription(reply);
            const parsed = parseSubscriptionFields(request.body, connectors);
            if (!parsed.ok) return refusal(reply, parsed);
            const saved = await guard(reply, log(request), () => ctx.store.update(id, parsed.fields));
            if (!saved.ok) return reply;
            if (!saved.value) return noSuchSubscription(reply);
            return reply.code(HTTP_OK).send(saved.value);
        });

        app.delete(`${PATH}/:id`, { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
            const ctx = await gate(orgs, request, reply, { write: true });
            if (!ctx) return reply;
            const id = idOf(request);
            if (!id) return noSuchSubscription(reply);
            const removed = await guard(reply, log(request), () => ctx.store.remove(id));
            if (!removed.ok) return reply;
            if (!removed.value) return noSuchSubscription(reply);
            return reply.code(HTTP_OK).send({ id, removed: true });
        });
    };

function refusal(reply: FastifyReply, parsed: { code: string; message: string; problems?: string[] }) {
    if (!parsed.problems) return bad(reply, parsed.code, parsed.message);
    return reply.code(HTTP_BAD_REQUEST).send({ error: parsed.message, code: parsed.code, problems: parsed.problems });
}
