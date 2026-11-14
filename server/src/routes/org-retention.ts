import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, guard } from './helpers.js';

/**
 * `GET /api/org/retention`: the caller's organization's retention window (`db/org-retention.ts`), `days` null for
 * unlimited, and a lower window with the moment it applies while its notice runs. Any member reads it.
 */

const HTTP_UNAUTHORIZED = 401;
const HTTP_UNAVAILABLE = 503;

export const orgRetentionRoutes =
    ({ orgs }: { orgs: OrgRegistry }): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/org/retention', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
            const retention = (await orgs.for(caller.org.id))?.retention;
            if (!retention) {
                return bad(
                    reply,
                    ERROR_CODES.WORKSPACE_UNAVAILABLE,
                    'No retention for this organization',
                    HTTP_UNAVAILABLE
                );
            }
            const read = await guard(reply, (e) => request.log.error({ err: e }, 'retention read failed'), retention);
            if (!read.ok) return reply;
            return reply.send(read.value);
        });
    };
