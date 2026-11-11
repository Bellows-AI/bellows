import {
    ERROR_CODES,
    EXECUTOR_TYPES,
    executorMissingMessage,
    executorSuspendedMessage,
    type ExecutorScope,
    noExecutorMessage,
} from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ExecutorDefault, UserExecutorStore } from '../../db/user-executor-store.js';
import type { ExecutorTypeRead } from '../../skill-catalog.js';
import { bad, guard } from '../helpers.js';
import { HTTP_CONFLICT, HTTP_NOT_FOUND } from './job-limits.js';

export const executorTypeOf = (type: string): ExecutorTypeRead =>
    (EXECUTOR_TYPES as readonly string[]).includes(type)
        ? { state: 'known', type: type as (typeof EXECUTOR_TYPES)[number] }
        : { state: 'unconfirmed', error: `Unknown executor type ${type}` };

/**
 * The executor type whose CLI will scan the checkout: the named profile's, or the caller's resolved default's when none
 * is named. No store or no caller resolves nothing and runs claude (`known` null). A failed read, a missing or suspended
 * profile, no default or a stored type this board does not know is `unconfirmed`, never a guess.
 */
export async function readExecutorType(
    executors: Pick<UserExecutorStore, 'configFor' | 'resolvedDefault'> | null | undefined,
    userId: string | null,
    executor: string | null,
    scope: ExecutorScope
): Promise<ExecutorTypeRead> {
    if (!executors || !userId) return { state: 'known', type: null };
    try {
        let name = executor;
        let at = scope;
        if (name === null) {
            const fallback = await executors.resolvedDefault(userId);
            if (fallback === null) return { state: 'unconfirmed', error: noExecutorMessage };
            ({ name, scope: at } = fallback);
        }
        const row = await executors.configFor(userId, name, at);
        if (row === null) return { state: 'unconfirmed', error: executorMissingMessage(at, name) };
        if (row.suspended) return { state: 'unconfirmed', error: executorSuspendedMessage(at, name) };
        return executorTypeOf(row.type);
    } catch (cause) {
        return { state: 'unconfirmed', error: cause instanceof Error ? cause.message : String(cause) };
    }
}

/**
 * A selection must name a profile its scope holds, and not a suspended one: a name the scope does
 * not hold (404 `UNKNOWN_EXECUTOR`) or a suspended profile (409 `EXECUTOR_SUSPENDED`) would otherwise
 * queue a task the claim fails minutes later. The one resolution `POST /api/jobs` and a batch launch
 * share; the claim keeps its own check for a profile removed after the task was queued. True when a
 * refusal (or a failed read) has already landed on `reply`. A selection naming no executor, a board
 * with no executor store or an unauthenticated caller has nothing to resolve against, so it refuses nothing.
 * `refused` once the refusal is on `reply`; otherwise the usable profile's executor type (`known` null when none resolved).
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
): Promise<'refused' | ExecutorTypeRead> {
    const { executors, createdBy, executor, scope } = opts;
    if (!executors || !createdBy || !executor) return { state: 'known', type: null };
    const row = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'executor row read failed'),
        () => executors.configFor(createdBy, executor, scope)
    );
    if (!row.ok) return 'refused';
    if (row.value === null) {
        bad(reply, ERROR_CODES.UNKNOWN_EXECUTOR, executorMissingMessage(scope, executor), HTTP_NOT_FOUND);
        return 'refused';
    }
    if (!row.value.suspended) return executorTypeOf(row.value.type);
    bad(reply, ERROR_CODES.EXECUTOR_SUSPENDED, executorSuspendedMessage(scope, executor), HTTP_CONFLICT);
    return 'refused';
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
 * way, with the executor type its CLI runs. Null once a refusal is on `reply`. A board with no executor store or no
 * caller keeps a null executor and a `known` null type.
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
): Promise<{ executor: string | null; scope: ExecutorScope; type: ExecutorTypeRead } | null> {
    let { executor, scope } = opts;
    if (executor === null) {
        const fallback = await defaultExecutorOf(request, reply, opts);
        if (fallback === 'refused') return null;
        if (fallback !== null) ({ name: executor, scope } = fallback);
    }
    const type = await refusedAsUnusable(request, reply, { ...opts, executor, scope });
    if (type === 'refused') return null;
    return { executor, scope, type };
}
