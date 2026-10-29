import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import { UUID } from '../identifiers.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, guard } from './helpers.js';

/**
 * Managed connector connections: which Jira sites an org's tasks may reach, and as whom. This file is who may list or
 * delete one; a connection is made by the OAuth authorization flow (`integrations.ts`), what a task may do with it is
 * the broker's (`connection-credential.ts`), and the token is never in a response.
 */

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

const signInRequired = (reply: FastifyReply) =>
    reply.code(HTTP_UNAUTHORIZED).send({ error: 'Sign in required', code: ERROR_CODES.UNAUTHENTICATED });

/** The most connections one create or follow-up may name. */
export const MAX_TASK_CONNECTIONS = 8;

/**
 * A body's `connections`: an array of at most `MAX_TASK_CONNECTIONS` distinct connection ids (absent or null is
 * none), or the sentence it is refused with. Who may bind each id is the store's (`resolveBindingsInTx`); a
 * skill never names a connection.
 */
export function parseConnectionIds(raw: unknown): string[] | string {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string' && UUID.test(id))) {
        return 'connections must be an array of connection ids';
    }
    if (raw.length > MAX_TASK_CONNECTIONS) return `connections takes at most ${MAX_TASK_CONNECTIONS} ids`;
    if (new Set(raw).size !== raw.length) return 'connections must not repeat an id';
    return raw as string[];
}

/** Destroys the SecretStore secret of a grant a disconnect just revoked; the integration runtime supplies it. */
export type DestroyRevokedSecret = (orgId: string, grantId: string) => Promise<{ ok: boolean; reason?: string }>;

export interface ConnectionRoutesDeps {
    orgs: OrgRegistry;
    destroyRevokedSecret?: DestroyRevokedSecret | undefined;
}

export function connectionRoutes({ orgs, destroyRevokedSecret }: ConnectionRoutesDeps): FastifyPluginAsync {
    /** The caller and their org's store, or the refusal already sent. */
    const resolve = async (request: FastifyRequest, reply: FastifyReply) => {
        const caller = callerOf(request);
        if (!caller) {
            await signInRequired(reply);
            return null;
        }
        const store = (await orgs.for(orgOf(request)))?.connections;
        if (!store) {
            bad(
                reply,
                ERROR_CODES.CONNECTIONS_UNAVAILABLE,
                'No connection store for this organization',
                HTTP_UNAVAILABLE
            );
            return null;
        }
        return { caller, store };
    };

    const remove = async (request: FastifyRequest, reply: FastifyReply) => {
        const ctx = await resolve(request, reply);
        if (!ctx) return reply;
        const id = (request.params as { id: string }).id;
        if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'connection id must be a uuid');
        const removed = await guard(
            reply,
            (e) => request.log.error({ err: e }, 'connection delete failed'),
            () => ctx.store.disconnect(id, { userId: ctx.caller.user.id })
        );
        if (!removed.ok) return reply;
        if (!removed.value.disconnected) {
            return reply
                .code(HTTP_NOT_FOUND)
                .send({ error: 'No such connection you may delete', code: ERROR_CODES.NOT_FOUND });
        }
        const revoked = removed.value.revokedGrantId;
        if (revoked && destroyRevokedSecret) await destroyAfterCommit(request, orgOf(request), revoked);
        return reply.code(HTTP_NO_CONTENT).send();
    };

    /**
     * Best effort, after the disconnect committed: the answer is 204 whatever happens here, because the background
     * recovery pass destroys any revoked grant's secret that this call did not. Logs a closed code, never an error.
     */
    const destroyAfterCommit = async (request: FastifyRequest, orgId: string, grantId: string): Promise<void> => {
        try {
            const result = await destroyRevokedSecret?.(orgId, grantId);
            if (result && !result.ok)
                request.log.warn({ grantId, code: result.reason }, 'grant secret destroy deferred');
        } catch {
            request.log.warn({ grantId, code: 'destroy-threw' }, 'grant secret destroy deferred');
        }
    };

    return async (app) => {
        app.get('/api/connections', async (request, reply) => {
            const ctx = await resolve(request, reply);
            if (!ctx) return reply;
            const listed = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'connection list failed'),
                () => ctx.store.list(ctx.caller.user.id)
            );
            if (!listed.ok) return reply;
            return reply.code(HTTP_OK).send({ connections: listed.value });
        });
        app.delete('/api/connections/:id', remove);
    };
}
