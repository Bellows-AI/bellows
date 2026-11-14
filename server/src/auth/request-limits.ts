/**
 * The human request rate: a fixed window per credential and per organization, in this process only (the limiter is
 * per replica, docs/limits.md). It runs after the auth hook, so both keys are what the hook authenticated — never a
 * header, a query or a body the client chose.
 *
 * Only human routes count (`user` and `mcp`). The worker, branch, ingest, connector and commerce routes are the ones
 * a running task, a driver or a webhook depends on; a 429 there could cost a task its lease, so they are never
 * counted. A bridged request (an MCP tool calling a human route in-process) is not counted again: the MCP request
 * that carried it was.
 *
 * The counters live in memory and do no I/O, so there is no inconclusive answer to fail open or closed on: a fault
 * in the limiter throws, and Fastify answers that one request 500.
 */
import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../config.js';
import { createRateLimiter } from '../oauth/rate-limit.js';
import { boundCallerOf } from './bridge-binding.js';
import { type Principal, type Requirement, requirementOf } from './plugin.js';

const HTTP_TOO_MANY = 429;
const COUNTED: ReadonlySet<Requirement> = new Set(['user', 'mcp']);

/** The credential and organization a request is counted under, or null when it is not counted. */
export function rateKeysOf(
    requirement: Requirement,
    principal: Principal | null,
    bridged: boolean
): { credential: string; org: string } | null {
    if (!COUNTED.has(requirement) || bridged || !principal) return null;
    if (principal.kind === 'org') return { credential: `org-token:${principal.token.id}`, org: principal.token.orgId };
    if (principal.kind !== 'user') return null;
    const { caller } = principal;
    const credential = caller.sessionHash
        ? `session:${caller.sessionHash.toString('hex')}`
        : caller.accessTokenId
          ? `token:${caller.accessTokenId}`
          : caller.grantFamilyId
            ? `grant:${caller.grantFamilyId}`
            : `user:${caller.user.id}`;
    return { credential, org: caller.org.id };
}

/** The 429 every limit here answers with: the seconds until the window that refused it resets. */
export const tooMany = (reply: FastifyReply, retryAfterSeconds: number, code: string, error: string) =>
    reply.header('retry-after', String(retryAfterSeconds)).code(HTTP_TOO_MANY).send({ error, code });

/** Fastify's `trustProxy`: `request.ip` reads `X-Forwarded-For` only from a peer in TRUSTED_PROXIES, else the socket's. */
export const trustProxyOf = (proxies: readonly string[]): string[] | false =>
    proxies.length > 0 ? [...proxies] : false;

/**
 * Registers the `onRequest` hook; call it after `registerAuth`, whose hook must have run first. Not under
 * AUTH_MODE=none: one stand-in account is every caller there, and the loopback bind is the access control.
 */
export function registerRequestRateLimit(
    app: FastifyInstance,
    { config, now }: { config: Pick<AppConfig, 'auth' | 'requestLimits'>; now: () => number }
): void {
    if (config.auth.mode !== 'github') return;
    const limits = config.requestLimits;
    const perCredential = createRateLimiter({ limit: limits.perCredential, windowMs: limits.windowMs, now });
    const perOrg = createRateLimiter({ limit: limits.perOrg, windowMs: limits.windowMs, now });
    app.addHook('onRequest', async (request, reply) => {
        if (reply.sent) return;
        const keys = rateKeysOf(requirementOf(request), request.auth, boundCallerOf(request.raw) !== null);
        if (!keys) return;
        // A refused credential does not spend its organization's budget.
        const own = perCredential.hit(keys.credential);
        const verdict = own.ok ? perOrg.hit(keys.org) : own;
        if (!verdict.ok) {
            await tooMany(reply, verdict.retryAfterSeconds, ERROR_CODES.RATE_LIMITED, 'Too many requests');
        }
    });
}
