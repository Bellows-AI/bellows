import {
    batchExecutionCapability,
    ERROR_CODES,
    executorSuspendedMessage,
    resolveBatchPlan,
    USER_SCOPE,
    type BatchPlan,
    type DefaultBranches,
    type ResolvedBatchPlan,
} from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Repo } from '../config.js';
import type { BatchRecord } from '../db/batch-store.js';
import { type Context, planOf } from './batch-http.js';
import { bad, checkReposVisible, guard } from './helpers.js';
import { validateExecutorField } from './job-field-validation.js';
import { HTTP_CONFLICT } from './job-limits.js';

/**
 * The launch checks, in the order the issue fixes, shared by validate and start: structural
 * validity, installation visibility per target, branch resolution, what the executors can run,
 * then the executors themselves. Each step answers its own refusal and returns false once it has;
 * none writes.
 */

const reposOf = (plan: BatchPlan): Repo[] =>
    [...new Set(plan.targets.map((target) => target.repo))].map((name) => {
        const [owner, repo] = name.split('/') as [string, string];
        return { owner, name: repo };
    });

/** Installation visibility per target — the whole credential boundary (docs/repos.md). */
async function targetsVisible(ctx: Context, request: FastifyRequest, reply: FastifyReply, plan: BatchPlan) {
    const visible = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'batch repo visibility failed'),
        () => checkReposVisible(ctx.runtime.repos, reposOf(plan), { subject: 'the batch targets' })
    );
    if (!visible.ok) return false;
    if (visible.value.ok) return true;
    bad(reply, visible.value.code, visible.value.message, visible.value.status);
    return false;
}

/** Each target repository's default branch, or null once a repository with none has been refused. */
async function defaultBranchesOf(
    ctx: Context,
    request: FastifyRequest,
    reply: FastifyReply,
    plan: BatchPlan
): Promise<DefaultBranches | null> {
    const detail = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'batch default branch read failed'),
        () => ctx.runtime.repos.detail()
    );
    if (!detail.ok) return null;
    const defaults: Record<string, string> = {};
    for (const repo of detail.value.repos) {
        if (repo.defaultBranch !== null) defaults[`${repo.owner}/${repo.name}`] = repo.defaultBranch;
    }
    const missing = plan.targets.find((target) => defaults[target.repo] === undefined);
    if (!missing) return defaults;
    bad(
        reply,
        ERROR_CODES.BATCH_NO_DEFAULT_BRANCH,
        `"${missing.repo}" reports no default branch, so a branch cannot be resolved for "${missing.key}"`,
        HTTP_CONFLICT
    );
    return null;
}

/** An executor the caller has suspended launches nothing, whichever route names it. */
async function executorsUsable(ctx: Context, request: FastifyRequest, reply: FastifyReply, plan: ResolvedBatchPlan) {
    const executors = ctx.runtime.userExecutors;
    const names = new Set(plan.stages.flatMap((stage) => stage.tasks.map((task) => task.executor)));
    for (const name of names) {
        if (name === null) continue;
        const shape = validateExecutorField(name);
        if (!shape.ok) {
            bad(reply, ERROR_CODES.BAD_EXECUTOR, shape.message);
            return false;
        }
        if (!executors || !ctx.createdBy) continue;
        const row = await guard(
            reply,
            (e) => request.log.error({ err: e }, 'executor row read failed'),
            () => executors.configFor(ctx.createdBy!, name, USER_SCOPE)
        );
        if (!row.ok) return false;
        if (row.value?.suspended) {
            bad(reply, ERROR_CODES.EXECUTOR_SUSPENDED, executorSuspendedMessage(USER_SCOPE, name), HTTP_CONFLICT);
            return false;
        }
    }
    return true;
}

/** The resolved plan, or null once a refusal has been sent. */
export async function launchChecks(
    ctx: Context,
    request: FastifyRequest,
    reply: FastifyReply,
    record: BatchRecord
): Promise<ResolvedBatchPlan | null> {
    const plan = planOf(reply, record.plan);
    if (!plan) return null;
    if (!(await targetsVisible(ctx, request, reply, plan))) return null;
    const defaults = await defaultBranchesOf(ctx, request, reply, plan);
    if (!defaults) return null;

    const resolved = resolveBatchPlan(plan, defaults);
    const capability = batchExecutionCapability(resolved, defaults, {
        canMerge: ctx.runtime.batchMerger !== undefined,
    });
    if (!capability.ok) {
        reply.code(HTTP_CONFLICT).send({
            error: capability.message,
            code: ERROR_CODES.BATCH_UNSUPPORTED,
            reason: capability.reason,
        });
        return null;
    }
    return (await executorsUsable(ctx, request, reply, resolved)) ? resolved : null;
}
