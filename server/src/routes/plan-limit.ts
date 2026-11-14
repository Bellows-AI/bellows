import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply } from 'fastify';
import type { PlanLimitError } from '../db/plan-limits.js';

const HTTP_TOO_MANY_REQUESTS = 429;

const MESSAGE: Record<PlanLimitError['limit'], (max: number) => string> = {
    queued: (max) => `The organization's plan allows ${max} queued tasks at once`,
    tokens: (max) =>
        `The organization has used the ${max} tokens its plan allows this period; new tasks are refused until the period renews or the plan changes`,
    storage: (max) =>
        `The organization's plan allows ${max} bytes of stored files and run logs; remove attachments or change the plan`,
};

/** A create or upload the organization's plan refuses: 429 `PLAN_LIMIT`, naming the limit and its value. */
export function sendPlanLimit(reply: FastifyReply, { limit, max }: PlanLimitError): FastifyReply {
    return reply.code(HTTP_TOO_MANY_REQUESTS).send({
        error: MESSAGE[limit](max),
        code: ERROR_CODES.PLAN_LIMIT,
        limit,
        max,
    });
}
