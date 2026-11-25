import { ERROR_CODES, type RepoRef } from '@factory-ai/core';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { OrgRegistry } from '../../orgs.js';
import { callerOf, orgOf } from '../../auth/plugin.js';
import type { ForgeGate, ForgeVerdict } from '../../forge/forge-gate.js';
import { forgeLabel, forgeOfRepo } from '../../forge/forges.js';
import type { JobStore } from '../../db/jobs/job-store-types.js';
import { HTTP_CONFLICT, HTTP_UNAVAILABLE } from './job-limits.js';

/** Where a member lands after connecting from a create: the composer. */
export const TASK_COMPOSER_PATH = '/tasks/new';

type Refusal = Extract<ForgeVerdict, { ok: false }>;

/** The code a refusal answers with: a connection that is missing or broken, or a live one the forge does not let work here. */
export const forgeRefusalCode = (verdict: Refusal) =>
    verdict.standing === 'no-access' ? ERROR_CODES.FORGE_ACCESS_DENIED : ERROR_CODES.FORGE_GRANT_REQUIRED;

/** What a refused member reads: the forge, and the one link that fixes it. */
export const forgeRefusalMessage = (verdict: Refusal): string => {
    const label = forgeLabel(verdict.forge);
    if (verdict.standing === 'no-access') {
        return `Your ${label} account does not have Developer access to ${verdict.repo ?? 'this repository'}. Ask for access, or link another account: ${verdict.connectUrl}`;
    }
    const state = verdict.standing === 'broken' ? 'needs reconnecting' : 'is missing';
    return `Your ${label} connection ${state}. Connect it to start work on this repository: ${verdict.connectUrl}`;
};

/** The 409 every entry point answers a member with no live grant, or with a live one the forge does not honor here. */
export const forgeRefused = (reply: FastifyReply, verdict: Refusal) =>
    reply.code(HTTP_CONFLICT).send({
        error: forgeRefusalMessage(verdict),
        code: forgeRefusalCode(verdict),
        forge: verdict.forge,
        standing: verdict.standing,
        connectUrl: verdict.connectUrl,
        ...(verdict.repo === undefined ? {} : { repo: verdict.repo }),
    });

/** A standing read or an access check that failed is not a verdict: the answer is a 503 the caller retries, never a refusal. */
export const forgeReadFailed = (reply: FastifyReply, log: FastifyBaseLogger, err: unknown) => {
    log.error({ err }, 'forge grant standing read failed');
    return reply
        .code(HTTP_UNAVAILABLE)
        .send({ error: 'The forge connection could not be read', code: ERROR_CODES.UNAVAILABLE });
};

/**
 * The route gate (docs/connections.md): the REQUESTER must hold a live grant for the repo's forge. True once the
 * refusal (409) or the failed read's 503 is on `reply`. No gate (AUTH_MODE=none) or no caller passes.
 */
export async function refusedAsNoForgeGrant(
    request: FastifyRequest,
    reply: FastifyReply,
    gate: ForgeGate | undefined,
    subject: { repo: RepoRef | null; returnTo: string }
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
    who: { orgId: string; userId: string; repo: RepoRef | null }
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
            code: forgeRefusalCode(verdict),
            detail: forgeRefusalMessage(verdict),
        };
    } catch (err) {
        log.warn({ err }, 'preflight: forge grant standing could not be read');
        return { subject: 'forge', name: forge, status: 'unverified', detail: 'the connection could not be read' };
    }
}
