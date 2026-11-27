import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { UUID } from '../../identifiers.js';
import {
    PR_OPERATIONS,
    type PrOperationKind,
    type PrOperationStore,
    type PrOperationWrite,
} from '../../db/jobs/job-store-pr-operations.js';
import type { OrgRegistry } from '../../orgs.js';
import { bad, guard, reportedRepoReason } from '../helpers.js';
import { changeRequestProblem, refuseOffTaskChangeRequest } from './change-request-check.js';
import { isBranchField } from './job-field-validation.js';
import { CONTROL_BODY_LIMIT, HTTP_OK, INT4_MAX, leaseLost, notFoundJob } from './job-limits.js';
import { resolveLeasedRoute } from '../route-guards.js';

/** The operation a write names, field by field, or the reason it is refused. */
function validateOperation(
    fields: Record<string, unknown>
): { ok: true; value: PrOperationWrite } | { ok: false; code: string; message: string } {
    const malformed = ERROR_CODES.BAD_BODY;
    const { operationId, operation, repo, prNumber, prUrl, branch } = fields;
    if (typeof operationId !== 'string' || !UUID.test(operationId)) {
        return { ok: false, code: malformed, message: 'operationId must be a uuid' };
    }
    if (!PR_OPERATIONS.includes(operation as PrOperationKind)) {
        return { ok: false, code: malformed, message: `operation must be one of ${PR_OPERATIONS.join(', ')}` };
    }
    if (typeof repo !== 'string' || reportedRepoReason(repo) !== null)
        return { ok: false, code: malformed, message: 'repo must be an owner/name' };
    if (!Number.isInteger(prNumber) || (prNumber as number) < 1 || (prNumber as number) > INT4_MAX) {
        return { ok: false, code: malformed, message: `prNumber must be an integer 1..${INT4_MAX}` };
    }
    const problem = changeRequestProblem({
        field: 'prUrl',
        url: prUrl,
        repo,
        number: prNumber as number,
        malformedCode: malformed,
    });
    if (problem) return { ok: false, ...problem };
    if (!isBranchField(branch)) return { ok: false, code: malformed, message: 'branch must be a branch name' };
    return {
        ok: true,
        value: {
            operationId,
            operation: operation as PrOperationKind,
            repo,
            prNumber: prNumber as number,
            prUrl: prUrl as string,
            branch,
        },
    };
}

/**
 * Records one managed publish operation under the attempt's lease (`088_job_pr_operation.sql`, issue
 * #983): a PR the driver created or reused. The row is shape-validated like a reported publication,
 * and the org comes from the job's own scope.
 */
export async function handlePrOperation(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveLeasedRoute<keyof PrOperationStore | 'prWriteContext'>(orgs, request, reply);
    if (!route) return reply;
    const { store, id, fields, leaseToken } = route;
    const checked = validateOperation(fields);
    if (!checked.ok) return bad(reply, checked.code, checked.message);
    const offTask = await refuseOffTaskChangeRequest(request, reply, store, {
        id,
        leaseToken,
        field: 'prUrl',
        url: checked.value.prUrl,
        malformedCode: ERROR_CODES.BAD_BODY,
    });
    if (offTask) return reply;

    const written = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'PR operation write failed'),
        () => store.writePrOperation(id, leaseToken, checked.value)
    );
    if (!written.ok) return reply;
    if (written.value.result === 'missing') return notFoundJob(reply);
    if (written.value.result === 'lost') return leaseLost(reply);
    return reply.code(HTTP_OK).send({ id, operationId: checked.value.operationId });
}

/** The worker route (088), under the attempt's lease. */
export function prOperationRoutes(app: FastifyInstance, orgs: OrgRegistry): void {
    app.post('/api/jobs/:id/pr-operation', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
        handlePrOperation(orgs, request, reply)
    );
}
