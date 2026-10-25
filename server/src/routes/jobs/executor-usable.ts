import { ERROR_CODES, executorMissingMessage, executorSuspendedMessage, type ExecutorScope } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserExecutorStore } from '../../db/user-executor-store.js';
import { bad, guard } from '../helpers.js';
import { HTTP_CONFLICT, HTTP_NOT_FOUND } from './job-limits.js';

/**
 * A selection must name a profile its scope holds, and not a suspended one: a name the scope does
 * not hold (404 `UNKNOWN_EXECUTOR`) or a suspended profile (409 `EXECUTOR_SUSPENDED`) would otherwise
 * queue a task the claim fails minutes later. The one resolution `POST /api/jobs` and a batch launch
 * share; the claim keeps its own check for a profile removed after the task was queued. True when a
 * refusal (or a failed read) has already landed on `reply`. A selection naming no executor, a board
 * with no executor store or an unauthenticated caller has nothing to resolve against, so it refuses nothing.
 */
export async function refusedAsUnusable(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: {
        executors: Pick<UserExecutorStore, 'configFor'> | null | undefined;
        createdBy: string | null;
        executor: string | null;
        scope: ExecutorScope;
    }
): Promise<boolean> {
    const { executors, createdBy, executor, scope } = opts;
    if (!executors || !createdBy || !executor) return false;
    const row = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'executor row read failed'),
        () => executors.configFor(createdBy, executor, scope)
    );
    if (!row.ok) return true;
    if (row.value === null) {
        bad(reply, ERROR_CODES.UNKNOWN_EXECUTOR, executorMissingMessage(scope, executor), HTTP_NOT_FOUND);
        return true;
    }
    if (!row.value.suspended) return false;
    bad(reply, ERROR_CODES.EXECUTOR_SUSPENDED, executorSuspendedMessage(scope, executor), HTTP_CONFLICT);
    return true;
}
