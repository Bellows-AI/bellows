import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { bad } from './helpers.js';
import { HTTP_UNAVAILABLE, OAUTH_PATHS, cookieSessionOf, noStore, type OAuthRouteDeps } from './oauth-http.js';

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The connected-apps API (docs/auth.md): a member lists and ends the MCP grant families they hold in every
 * organization they belong to. Cookie session only, and route-class `none`, so an MCP token can neither list the
 * grants nor end one. A family that is not the caller's, unknown or already ended is 404 alike.
 */
export const oauthGrantsRoutes =
    (deps: OAuthRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const { oauth } = deps;
        const sessionOf = cookieSessionOf(deps);

        const unconfirmed = (reply: FastifyReply, error: Error) => {
            app.log.error({ err: error }, 'oauth grants could not be confirmed');
            return bad(reply, ERROR_CODES.UNAVAILABLE, 'Try again shortly.', HTTP_UNAVAILABLE);
        };

        app.get(OAUTH_PATHS.grants, async (request, reply) => {
            noStore(reply);
            try {
                const session = await sessionOf(request, reply);
                if (!session) return reply;
                const grants = await oauth.listGrants({ userId: session.caller.user.id });
                return reply.code(HTTP_OK).send({ grants });
            } catch (e) {
                return unconfirmed(reply, e as Error);
            }
        });

        app.post(OAUTH_PATHS.revokeGrant, async (request, reply) => {
            noStore(reply);
            try {
                const session = await sessionOf(request, reply);
                if (!session) return reply;
                const { id } = request.params as { id: string };
                const revoked = UUID.test(id) && (await oauth.revokeGrant({ id, userId: session.caller.user.id }));
                if (!revoked) return bad(reply, ERROR_CODES.NOT_FOUND, 'No such connected app', HTTP_NOT_FOUND);
                return reply.code(HTTP_OK).send({ id, revoked: true });
            } catch (e) {
                return unconfirmed(reply, e as Error);
            }
        });
    };
