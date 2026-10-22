/**
 * The job board: task and thread creation, the claim/lease protocol a driver walks a run through,
 * and the read models the dashboard polls. `createJobStore` binds a connection and an org into a
 * `JobStore` whose every method delegates to a free function over a `JobStoreContext`:
 *
 * - `job-store-types.ts` — every shape: `Job`, `Claim`, the `JobStore` contract, results, deps.
 * - `job-store-rows.ts` — row shapes, mappers and the shared SQL fragments.
 * - `job-store-claim.ts` — the worker's claim and the reclaim claim/ack.
 * - `job-store-worker.ts` — heartbeat, reports, `complete` and the workflow walk.
 * - `job-store-conclusions.ts` — the staged final envelope and the board's commit of it (076).
 * - `job-store-phase-checkpoints.ts` — the post-run phase outcomes an adopter resumes from (080).
 * - `job-store-actions.ts` — member actions: create, follow up, done, reopen, stop, suspend,
 *   remove, and the wait-control pair (issue #328).
 * - `job-store-questions.ts` — the agent's questions (050): ask, expire, answer, and their reads.
 * - `job-store-reads.ts` — get, thread, list, and the task list.
 * - `job-store-org-resolvers.ts` — org-of-lease/job/reclaim.
 *
 * Import from the file that owns a name; there is no barrel. Read docs/jobs.md before touching any
 * of them: the decisions here look simplifiable and mostly are not.
 */

import {
    createJobRow,
    createFollowUpRow,
    createRetryRow,
    editJobCommand,
    markJobDone,
    reopenJob,
    stopJob,
    suspendJob,
    interruptJob,
    removeJobThread,
    cancelThreadWait,
    pokeThreadWait,
} from './job-store-actions.js';
import { closeMergedPr } from './job-store-merge.js';
import { answerQuestionBy, askQuestionReport } from './job-store-questions.js';
import { readReviewFor, requestReviewFor } from './job-store-reviews.js';
import { claimJob } from './job-store-claim.js';
import { orgDemand } from './job-store-admission.js';
import { claimReclaimRow, ackReclaimRow, renewReclaimRow } from './job-store-reclaims.js';
import {
    threadOf,
    getJob,
    waitForSettleOf,
    listJobs,
    listTasksOf,
    leasesOf,
    artifactScopeOf,
    restoreScopeOf,
} from './job-store-reads.js';
import {
    wallTickFragment,
    authorJoinFragment,
    authorColumnsFragment,
    taskPreviewColumnsFragment,
    waitLateralFragment,
    publicationJoinFragment,
    publicationColumnsFragment,
} from './job-store-rows.js';
import type { CreateJobStoreDeps, JobStore, JobStoreContext, RuntimeVitals } from './job-store-types.js';
import { heartbeatJob, sessionReport, progressReport, gatesReport, completeJob } from './job-store-worker.js';
import { stageConclusion } from './job-store-conclusions.js';
import { readPhaseCheckpoints, writePhaseCheckpoint } from './job-store-phase-checkpoints.js';

/**
 * The worker-report method bindings — the claim-to-verdict half of the store. Split out of
 * `createJobStore` purely so that factory stays under its line budget; the gate (the migrations
 * wait) closes over the same way.
 */
function workerMethods(
    ctx: JobStoreContext,
    gate: () => Promise<void>
): Pick<
    JobStore,
    | 'claim'
    | 'demand'
    | 'heartbeat'
    | 'session'
    | 'progress'
    | 'gates'
    | 'askQuestion'
    | 'requestReview'
    | 'readReview'
    | 'complete'
    | 'stageConclusion'
    | 'writePhaseCheckpoint'
    | 'readPhaseCheckpoints'
    | 'leases'
    | 'artifactScope'
    | 'restoreScope'
> {
    return {
        async claim(worker, leaseSeconds, options) {
            await gate();
            return claimJob(ctx, worker, leaseSeconds, options);
        },

        async demand() {
            await gate();
            return orgDemand(ctx.sql, ctx.orgId);
        },

        async heartbeat(id, leaseToken, leaseSeconds) {
            await gate();
            return heartbeatJob(ctx, id, leaseToken, leaseSeconds);
        },

        async session(id, leaseToken, sessionId) {
            await gate();
            return sessionReport(ctx, id, leaseToken, sessionId);
        },

        async progress(id, leaseToken, output, runtime: RuntimeVitals | null = null) {
            await gate();
            return progressReport(ctx, id, leaseToken, { output, runtime });
        },

        async gates(id, leaseToken, results) {
            await gate();
            return gatesReport(ctx, id, leaseToken, results);
        },

        async askQuestion(id, leaseToken, ask) {
            await gate();
            return askQuestionReport(ctx, id, leaseToken, ask);
        },

        async requestReview(id, leaseToken, request) {
            await gate();
            return requestReviewFor(ctx, id, leaseToken, request);
        },

        async readReview(id, leaseToken, key) {
            await gate();
            return readReviewFor(ctx, id, leaseToken, key);
        },

        async complete(id, leaseToken, result) {
            await gate();
            return completeJob(ctx, id, leaseToken, result);
        },

        async stageConclusion(id, leaseToken, result, leaseSeconds) {
            await gate();
            return stageConclusion(ctx, { id, leaseToken }, result, leaseSeconds);
        },

        async writePhaseCheckpoint(id, leaseToken, checkpoint) {
            await gate();
            return writePhaseCheckpoint(ctx, { id, leaseToken }, checkpoint);
        },

        async readPhaseCheckpoints(id, leaseToken, runClaimSeq) {
            await gate();
            return readPhaseCheckpoints(ctx, { id, leaseToken }, runClaimSeq);
        },

        async leases(ids, withThreads) {
            await gate();
            return leasesOf(ctx, ids, withThreads);
        },

        async artifactScope(id) {
            await gate();
            return artifactScopeOf(ctx, id);
        },

        async restoreScope(id, leaseToken) {
            await gate();
            return restoreScopeOf(ctx, id, leaseToken);
        },
    };
}

/**
 * The organization is bound at construction: it is a constant for the life of the process, and a
 * per-call parameter is one more thing a write path can forget.
 */
export { INTERRUPTION_BUDGET, LEASE_EXPIRED_REASON } from './job-store-actions.js';
export { CLAIM_PREPARE_SECONDS } from './job-store-claim.js';

export function createJobStore(deps: CreateJobStoreDeps): JobStore {
    const { sql, orgId, ready, env, githubApp = false, plan: planReader, executorConfig, prs, admission = {} } = deps;
    const gate = async () => {
        if (ready) await ready;
    };

    const ctx: JobStoreContext = {
        sql,
        orgId,
        env,
        githubApp,
        planReader,
        executorConfig,
        prs,
        wallTick: wallTickFragment(sql),
        authorJoin: authorJoinFragment(sql),
        authorColumns: authorColumnsFragment(sql),
        taskPreviewColumns: taskPreviewColumnsFragment(sql),
        waitLateral: waitLateralFragment(sql, orgId),
        publicationJoin: publicationJoinFragment(sql),
        publicationColumns: publicationColumnsFragment(sql),
        admission,
    };

    return jobStoreMethods(ctx, gate);
}

/**
 * The store's methods, delegating one-to-one to the free functions the sibling job-store-*.ts
 * files own (the header's map). Split from `createJobStore` so the factory stays thin: the
 * context and the ready-gate are closed over here, and a new method is one more entry in this
 * literal, never a line against the function-length ceiling.
 */
function jobStoreMethods(ctx: JobStoreContext, gate: () => Promise<void>): JobStore {
    return {
        ...workerMethods(ctx, gate),

        async create(command, createdBy, target) {
            await gate();
            return createJobRow(ctx, command, createdBy, target);
        },

        async createFollowUp(parentId, command, createdBy, idempotency) {
            await gate();
            return createFollowUpRow(ctx.sql, { orgId: ctx.orgId, parentId, command, createdBy, idempotency });
        },

        async createRetry(id, createdBy, idempotency) {
            await gate();
            return createRetryRow(ctx.sql, { orgId: ctx.orgId, id, createdBy, idempotency });
        },

        async editCommand(id, command, caller) {
            await gate();
            return editJobCommand(ctx, id, command, caller);
        },

        async markDone(id, doneBy) {
            await gate();
            return markJobDone(ctx, id, doneBy);
        },

        async closeMergedPr(repo, prNumber, deliveryId, mergedAt) {
            await gate();
            return closeMergedPr(ctx, repo, prNumber, { deliveryId, ...(mergedAt ? { mergedAt } : {}) });
        },

        async answerQuestion(id, questionId, answers, answeredBy) {
            await gate();
            return answerQuestionBy(ctx, { id, questionId, answers, answeredBy });
        },

        async stop(id, stoppedBy) {
            await gate();
            return stopJob(ctx, id, stoppedBy);
        },

        async interrupt(id, leaseToken, interruption) {
            await gate();
            return interruptJob(ctx, id, leaseToken, interruption);
        },
        async suspend(id, leaseToken) {
            await gate();
            return suspendJob(ctx, id, leaseToken);
        },

        async removeThread(id, removedBy) {
            await gate();
            return removeJobThread(ctx, id, removedBy);
        },

        async cancelWait(id, cancelledBy) {
            await gate();
            return cancelThreadWait(ctx, id, cancelledBy);
        },

        async pokeWait(id, pokedBy) {
            await gate();
            return pokeThreadWait(ctx, id, pokedBy);
        },

        async reopen(id) {
            await gate();
            return reopenJob(ctx, id);
        },

        async claimReclaim(worker, leaseSeconds) {
            await gate();
            return claimReclaimRow(ctx, worker, leaseSeconds);
        },

        async ackReclaim(id, token) {
            await gate();
            return ackReclaimRow(ctx, id, token);
        },

        async renewReclaim(id, token, leaseSeconds) {
            await gate();
            return renewReclaimRow(ctx, id, token, leaseSeconds);
        },

        async thread(id) {
            await gate();
            return threadOf(ctx, id);
        },

        async get(id) {
            await gate();
            return getJob(ctx, id);
        },

        async waitForSettle(id, timeoutMs) {
            await gate();
            return waitForSettleOf(ctx, id, timeoutMs);
        },

        async list(filter) {
            await gate();
            return listJobs(ctx, filter);
        },

        async listTasks(filters) {
            await gate();
            return listTasksOf(ctx, filters);
        },
    };
}
