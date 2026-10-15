import {
    batchExecutionCapability,
    ERROR_CODES,
    executorMissingMessage,
    executorSuspendedMessage,
    resolveBatchPlan,
    type BatchPlan,
    type DefaultBranches,
    type ExecutorScope,
    type ResolvedBatchPlan,
} from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Repo } from '../config.js';
import type { BatchRecord } from '../db/batch-store.js';
import { type Context, planOf } from './batch-http.js';
import { bad, checkReposVisible, guard } from './helpers.js';
import { validateExecutorField } from './job-field-validation.js';
import { HTTP_CONFLICT, HTTP_NOT_FOUND } from './job-limits.js';

/**
 * The launch checks, in the order the issue fixes, shared by validate and start: structural
 * validity, installation visibility per target, branch resolution, each non-default branch on
 * the remote, what the executors can run, then the executors themselves. Each step answers its own
 * refusal and returns false once it has; none writes.
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

/** The used targets off their repository's default branch: the ones whose branch must be read. */
const offDefaultTargets = (plan: ResolvedBatchPlan, defaults: DefaultBranches) => {
    const used = new Set(plan.stages.flatMap((stage) => stage.tasks.map((task) => task.target)));
    return plan.targets.filter((target) => used.has(target.key) && defaults[target.repo] !== target.branch);
};

/**
 * Each target off its repository's default branch must exist on the remote, or every task would
 * fail at checkout. Offline the board reads no branches and the checkout's own refusal stands.
 */
async function targetBranchesExist(
    ctx: Context,
    request: FastifyRequest,
    reply: FastifyReply,
    targets: ResolvedBatchPlan['targets']
) {
    const branchHead = ctx.runtime.branchHead;
    if (!branchHead) return true;
    for (const target of targets) {
        const head = await guard(
            reply,
            (e) => request.log.error({ err: e }, 'batch target branch read failed'),
            () => branchHead(target.repo, target.branch)
        );
        if (!head.ok) return false;
        if (head.value !== null) continue;
        bad(
            reply,
            ERROR_CODES.BATCH_UNKNOWN_BRANCH,
            `"${target.repo}" has no branch ${target.branch} the installation can read, ` +
                `so "${target.key}" cannot run on it`,
            HTTP_CONFLICT
        );
        return false;
    }
    return true;
}

/** Each (executor, scope) the plan names, once; a task left to the claim's default names none. */
const selectionsOf = (plan: ResolvedBatchPlan): { name: string; scope: ExecutorScope }[] => {
    const seen = new Map<string, { name: string; scope: ExecutorScope }>();
    for (const { executor, executorScope } of plan.stages.flatMap((stage) => stage.tasks)) {
        if (executor !== null) seen.set(`${executorScope}:${executor}`, { name: executor, scope: executorScope });
    }
    return [...seen.values()];
};

/**
 * Every executor the plan names must exist in its scope and not be suspended, whichever route
 * asks: a name the scope does not hold would otherwise fail each task at claim, minutes later.
 */
async function executorsUsable(ctx: Context, request: FastifyRequest, reply: FastifyReply, plan: ResolvedBatchPlan) {
    const executors = ctx.runtime.userExecutors;
    for (const { name, scope } of selectionsOf(plan)) {
        const shape = validateExecutorField(name);
        if (!shape.ok) {
            bad(reply, ERROR_CODES.BAD_EXECUTOR, shape.message);
            return false;
        }
        if (!executors || !ctx.createdBy) continue;
        const row = await guard(
            reply,
            (e) => request.log.error({ err: e }, 'executor row read failed'),
            () => executors.configFor(ctx.createdBy!, name, scope)
        );
        if (!row.ok) return false;
        if (row.value === null) {
            bad(reply, ERROR_CODES.UNKNOWN_EXECUTOR, executorMissingMessage(scope, name), HTTP_NOT_FOUND);
            return false;
        }
        if (row.value.suspended) {
            bad(reply, ERROR_CODES.EXECUTOR_SUSPENDED, executorSuspendedMessage(scope, name), HTTP_CONFLICT);
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
    if (!(await targetBranchesExist(ctx, request, reply, offDefaultTargets(resolved, defaults)))) return null;
    const capability = batchExecutionCapability(resolved, {
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
