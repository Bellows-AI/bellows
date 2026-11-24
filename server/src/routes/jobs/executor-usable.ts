import {
    CLAUDE_CODE,
    ERROR_CODES,
    EXECUTOR_TYPES,
    executorMissingMessage,
    executorSuspendedMessage,
    type ExecutorScope,
    hasModelKey,
    NO_MODEL_MESSAGE,
    noExecutorMessage,
} from '@factory-ai/core';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentDefault, ResolvedDefault, UserExecutorStore } from '../../db/user-executor-store.js';
import { repoRefOf } from '../../forge/forges.js';
import type { OrgRuntime } from '../../orgs.js';
import type { ExecutorTypeRead } from '../../skill-catalog.js';
import { bad, guard } from '../helpers.js';
import { HTTP_CONFLICT, HTTP_NOT_FOUND, HTTP_UNAVAILABLE } from './job-limits.js';

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
            // An agent default names the agent itself: there is no profile row to read.
            if (fallback.kind === 'agent') return executorTypeOf(fallback.agentType);
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

/** A usable selection's executor type, and the profile config it runs (null when no profile does). */
export interface UsableProfile {
    type: ExecutorTypeRead;
    config: Record<string, unknown> | null;
}

/**
 * A selection must name a profile its scope holds, and not a suspended one: a name the scope does
 * not hold (404 `UNKNOWN_EXECUTOR`) or a suspended profile (409 `EXECUTOR_SUSPENDED`) would otherwise
 * queue a task the claim fails minutes later. The one resolution `POST /api/jobs` and a batch launch
 * share; the claim keeps its own check for a profile removed after the task was queued. True when a
 * refusal (or a failed read) has already landed on `reply`. A selection naming no executor, a board
 * with no executor store or an unauthenticated caller has nothing to resolve against, so it refuses nothing.
 * `refused` once the refusal is on `reply`; otherwise the usable profile's executor type (`known` null when none resolved)
 * and its config.
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
): Promise<'refused' | UsableProfile> {
    const { executors, createdBy, executor, scope } = opts;
    if (!executors || !createdBy || !executor) return { type: { state: 'known', type: null }, config: null };
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
    if (!row.value.suspended) return { type: executorTypeOf(row.value.type), config: row.value.config };
    bad(reply, ERROR_CODES.EXECUTOR_SUSPENDED, executorSuspendedMessage(scope, executor), HTTP_CONFLICT);
    return 'refused';
}

/**
 * What a selection naming no executor runs on: the caller's resolved default (their stored preference, else their own
 * agent default, else the organization's, else the first active personal profile, else the first active org one). A
 * profile is stamped as the label; an agent default is frozen on the task as its agent and model. The claim
 * reads only what was stamped, so a task queued with neither would fail there. Null when there is nothing to resolve
 * against (no executor store, no caller); `refused` once the refusal is on `reply`: 409 `NO_EXECUTOR` for a caller with
 * nothing resolved, or a failed read.
 */
export async function defaultExecutorOf(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { executors: Pick<UserExecutorStore, 'resolvedDefault'> | null | undefined; createdBy: string | null }
): Promise<ResolvedDefault | null | 'refused'> {
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
 * way, with the executor type its CLI runs. An agent default that wins leaves `executor` null and comes back as `agent`,
 * frozen on the task at create. Null once a refusal is on `reply`. A board with no executor store or no caller keeps a
 * null executor and a `known` null type.
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
): Promise<{
    executor: string | null;
    scope: ExecutorScope;
    type: ExecutorTypeRead;
    config: Record<string, unknown> | null;
    agent: AgentDefault | null;
} | null> {
    let { executor, scope } = opts;
    if (executor === null) {
        const fallback = await defaultExecutorOf(request, reply, opts);
        if (fallback === 'refused') return null;
        if (fallback?.kind === 'agent') {
            const agent = { agentType: fallback.agentType, model: fallback.model };
            return { executor: null, scope, type: executorTypeOf(agent.agentType), config: null, agent };
        }
        if (fallback !== null) ({ name: executor, scope } = fallback);
    }
    const usable = await refusedAsUnusable(request, reply, { ...opts, executor, scope });
    if (usable === 'refused') return null;
    return { executor, scope, ...usable, agent: null };
}

/** What a task's model credential is judged on: whose env and which repository's, the agent and its profile config. */
export interface ModelSubject {
    userId: string | null;
    repo: string | null;
    type: ExecutorTypeRead;
    config: unknown;
}

/**
 * Whether a task's agent has a model credential, where the board requires one (`modelKeyRequired`): `not-required`
 * elsewhere; `ok` or `missing` by `hasModelKey` over the env names it would get and its profile config; `unverified`
 * when the agent is not known or the names cannot be read — never `missing` (docs/jobs.md). No resolved agent runs
 * Claude Code. A read failure rejects, for the caller to answer.
 */
export async function modelStanding(
    rt: Pick<OrgRuntime, 'envVars' | 'modelRequired'>,
    subject: ModelSubject
): Promise<'not-required' | 'ok' | 'missing' | 'unverified'> {
    if (!rt.modelRequired) return 'not-required';
    if (subject.type.state !== 'known' || !rt.envVars) return 'unverified';
    const agentType = subject.type.type ?? CLAUDE_CODE;
    const names = await rt.envVars.namesFor({ userId: subject.userId, repo: repoRefOf(subject.repo) }, { agentType });
    return hasModelKey(names, subject.config, agentType) ? 'ok' : 'missing';
}

/**
 * Create's and a batch launch's model check: 409 `NO_MODEL` when the task's agent has no model credential, the
 * failure's 503 when the names cannot be read. True once a refusal is on `reply`. An agent the board does not know
 * passes, as create lets it through; the claim judges it again on the env that travels.
 */
export async function refusedAsNoModel(
    request: FastifyRequest,
    reply: FastifyReply,
    rt: Pick<OrgRuntime, 'envVars' | 'modelRequired'> | null,
    subject: ModelSubject
): Promise<boolean> {
    if (!rt?.modelRequired || subject.type.state !== 'known') return false;
    const standing = await guard(
        reply,
        (e) => modelReadFailed(request.log, e),
        () => modelStanding(rt, subject)
    );
    if (!standing.ok) return true;
    // A known agent is unverified only on a board with no env store: nothing to judge on, so never `NO_MODEL`.
    if (standing.value === 'unverified') {
        bad(reply, ERROR_CODES.ENV_UNAVAILABLE, 'No environment store for this organization', HTTP_UNAVAILABLE);
        return true;
    }
    if (standing.value !== 'missing') return false;
    bad(reply, ERROR_CODES.NO_MODEL, NO_MODEL_MESSAGE, HTTP_CONFLICT);
    return true;
}

const modelReadFailed = (log: FastifyBaseLogger, e: unknown) =>
    log.error({ err: e }, 'model credential names read failed');
