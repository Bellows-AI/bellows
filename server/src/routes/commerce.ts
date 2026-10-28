import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { orgOf } from '../auth/plugin.js';
import {
    type CommercePlanWriter,
    PLANS,
    type PlanName,
    type PlanPush,
    type PlanVerdict,
} from '../db/commerce-plan-writer.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, body, guard } from './helpers.js';

/**
 * The commerce surface (094; docs/commerce.md), registered only when COMMERCE_ENABLED. `GET` is a member's
 * read of their own org's pushed plan; `PUT` is the commerce service's push, behind its own credential
 * (`enforceCommerce`). A 200 on the push means the plan committed; a lost 200 is safe because the
 * service's retry answers 200 too.
 */

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const BODY_LIMIT = 4096;

/** `organization_id_ck` (010) restated: the writer would only fail on it, and a 400 names the cause. */
const ORG_ID = /^[a-z0-9][a-z0-9_-]{0,38}$/;
const BODY_FIELDS = ['plan', 'includedMinutes', 'usedMinutes', 'periodStart', 'periodEnd', 'version'];

const isMinutes = (value: unknown): value is number | null =>
    value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

function dateOrNull(value: unknown): Date | null | undefined {
    if (value === null) return null;
    if (typeof value !== 'string') return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The push, or the reason the body is not one. Every field is required; the four optional ones may be null. */
function parsePush(raw: unknown): PlanPush | string {
    const fields = body(raw);
    const unknown = Object.keys(fields).find((key) => !BODY_FIELDS.includes(key));
    if (unknown) return `Unknown field "${unknown}"`;
    const { plan, includedMinutes, usedMinutes, periodStart, periodEnd, version } = fields;
    if (typeof plan !== 'string' || !PLANS.includes(plan as PlanName)) return `plan must be one of ${PLANS.join(', ')}`;
    if (!isMinutes(includedMinutes)) return 'includedMinutes must be a non-negative integer or null';
    if (!isMinutes(usedMinutes)) return 'usedMinutes must be a non-negative integer or null';
    const start = dateOrNull(periodStart);
    const end = dateOrNull(periodEnd);
    if (start === undefined) return 'periodStart must be an ISO date string or null';
    if (end === undefined) return 'periodEnd must be an ISO date string or null';
    if (start && end && end < start) return 'periodEnd must not be before periodStart';
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
        return 'version must be a positive integer';
    }
    return { plan: plan as PlanName, includedMinutes, usedMinutes, periodStart: start, periodEnd: end, version };
}

/** The writer's verdict as the service sees it: 200 once committed (or already stored), else why not. */
function answerVerdict(reply: FastifyReply, result: PlanVerdict, version: number): FastifyReply {
    if (result.verdict === 'unknown_org') {
        return bad(reply, ERROR_CODES.UNKNOWN_ORG, 'No such organization', HTTP_NOT_FOUND);
    }
    if (result.verdict === 'stale') {
        return reply.code(HTTP_CONFLICT).send({
            stored: false,
            version: result.currentVersion,
            error: 'A newer or different plan is already stored for this version',
        });
    }
    return reply.code(HTTP_OK).send({ stored: true, version });
}

export const commerceRoutes =
    ({ orgs, writer }: { orgs: OrgRegistry; writer: CommercePlanWriter }): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/commerce', async (request, reply) => {
            const runtime = await orgs.for(orgOf(request));
            if (!runtime?.commerce) {
                return bad(reply, ERROR_CODES.UNAVAILABLE, 'No commerce store for this organization', HTTP_UNAVAILABLE);
            }
            const { commerce } = runtime;
            const read = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => commerce.read()
            );
            if (!read.ok) return reply;
            return reply.code(HTTP_OK).send(read.value);
        });

        app.put<{ Params: { orgId: string } }>(
            '/api/commerce/orgs/:orgId/plan',
            { bodyLimit: BODY_LIMIT },
            async (request, reply) => {
                const { orgId } = request.params;
                if (!ORG_ID.test(orgId) || orgId.startsWith('__')) {
                    return bad(reply, ERROR_CODES.BAD_ORG, 'Malformed organization id');
                }
                const push = parsePush(request.body);
                if (typeof push === 'string') return bad(reply, ERROR_CODES.BAD_BODY, push);

                const stored = await guard(
                    reply,
                    (e) => request.log.error({ err: e }),
                    () => writer.put(orgId, push)
                );
                return stored.ok ? answerVerdict(reply, stored.value, push.version) : reply;
            }
        );
    };
