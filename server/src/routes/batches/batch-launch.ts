import {
    AUTOMERGE,
    batchExecutionCapability,
    ERROR_CODES,
    formatRepoRef,
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
import { HTTP_CONFLICT, HTTP_UNAVAILABLE } from '../jobs/job-limits.js';
import { readGitlabDefaultBranch } from '../../forge/forge-reads.js';
import { FORGE_READ_DEADLINE_MS } from '../../forge/gitlab-reads.js';
import { forgeOfRepo, isGithubRepo, isGitlabRepo, refOfListed } from '../../forge/forges.js';
import { refusedAsNoForgeGrant } from '../jobs/forge-usable.js';
import { INSTALLATION_CREDENTIAL, readBranchHead, resolveForgeClient } from '../../forge/forge-client.js';
import { defaultExecutorOf, executorTypeOf, refusedAsNoModel, refusedAsUnusable } from '../jobs/executor-usable.js';
import { validateExecutorField } from '../jobs/job-field-validation.js';

/**
 * The launch checks, in the order the issue fixes, shared by validate and start: structural
 * validity, installation visibility per target, branch resolution, each non-default branch on
 * the remote, what the executors can run, then the executors themselves. Each step answers its own
 * refusal and returns false once it has; none writes.
 */

const reposOf = (plan: BatchPlan): RepoRef[] => [
    ...new Map(plan.targets.map((target) => [formatRepoRef(target.repo), target.repo])).values(),
];

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
        if (repo.defaultBranch !== null) defaults[formatRepoRef(refOfListed(repo))] = repo.defaultBranch;
    }
    for (const target of plan.targets) {
        if (defaults[formatRepoRef(target.repo)] !== undefined) continue;
        const read = await missingDefaultBranch(ctx, request, reply, target);
        if (!read.ok) return null;
        if (read.branch === null) {
            bad(
                reply,
                ERROR_CODES.BATCH_NO_DEFAULT_BRANCH,
                `"${formatRepoRef(target.repo)}" reports no default branch, so a branch cannot be resolved for "${target.key}"`,
                HTTP_CONFLICT
            );
            return null;
        }
        defaults[formatRepoRef(target.repo)] = read.branch;
    }
    return defaults;
}

type DefaultRead = { ok: true; branch: string | null } | { ok: false };

/**
 * The default branch of a target the installation listing holds none for: GitHub's has none (null); a GitLab project's is
 * read as the launcher; another forge's is not read at all, which is no verdict about the repository (503). `ok: false`
 * once a refusal is sent.
 */
async function missingDefaultBranch(
    ctx: Context,
    request: FastifyRequest,
    reply: FastifyReply,
    target: BatchPlan['targets'][number]
): Promise<DefaultRead> {
    if (isGithubRepo(target.repo)) return { ok: true, branch: null };
    if (!isGitlabRepo(target.repo)) {
        bad(
            reply,
            ERROR_CODES.UNAVAILABLE,
            `The default branch of ${target.repo.forge} repositories cannot be read yet, so a branch cannot be resolved for "${target.key}"`,
            HTTP_UNAVAILABLE
        );
        return { ok: false };
    }
    // Any read the board could not confirm (no launcher grant or connection, an error, a timeout, a board with no GitLab
    // access) is a 503, never "no default branch".
    const unavailable = (why: string): DefaultRead => {
        bad(
            reply,
            ERROR_CODES.UNAVAILABLE,
            `The default branch of "${formatRepoRef(target.repo)}" could not be read for "${target.key}": ${why}`,
            HTTP_UNAVAILABLE
        );
        return { ok: false };
    };
    try {
        const read = await readGitlabDefaultBranch(
            { forge: ctx.runtime.forge, gitlab: ctx.gitlab, orgId: ctx.runtime.orgId },
            target.repo,
            ctx.createdBy,
            AbortSignal.timeout(FORGE_READ_DEADLINE_MS)
        );
        return read.ok ? read : unavailable(read.detail);
    } catch (e) {
        request.log.error({ err: e }, 'batch default branch read failed');
        return unavailable((e as Error).message);
    }
}

/** The used targets off their repository's default branch: the ones whose branch must be read. */
const offDefaultTargets = (plan: ResolvedBatchPlan, defaults: DefaultBranches) => {
    const used = new Set(plan.stages.flatMap((stage) => stage.tasks.map((task) => task.target)));
    return plan.targets.filter(
        (target) => used.has(target.key) && defaults[formatRepoRef(target.repo)] !== target.branch
    );
};

/**
 * Each target off its repository's default branch must exist on the remote, or every task would
 * fail at checkout. Offline, or on a forge the board has no client for, it reads no branches and the checkout's own refusal stands.
 */
async function targetBranchesExist(
    ctx: Context,
    request: FastifyRequest,
    reply: FastifyReply,
    targets: ResolvedBatchPlan['targets']
) {
    for (const target of targets) {
        // A board with no client for the target's forge cannot say the branch is absent: the checkout's refusal stands.
        const head = await guard(
            reply,
            (e) => request.log.error({ err: e }, 'batch target branch read failed'),
            () => readBranchHead(ctx.runtime.forge, target.repo, target.branch)
        );
        if (!head.ok) return false;
        if (head.value !== null) continue;
        bad(
            reply,
            ERROR_CODES.BATCH_UNKNOWN_BRANCH,
            `"${formatRepoRef(target.repo)}" has no branch ${target.branch} the installation can read, ` +
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
    // A GitLab default branch is read as the launcher, so their grant is checked first (409, not a 503 from the read).
    const returnTo = `/batches/${record.id}`;
    if (!(await forgeGrantsLive(ctx, request, reply, { plan, returnTo, includes: isGitlabRepo }))) return null;
    const defaults = await defaultBranchesOf(ctx, request, reply, plan);
    if (!defaults) return null;

    const resolved = resolveBatchPlan(plan, defaults);
    if (!(await targetBranchesExist(ctx, request, reply, offDefaultTargets(resolved, defaults)))) return null;
    const capability = batchExecutionCapability(resolved, {
        canMerge: canMergeTargets(ctx, resolved),
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
    const isOtherForge = (repo: RepoRef) => !isGitlabRepo(repo);
    return (await forgeGrantsLive(ctx, request, reply, { plan: stamped, returnTo, includes: isOtherForge }))
        ? stamped
        : null;
}

/**
 * Whether the board can merge every target an automerge stage lands on: it needs a merger, and a source for the target's
 * forge: GitLab's grants and connections, or GitHub's installation. Another combination would read an unbound PR on
 * every pass instead of merging.
 */
function canMergeTargets(ctx: Context, plan: ResolvedBatchPlan): boolean {
    if (ctx.runtime.batchMerger === undefined) return false;
    const merged = new Set(
        plan.stages.filter((stage) => stage.policy === AUTOMERGE).flatMap((stage) => stage.tasks.map((t) => t.target))
    );
    return plan.targets
        .filter((target) => merged.has(target.key))
        .every((target) =>
            isGitlabRepo(target.repo)
                ? ctx.gitlab !== undefined
                : resolveForgeClient(ctx.runtime.forge, target.repo, INSTALLATION_CREDENTIAL).ok
        );
}

/**
 * The starter must hold a live grant for every forge the plan's targets live on (`refusedAsNoForgeGrant`), judged once
 * per forge over the whole plan before anything is written: 409 `FORGE_GRANT_REQUIRED`, or 503 when the standing cannot
 * be read. A plan has one target (multi-target plans are refused first), so a GitLab project's access check is that
 * one repo's. False once a refusal is sent.
 */
async function forgeGrantsLive(
    ctx: Context,
    request: FastifyRequest,
    reply: FastifyReply,
    launch: { plan: { targets: BatchPlan['targets'] }; returnTo: string; includes: (repo: RepoRef) => boolean }
) {
    const repoOfForge = new Map<string, RepoRef>();
    for (const { repo } of launch.plan.targets) {
        const forge = launch.includes(repo) ? forgeOfRepo(repo) : null;
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
    return refusedAsNoForgeGrant(request, reply, ctx.forgeGate, { repo, returnTo: `/batches/${id}` });
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
        const key = JSON.stringify([
            repo === null ? null : formatRepoRef(repo),
            task.executor,
            task.executorScope,
            task.agentType ?? null,
        ]);
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
        if (await refusedAsNoModel(request, reply, ctx.runtime, { userId: ctx.createdBy, repo, ...profile })) {
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
