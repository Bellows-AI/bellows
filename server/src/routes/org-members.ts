import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODES, ROLES, type Role } from '@factory-ai/core';
import { callerOf } from '../auth/plugin.js';
import type { AuthStore } from '../auth/store.js';
import { UUID } from '../identifiers.js';
import { bad, body as jsonBody, guard } from './helpers.js';

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** No payload past a role word needs more than a control route's headroom. */
const CONTROL_BODY_LIMIT = 4096;

/** A body's role word is a `Role` only when the check constraint in 010_auth.sql would take it. */
const isRole = (value: unknown): value is Role => ROLES.some((candidate) => candidate === value);

/**
 * Organization membership (issue 410): the administrator's view of the roster and the one write
 * it takes — set a member's role. The org is the caller's; another org's member is not
 * addressable through this surface at all. A person's surface, like the org-executor routes it
 * mirrors — the board secret never gets past the auth wall here, because who holds `admin` is a
 * human decision, and an `oat_` names no person.
 *
 * Both routes are `admin` rows in `ROUTE_CLASSES`; the auth hook refuses a member before they run.
 *
 * - `GET /api/org/members` — the caller's org's roster, login-ordered.
 * - `PUT /api/org/members/:userId/role` — body `{ role }`. A demotion that would
 *   leave the org with no admin is refused (`409 LAST_ADMIN`) — an org with no admin is the
 *   bootstrap hole this closes, not a state to reach through the API.
 */
export const orgMemberRoutes =
    ({ store }: { store: AuthStore }): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/org/members', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleListMembers(store, request, reply)
        );
        app.put('/api/org/members/:userId/role', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleSetMemberRole(store, request, reply)
        );
    };

async function handleListMembers(store: AuthStore, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    const loaded = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.listMembers(caller.org.id)
    );
    if (!loaded.ok) return reply;
    return reply.code(HTTP_OK).send({ members: loaded.value });
}

async function handleSetMemberRole(store: AuthStore, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    const { userId } = request.params as { userId?: string };
    if (typeof userId !== 'string' || !UUID.test(userId)) {
        return bad(reply, ERROR_CODES.BAD_ID, 'userId must be a uuid');
    }

    const role = jsonBody(request.body).role;
    if (!isRole(role)) {
        return bad(reply, ERROR_CODES.BAD_ROLE, `role must be one of: ${ROLES.join(', ')}`);
    }

    const written = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.setMemberRole(caller.org.id, userId, role)
    );
    if (!written.ok) return reply;
    if (written.value === 'missing') {
        return bad(reply, ERROR_CODES.NOT_FOUND, 'No such member of this organization', HTTP_NOT_FOUND);
    }
    // The one refusal with its own code: an org with no admin can only be fixed by SQL again,
    // which is the hole issue 410 closes — so the API never opens it.
    if (written.value === 'last-admin') {
        return bad(reply, ERROR_CODES.LAST_ADMIN, 'An organization must keep at least one admin', HTTP_CONFLICT);
    }
    return reply.code(HTTP_OK).send({ userId, role });
}
