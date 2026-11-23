import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { OrgRegistry } from '../../orgs.js';
import { callerOf, orgOf } from '../../auth/plugin.js';
import { type ForgeGate, forgeLabel, forgeOfRepo, type ForgeVerdict } from '../../forge/forge-gate.js';
import type { JobStore } from '../../db/jobs/job-store-types.js';
import { HTTP_CONFLICT, HTTP_UNAVAILABLE } from './job-limits.js';

/** Where a member lands after connecting from a create: the composer. */
export const TASK_COMPOSER_PATH = '/tasks/new';

/** What a refused member reads: the forge, and the one link that fixes it. */
export const forgeRefusalMessage = (verdict: Extract<ForgeVerdict, { ok: false }>): string => {
    const label = forgeLabel(verdict.forge);
    const state = verdict.standing === 'broken' ? 'needs reconnecting' : 'is missing';
    return `Your ${label} connection ${state}. Connect it to start work on this repository: ${verdict.connectUrl}`;
};

/** The 409 every entry point answers a member with no live grant. */
export const forgeRefused = (reply: FastifyReply, verdict: Extract<ForgeVerdict, { ok: false }>) =>
    reply.code(HTTP_CONFLICT).send({
        error: forgeRefusalMessage(verdict),
        code: ERROR_CODES.FORGE_GRANT_REQUIRED,
        forge: verdict.forge,
        standing: verdict.standing,
        connectUrl: verdict.connectUrl,
    });

/** A standing read that failed is not a verdict: the answer is a 503 the caller retries, never a refusal. */
export const forgeReadFailed = (reply: FastifyReply, log: FastifyBaseLogger, err: unknown) => {
    log.error({ err }, 'forge grant standing read failed');
    return reply
        .code(HTTP_UNAVAILABLE)
        .send({ error: 'The GitHub connection could not be read', code: ERROR_CODES.UNAVAILABLE });
};

/**
 * The route gate (docs/connections.md): the REQUESTER must hold a live grant for the repo's forge. True once the
 * refusal (409) or the failed read's 503 is on `reply`. No gate (AUTH_MODE=none) or no caller passes.
 */
export async function refusedAsNoForgeGrant(
    request: FastifyRequest,
    reply: FastifyReply,
    gate: ForgeGate | undefined,
    subject: { repo: string | null; returnTo: string }
): Promise<boolean> {
    const caller = callerOf(request);
    if (!gate || !caller) return false;
    try {
        const verdict = await gate.check({ orgId: orgOf(request), userId: caller.user.id, ...subject });
        if (verdict.ok) return false;
        forgeRefused(reply, verdict);
    } catch (err) {
        forgeReadFailed(reply, request.log, err);
    }
    return true;
}

/** What a handler that may gate a start is built from: the org registry and, when there are member grants, the gate. */
export interface ForgeGatedDeps {
    orgs: OrgRegistry;
    forgeGate?: ForgeGate | undefined;
}

/**
 * The gate for a person's action on an existing thread (follow-up, retry, reopen): the thread's repo, read through
 * the store, and a return to the task page. A thread this org does not hold passes to the handler's own 404.
 */
export async function refusedOnThread(
    request: FastifyRequest,
    reply: FastifyReply,
    gate: ForgeGate | undefined,
    thread: { store: Pick<JobStore, 'get'>; id: string }
): Promise<boolean> {
    if (!gate) return false;
    try {
        const job = await thread.store.get(thread.id);
        if (!job) return false;
        return refusedAsNoForgeGrant(request, reply, gate, { repo: job.repo, returnTo: `/tasks/${thread.id}` });
    } catch (err) {
        forgeReadFailed(reply, request.log, err);
        return true;
    }
}

/** The preflight's forge check: what a create of this repo would decide about the caller's grant, without refusing. */
export async function forgeCheck(
    log: FastifyBaseLogger,
    gate: ForgeGate | undefined,
    who: { orgId: string; userId: string; repo: string | null }
): Promise<{
    subject: 'forge';
    name: string;
    status: 'ok' | 'blocked' | 'unverified';
    code?: string;
    detail: string;
} | null> {
    const forge = forgeOfRepo(who.repo);
    if (!gate || forge === null) return null;
    try {
        const verdict = await gate.check({ ...who, returnTo: TASK_COMPOSER_PATH });
        if (verdict.ok)
            return { subject: 'forge', name: forge, status: 'ok', detail: `${forgeLabel(forge)} connected` };
        return {
            subject: 'forge',
            name: forge,
            status: 'blocked',
            code: ERROR_CODES.FORGE_GRANT_REQUIRED,
            detail: forgeRefusalMessage(verdict),
        };
    } catch (err) {
        log.warn({ err }, 'preflight: forge grant standing could not be read');
        return { subject: 'forge', name: forge, status: 'unverified', detail: 'the connection could not be read' };
    }
}
