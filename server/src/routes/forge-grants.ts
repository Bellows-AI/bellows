import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { MemberForgeGrants } from '../integrations/member-forge-grant.js';
import { GITHUB_FORGE } from '../integrations/providers/github-user.js';

/**
 * Where the member stands on each forge (docs/connections.md): the Settings card's read. The standing is the grant
 * store's; a read it could not confirm is a 503, never "missing", so a database blip does not send a member whose grant
 * is live to re-authorize. The token is never in a response.
 */

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNAVAILABLE = 503;

/** Where a member lands after reconnecting: the page that shows the card. */
const SETTINGS_INTEGRATIONS_PATH = '/settings/integrations';

export const forgeGrantRoutes =
    ({ memberGrants }: { memberGrants: MemberForgeGrants | undefined }): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/forge-grants', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) {
                return reply
                    .code(HTTP_UNAUTHORIZED)
                    .send({ error: 'Sign in required', code: ERROR_CODES.UNAUTHENTICATED });
            }
            // No grant store (no sign-in to keep one, as under AUTH_MODE=none): there is nothing to report.
            if (!memberGrants) return reply.code(HTTP_OK).send({ grants: [] });
            const orgId = orgOf(request);
            try {
                const standing = await memberGrants.standing(orgId, caller.user.id, GITHUB_FORGE);
                // The reconnect is the sign-in itself: the same silent round trip, which replaces the grant.
                const connectPath = `/api/auth/github?${new URLSearchParams({ returnTo: SETTINGS_INTEGRATIONS_PATH, org: orgId })}`;
                return reply
                    .code(HTTP_OK)
                    .send({ grants: [{ forge: GITHUB_FORGE, login: caller.user.login, standing, connectPath }] });
            } catch (err) {
                request.log.error({ err }, 'forge grant standing read failed');
                return reply
                    .code(HTTP_UNAVAILABLE)
                    .send({ error: 'The GitHub connection could not be read', code: ERROR_CODES.UNAVAILABLE });
            }
        });
    };
