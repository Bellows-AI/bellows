import { ERROR_CODES, parseChangeRequestUrl } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JobStore } from '../../db/jobs/job-store-types.js';
import { changeRequestOnRepo } from '../../db/jobs/job-store-publication-repo.js';
import { bad, guard } from '../helpers.js';
import { leaseLost, notFoundJob, PR_URL_LIMIT } from './job-limits.js';

/** Why a reported change request is refused: the code the route answers and the message naming the field. */
export interface ChangeRequestProblem {
    code: string;
    message: string;
}

/**
 * Checks a reported change request's url against the repo and number reported beside it. Null when it is a
 * GitHub pull url for that very repo and number; a well-formed GitLab merge request url is `FORGE_UNSUPPORTED`
 * until the GitLab client lands; anything else is `malformedCode`.
 */
export function changeRequestProblem({
    field,
    url,
    repo,
    number,
    malformedCode,
}: {
    field: string;
    url: unknown;
    repo: string;
    number: number;
    malformedCode: string;
}): ChangeRequestProblem | null {
    const parsed = typeof url === 'string' && url.length <= PR_URL_LIMIT ? parseChangeRequestUrl(url) : null;
    if (parsed === null) return { code: malformedCode, message: `${field} must be a pull or merge request url` };
    if (parsed.ref.forge !== 'github') {
        return {
            code: ERROR_CODES.FORGE_UNSUPPORTED,
            message: `${field} names a ${parsed.ref.forge} change request, which is not supported yet`,
        };
    }
    if (parsed.ref.path.toLowerCase() !== repo.toLowerCase() || parsed.number !== number) {
        return { code: malformedCode, message: `${field} must name the reported repo and number` };
    }
    return null;
}

/**
 * Refuses, with the reply sent, a change request that is not on the leased task's own repository: the forge, host and
 * path of the url must all be the task's, or the stores would record the task's identity against another repo's url.
 * Runs after the body's shape checks and before any write. Returns true when the reply is sent.
 */
export async function refuseOffTaskChangeRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    store: Pick<JobStore, 'prWriteContext'>,
    attempt: { id: string; leaseToken: string; field: string; url: string; malformedCode: string }
): Promise<boolean> {
    const context = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'task repo read failed'),
        () => store.prWriteContext(attempt.id, attempt.leaseToken)
    );
    if (!context.ok) return true;
    if (context.value.result !== 'ok') {
        if (context.value.result === 'missing') await notFoundJob(reply);
        else await leaseLost(reply);
        return true;
    }
    const task = context.value.repo;
    if (changeRequestOnRepo(attempt.url, task)) return false;
    await bad(reply, attempt.malformedCode, `${attempt.field} must be on the task's repository`);
    return true;
}

/** The answer for a verdict or staged conclusion whose publication names another repository than the task's. */
export const wrongRepo = (reply: FastifyReply) =>
    bad(reply, ERROR_CODES.BAD_PUBLICATION, "publication.prUrl must be on the task's repository");
