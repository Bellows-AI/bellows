import {
    ERROR_CODES,
    executorMissingMessage,
    executorSuspendedMessage,
    type ExecutorScope,
    noExecutorMessage,
} from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ExecutorDefault, UserExecutorStore } from '../../db/user-executor-store.js';
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

/**
 * The profile a selection naming no executor runs on: the caller's resolved default (their stored preference, else the
 * first active personal profile, else the first active org one). The claim resolves only the stamped label, so a task
 * queued with none would fail there. Null when there is nothing to resolve against (no executor store, no caller);
 * `refused` once the refusal is on `reply`: 409 `NO_EXECUTOR` for a caller with no usable profile, or a failed read.
 */
export async function defaultExecutorOf(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { executors: Pick<UserExecutorStore, 'resolvedDefault'> | null | undefined; createdBy: string | null }
): Promise<ExecutorDefault | null | 'refused'> {
    const { executors, createdBy } = opts;
    if (!executors || !createdBy) return null;
    const resolved = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'default executor read failed'),
        () => executors.resolvedDefault(createdBy)
    );
    if (!resolved.ok) return 'refused';
    if (resolved.value !== null) return resolved.value;
    bad(reply, ERROR_CODES.NO_EXECUTOR, noExecutorMessage, HTTP_CONFLICT);
    return 'refused';
}

/**
 * What `POST /api/jobs` runs on: the named profile, or the caller's default when none is named, checked usable either
 * way. Null once a refusal is on `reply`. A board with no executor store or no caller keeps a null executor.
 */
export async function usableSelection(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: {
        executors: Pick<UserExecutorStore, 'configFor' | 'resolvedDefault'> | null | undefined;
        createdBy: string | null;
        executor: string | null;
        scope: ExecutorScope;
    }
): Promise<{ executor: string | null; scope: ExecutorScope } | null> {
    let { executor, scope } = opts;
    if (executor === null) {
        const fallback = await defaultExecutorOf(request, reply, opts);
        if (fallback === 'refused') return null;
        if (fallback !== null) ({ name: executor, scope } = fallback);
    }
    if (await refusedAsUnusable(request, reply, { ...opts, executor, scope })) return null;
    return { executor, scope };
}
