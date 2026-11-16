import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import { SETUP_ACTIONS, SETUP_STEPS, type SetupAction, type SetupStep } from '../auth/setup-store.js';
import type { AuthStore } from '../auth/store.js';
import { bad, guard, body as jsonBody } from './helpers.js';

/**
 * The member's onboarding progress (docs/auth.md): a step done or skipped, and the flow completed. Each write lands on
 * the caller's own membership in the org it is signed into; the web re-reads `/api/auth/me` after it.
 */

/** A step and an action are two short words. */
const CONTROL_BODY_LIMIT = 1024;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;

const isStep = (value: unknown): value is SetupStep => SETUP_STEPS.includes(value as SetupStep);
const isAction = (value: unknown): value is SetupAction => SETUP_ACTIONS.includes(value as SetupAction);

export const onboardingSetupRoutes =
    ({ store }: { readonly store: AuthStore }): FastifyPluginAsync =>
    async (app) => {
        app.post('/api/onboarding/setup', { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
            const { step, action } = jsonBody(request.body);
            if (!(isStep(step) && isAction(action))) {
                return bad(
                    reply,
                    ERROR_CODES.BAD_BODY,
                    `step must be one of ${SETUP_STEPS.join(', ')} and action one of ${SETUP_ACTIONS.join(', ')}`
                );
            }
            const recorded = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => store.recordSetupStep(caller.org.id, caller.user.id, step, action)
            );
            if (!recorded.ok) return reply;
            return reply.code(HTTP_NO_CONTENT).send();
        });

        app.post('/api/onboarding/setup/complete', { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
            const completed = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => store.completeSetup(caller.org.id, caller.user.id)
            );
            if (!completed.ok) return reply;
            return reply.code(HTTP_NO_CONTENT).send();
        });
    };
