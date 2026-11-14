import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { AuthStore } from '../auth/store.js';
import { OPERATOR_ACTIONS, type OrgStatusChange } from '../db/org-status.js';
import { bad, guard } from './helpers.js';

/**
 * The board operator's surface (docs/organizations.md): `GET /api/operator/orgs` lists every organization with its
 * status, and `POST /api/operator/orgs/:id/(suspend|refuse|activate)` moves one, with an `operator` audit row per
 * change. `POST /api/operator/orgs/:id/delete` queues the purge of a suspended or refused org (202; 409 `ORG_ACTIVE`
 * for an active one), which `db/org-purge.ts` carries out. Every route is an `operator` row in ROUTE_CLASSES, so the auth hook refuses anyone `OPERATOR_GITHUB_IDS`
 * does not name before these run.
 */

const HTTP_ACCEPTED = 202;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** The answer to one operator action: the change, 404 for an unknown org, 409 for a suspend of a refused one. */
function answer(reply: FastifyReply, id: string, change: OrgStatusChange) {
    if (change.outcome === 'missing') {
        return bad(reply, ERROR_CODES.NOT_FOUND, `No organization '${id}'`, HTTP_NOT_FOUND);
    }
    if (change.outcome === 'refused') {
        return reply.code(HTTP_CONFLICT).send({
            error: 'A refused organization is reactivated before it is suspended',
            code: ERROR_CODES.ORG_INACTIVE,
            status: change.org.status,
        });
    }
    return { changed: change.outcome === 'changed', org: change.org };
}

export const operatorRoutes =
    ({ store }: { store: AuthStore }): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/operator/orgs', async (request, reply) => {
            const listed = await guard(
                reply,
                (e) => request.log.error(e),
                () => store.listOrganizations()
            );
            if (listed.ok) return { orgs: listed.value };
        });

        for (const action of OPERATOR_ACTIONS) {
            app.post<{ Params: { id: string } }>(`/api/operator/orgs/:id/${action}`, async (request, reply) => {
                const caller = callerOf(request);
                if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
                const { id } = request.params;
                const done = await guard(
                    reply,
                    (e) => request.log.error(e),
                    () => store.setOrgStatus(id, action, caller.user.id)
                );
                if (!done.ok) return;
                return answer(reply, id, done.value);
            });
        }

        app.post<{ Params: { id: string } }>('/api/operator/orgs/:id/delete', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
            const { id } = request.params;
            const done = await guard(
                reply,
                (e) => request.log.error(e),
                () => store.requestOrgDelete(id, caller.user.id)
            );
            if (!done.ok) return;
            const asked = done.value;
            if (asked.outcome === 'missing') {
                return bad(reply, ERROR_CODES.NOT_FOUND, `No organization '${id}'`, HTTP_NOT_FOUND);
            }
            if (asked.outcome === 'active') {
                return reply.code(HTTP_CONFLICT).send({
                    error: 'An active organization is suspended or refused before it is deleted',
                    code: ERROR_CODES.ORG_ACTIVE,
                    status: asked.org.status,
                });
            }
            return reply.code(HTTP_ACCEPTED).send({ requested: asked.outcome === 'requested', org: asked.org });
        });
    };
