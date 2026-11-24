import {
    batchExecutionCapability,
    ERROR_CODES,
    githubRepo,
    resolveBatchPlan,
    type BatchPlan,
    type DefaultBranches,
    type ExecutorScope,
    type RepoRef,
    type ResolvedBatchPlan,
} from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BatchRecord } from '../../db/batches/batch-store-types.js';
import { type Context, planOf } from './batch-http.js';
import { bad, checkReposVisible, guard } from '../helpers.js';
import { HTTP_CONFLICT } from '../jobs/job-limits.js';
import { forgeOfRepo } from '../../forge/forges.js';
import { refusedAsNoForgeGrant } from '../jobs/forge-usable.js';
import { defaultExecutorOf, executorTypeOf, refusedAsNoModel, refusedAsUnusable } from '../jobs/executor-usable.js';
import { validateExecutorField } from '../jobs/job-field-validation.js';

/**
 * The launch checks, in the order the issue fixes, shared by validate and start: structural
 * validity, installation visibility per target, branch resolution, each non-default branch on
 * the remote, what the executors can run, then the executors themselves. Each step answers its own
 * refusal and returns false once it has; none writes.
 */

const reposOf = (plan: BatchPlan): RepoRef[] =>
    [...new Set(plan.targets.map((target) => target.repo))].map((path) => githubRepo(path)); // until BEL-532b part 4

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

/** Each (executor, scope) the plan names, once. */
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
        if (
            (await refusedAsUnusable(request, reply, {
                executors,
                createdBy: ctx.createdBy,
                executor: name,
                scope,
            })) === 'refused'
        ) {
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
    const stamped = await withDefaultExecutor(ctx, request, reply, resolved);
    if (!stamped) return null;
    if (!(await executorsUsable(ctx, request, reply, stamped))) return null;
    if (!(await modelKeysPresent(ctx, request, reply, stamped))) return null;
    return (await forgeGrantsLive(ctx, request, reply, { plan: stamped, returnTo: `/batches/${record.id}` }))
        ? stamped
        : null;
}

/**
 * The starter must hold a live grant for every forge the plan's targets live on (`refusedAsNoForgeGrant`), judged once
 * per forge over the whole plan before anything is written: 409 `FORGE_GRANT_REQUIRED`, or 503 when the standing cannot
 * be read. False once a refusal is sent.
 */
async function forgeGrantsLive(
    ctx: Context,
    request: FastifyRequest,
    reply: FastifyReply,
    launch: { plan: ResolvedBatchPlan; returnTo: string }
) {
    const repoOfForge = new Map<string, RepoRef>();
    for (const { repo: path } of launch.plan.targets) {
        const repo = githubRepo(path); // until BEL-532b part 4
        const forge = forgeOfRepo(repo);
        if (forge !== null && !repoOfForge.has(forge)) repoOfForge.set(forge, repo);
    }
    for (const repo of repoOfForge.values()) {
        if (await refusedAsNoForgeGrant(request, reply, ctx.forgeGate, { repo, returnTo: launch.returnTo })) {
            return false;
        }
    }
    return true;
}

/** A task retry runs on its target's repo: the requester's grant for it, or true once a refusal is on `reply`. */
export async function retryRefusedAsNoGrant(ctx: Context, request: FastifyRequest, reply: FastifyReply) {
    if (!ctx.forgeGate) return false;
    const { id, key } = request.params as { id: string; key: string };
    const found = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'batch read failed'),
        () => ctx.store.get(id)
    );
    if (!found.ok) return true;
    const plan = found.value?.plan;
    const target = plan?.stages.flatMap((stage) => stage.tasks).find((task) => task.key === key)?.target;
    const repo = plan?.targets.find((candidate) => candidate.key === (target ?? plan.defaultTarget))?.repo;
    // A batch or task the board does not hold is the store's own 404.
    if (repo === undefined) return false;
    // until BEL-532b part 4: a target's repo is still a path
    return refusedAsNoForgeGrant(request, reply, ctx.forgeGate, { repo: githubRepo(repo), returnTo: `/batches/${id}` });
}

/**
 * In cloud, each task's agent must have a model credential for its repository (`refusedAsNoModel`), judged once per
 * repository × executor or agent: 409 `NO_MODEL`, or 503 when the env cannot be read. False once a refusal is sent.
 */
async function modelKeysPresent(ctx: Context, request: FastifyRequest, reply: FastifyReply, plan: ResolvedBatchPlan) {
    if (!ctx.runtime.modelRequired) return true;
    const repoOf = new Map(plan.targets.map((target) => [target.key, target.repo]));
    const seen = new Set<string>();
    for (const task of plan.stages.flatMap((stage) => stage.tasks)) {
        const repo = repoOf.get(task.target) ?? null;
        const key = JSON.stringify([repo, task.executor, task.executorScope, task.agentType ?? null]);
        if (seen.has(key)) continue;
        seen.add(key);
        const profile =
            task.agentType !== undefined
                ? { type: executorTypeOf(task.agentType), config: null }
                : await refusedAsUnusable(request, reply, {
                      executors: ctx.runtime.userExecutors,
                      createdBy: ctx.createdBy,
                      executor: task.executor,
                      scope: task.executorScope,
                  });
        if (profile === 'refused') return false;
        // until BEL-532b part 4: a target's repo is still a path
        const ref = repo === null ? null : githubRepo(repo);
        if (await refusedAsNoModel(request, reply, ctx.runtime, { userId: ctx.createdBy, repo: ref, ...profile })) {
            return false;
        }
    }
    return true;
}

/**
 * A task naming no executor runs on the starter's default, stamped into the plan the start freezes: a profile as the
 * label, an agent default as the task's agent and model. The claim reads only what was stamped. Null once a
 * refusal is on `reply` (409 `NO_EXECUTOR` when nothing resolves for the starter).
 */
async function withDefaultExecutor(
    ctx: Context,
    request: FastifyRequest,
    reply: FastifyReply,
    plan: ResolvedBatchPlan
): Promise<ResolvedBatchPlan | null> {
    const tasks = plan.stages.flatMap((stage) => stage.tasks);
    if (tasks.every((task) => task.executor !== null)) return plan;
    const fallback = await defaultExecutorOf(request, reply, {
        executors: ctx.runtime.userExecutors,
        createdBy: ctx.createdBy,
    });
    if (fallback === 'refused') return null;
    if (fallback === null) return plan;
    const stamp =
        fallback.kind === 'agent'
            ? { agentType: fallback.agentType, agentModel: fallback.model }
            : { executor: fallback.name, executorScope: fallback.scope };
    return {
        ...plan,
        stages: plan.stages.map((stage) => ({
            ...stage,
            tasks: stage.tasks.map((task) => (task.executor === null ? { ...task, ...stamp } : task)),
        })),
    };
}
