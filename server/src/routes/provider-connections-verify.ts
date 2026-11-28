import { type DeploymentMode, ERROR_CODES, isModelProvider, subscriptionTokenAllowed } from '@factory-ai/core';
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import { createRateLimiter } from '../oauth/rate-limit.js';
import { validBase, validKey } from '../provider-keys/input-rules.js';
import type { ProviderKeys, VerifyInput } from '../provider-keys/verify.js';
import { errorHandler } from './error-handler.js';
import { bad, body as jsonBody } from './helpers.js';

/**
 * `POST /api/provider-connections/verify` (docs/api.md): a member checks a provider key before saving it. The answer is the
 * check's, 200 either way; a refusal here is only for a body the check cannot run on or a member over the limit. The
 * body carries the key, so it is never logged or echoed: a body the parser refuses answers fixed text.
 */

const VERIFY_PATH = '/api/provider-connections/verify';
const PER_MEMBER_PER_WINDOW = 10;
const WINDOW_MS = 60_000;
const BODY_LIMIT = 8192;
const HTTP_TOO_MANY = 429;
const HTTP_FIRST_SERVER_ERROR = 500;
const FIELDS = new Set(['provider', 'key', 'baseUrl']);
const BAD_BODY_MESSAGE = 'The check needs a known provider, a key and, for LiteLLM, an http(s) base URL';

/** The check's input, or null: every field known, a listed provider, a header-safe key, a base URL where one fits. */
function parseVerify(raw: unknown): Omit<VerifyInput, 'subscriptionAllowed'> | null {
    const fields = jsonBody(raw);
    if (Object.keys(fields).some((name) => !FIELDS.has(name))) return null;
    const { provider, key, baseUrl } = fields;
    if (!isModelProvider(provider)) return null;
    if (!validKey(key)) return null;
    if (baseUrl === undefined) return provider === 'litellm' ? null : { provider, key };
    if (provider === 'subscription' || typeof baseUrl !== 'string' || !validBase(baseUrl)) return null;
    return { provider, key, baseUrl };
}

/**
 * A body the parser refused (malformed, too large) answers fixed text: the parser's message may
 * quote the key. The routes that accept a key — this check, the provider setup and the provider
 * connections — share it.
 */
export const refuseUnparsedBody =
    (message: string) =>
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply): FastifyReply =>
        error.statusCode !== undefined && error.statusCode < HTTP_FIRST_SERVER_ERROR
            ? bad(reply, ERROR_CODES.BAD_BODY, message, error.statusCode)
            : errorHandler(error, request, reply);

const refuseUnparsed = refuseUnparsedBody(BAD_BODY_MESSAGE);

export function providerConnectionVerifyRoutes({
    providerKeys,
    deploymentMode,
    cloudSubscriptionOrgIds,
    now = Date.now,
}: {
    providerKeys: ProviderKeys;
    /** With `cloudSubscriptionOrgIds`, whether the caller's org may hold a subscription token. */
    deploymentMode: DeploymentMode;
    cloudSubscriptionOrgIds: ReadonlySet<string>;
    now?: (() => number) | undefined;
}): FastifyPluginAsync {
    return async (app) => {
        const limiter = createRateLimiter({ limit: PER_MEMBER_PER_WINDOW, windowMs: WINDOW_MS, now });
        app.post(VERIFY_PATH, { bodyLimit: BODY_LIMIT, errorHandler: refuseUnparsed }, async (request, reply) => {
            reply.header('cache-control', 'no-store');
            // The slot is spent before anything is parsed or sent: a refused body still counts.
            const caller = callerOf(request);
            const verdict = limiter.hit(caller ? `${caller.org.id}:${caller.user.id}` : orgOf(request));
            if (!verdict.ok) {
                reply.header('retry-after', String(verdict.retryAfterSeconds));
                return bad(reply, ERROR_CODES.RATE_LIMITED, 'Too many key checks; try again shortly', HTTP_TOO_MANY);
            }
            const parsed = parseVerify(request.body);
            if (!parsed) return bad(reply, ERROR_CODES.BAD_BODY, BAD_BODY_MESSAGE);
            const subscriptionAllowed = subscriptionTokenAllowed(
                { deploymentMode, cloudSubscriptionOrgIds },
                orgOf(request)
            );
            const input: VerifyInput = { ...parsed, subscriptionAllowed };
            // The member going away ends the check: the signal reaches the lookup, both requests and every body read.
            const abort = new AbortController();
            reply.raw.once('close', () => {
                if (!reply.raw.writableFinished) abort.abort();
            });
            return reply.send(await providerKeys.verify(input, abort.signal));
        });
    };
}
