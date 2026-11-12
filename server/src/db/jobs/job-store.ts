/**
 * The job board: task and thread creation, the claim/lease protocol a driver walks a run through,
 * and the read models the dashboard polls. `createJobStore` binds a connection and an org into a
 * `JobStore` whose every method delegates to a free function over a `JobStoreContext`:
 *
 * - `job-store-types.ts` — every shape: `Job`, `Claim`, results, deps, and `JobStore`, the
 *   intersection of the per-concern interfaces each file below declares beside its implementation.
 * - `job-store-rows.ts` — row shapes, mappers and the shared SQL fragments.
 * - `job-store-claim.ts` — the worker's claim and the reclaim claim/ack.
 * - `job-store-worker.ts` — heartbeat, reports, `complete` and the workflow walk.
 * - `job-store-conclusions.ts` — the staged final envelope and the board's commit of it (076).
 * - `job-store-phase-checkpoints.ts` — the post-run phase outcomes an adopter resumes from (080).
 * - `job-store-thread-actions.ts` — member actions on a thread: create, follow up, retry, done, reopen, remove, and
 *   the wait-control pair; `job-store-run-control.ts` — stop, suspend, interrupt.
 * - `job-store-questions.ts` — the agent's questions (050): ask, expire, answer, and their reads.
 * - `job-store-reads.ts` — get, thread, list, and the task list.
 * - `job-store-org-resolvers.ts` — org-of-lease/job/reclaim.
 *
 * Import from the file that owns a name; there is no barrel. Read docs/jobs.md before touching any
 * of them: the decisions here look simplifiable and mostly are not.
 */

import { SELF_HOSTED } from '@factory-ai/core';
import { bindConnectionRow, dismissRequirementRow, requireConnectionRow } from './job-store-connections.js';
import {
    createFollowUpRow,
    createRetryRow,
    editJobCommand,
    markJobDone,
    reopenJob,
    removeJobThread,
    cancelThreadWait,
    pokeThreadWait,
} from './job-store-thread-actions.js';
import { stopJob, suspendJob, interruptJob } from './job-store-run-control.js';
import { closeMergedPr } from './job-store-merge.js';
import { answerQuestionBy, askQuestionReport } from './job-store-questions.js';
import { readReviewFor, requestReviewFor } from './job-store-reviews.js';
import { claimJob } from './job-store-claim.js';
import { activityRecordsOf, taskJobIdsOf } from './job-store-activity-records.js';
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
    attachmentSetOf,
    skillPinOf,
} from './job-store-reads.js';
import { wallTickFragment } from './job-store-sql-fragments.js';
import {
    authorJoinFragment,
    authorColumnsFragment,
    taskPreviewColumnsFragment,
    waitLateralFragment,
    publicationJoinFragment,
    publicationColumnsFragment,
    batchThreadHidden,
} from './job-store-rows.js';
import type { CreateJobStoreDeps, JobStore, JobStoreContext, RuntimeVitals } from './job-store-types.js';
import { heartbeatJob, sessionReport, progressReport, gatesReport, completeJob } from './job-store-worker.js';
import { stageConclusion } from './job-store-conclusions.js';
import { readGateRuns, writeGateRun } from './job-store-gate-runs.js';
import { writePrOperation } from './job-store-pr-operations.js';
import { createTitledJob, renameTaskRow } from './job-store-title.js';
import { ingestTranscriptTools } from './job-store-transcript-tools.js';
import { readPhaseCheckpoints, writePhaseCheckpoint } from './job-store-phase-checkpoints.js';

/**
 * The worker-report method bindings — the claim-to-verdict half of the store. Split out of
 * `createJobStore` purely so that factory stays under its line budget. The gate (the migrations wait) is not
 * here: `gated` wraps the whole store once.
 */
function workerMethods(
    ctx: JobStoreContext
): Pick<
    JobStore,
    | 'claim'
    | 'demand'
    | 'heartbeat'
    | 'requireConnection'
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
    | 'writeGateRun'
    | 'readGateRuns'
    | 'writePrOperation'
    | 'ingestTranscriptTools'
    | 'leases'
    | 'artifactScope'
    | 'restoreScope'
    | 'attachmentSet'
    | 'skillPin'
> {
    return {
        async claim(worker, leaseSeconds, options) {
            return claimJob(ctx, worker, leaseSeconds, options);
        },

        async demand() {
            return orgDemand(ctx.sql, ctx.orgId);
        },

        async heartbeat(id, leaseToken, leaseSeconds) {
            return heartbeatJob(ctx, id, leaseToken, leaseSeconds);
        },

        async requireConnection(id, leaseToken, provider, target) {
            return requireConnectionRow(ctx.sql, { orgId: ctx.orgId, id, leaseToken, provider, target });
        },

        async session(id, leaseToken, sessionId, evidence) {
            return sessionReport(ctx, id, leaseToken, { ...evidence, sessionId });
        },

        async progress(id, leaseToken, output, runtime: RuntimeVitals | null = null) {
            return progressReport(ctx, id, leaseToken, { output, runtime });
        },

        async gates(id, leaseToken, results) {
            return gatesReport(ctx, id, leaseToken, results);
        },

        async askQuestion(id, leaseToken, ask) {
            return askQuestionReport(ctx, id, leaseToken, ask);
        },

        async requestReview(id, leaseToken, request) {
            return requestReviewFor(ctx, id, leaseToken, request);
        },

        async readReview(id, leaseToken, key) {
            return readReviewFor(ctx, id, leaseToken, key);
        },

        async complete(id, leaseToken, result) {
            return completeJob(ctx, id, leaseToken, result);
        },

        async stageConclusion(id, leaseToken, result, leaseSeconds) {
            return stageConclusion(ctx, { id, leaseToken }, result, leaseSeconds);
        },

        async writePhaseCheckpoint(id, leaseToken, checkpoint) {
            return writePhaseCheckpoint(ctx, { id, leaseToken }, checkpoint);
        },

        async readPhaseCheckpoints(id, leaseToken, runClaimSeq) {
            return readPhaseCheckpoints(ctx, { id, leaseToken }, runClaimSeq);
        },

        async writeGateRun(id, leaseToken, run) {
            return writeGateRun(ctx, { id, leaseToken }, run);
        },

        async readGateRuns(id, leaseToken) {
            return readGateRuns(ctx, { id, leaseToken });
        },

        async writePrOperation(id, leaseToken, operation) {
            return writePrOperation(ctx, { id, leaseToken }, operation);
        },

        async ingestTranscriptTools(id, input) {
            return ingestTranscriptTools(ctx, id, input);
        },

        async leases(ids, withThreads) {
            return leasesOf(ctx, ids, withThreads);
        },

        async artifactScope(id) {
            return artifactScopeOf(ctx, id);
        },

        async restoreScope(id, leaseToken) {
            return restoreScopeOf(ctx, id, leaseToken);
        },

        async attachmentSet(id, leaseToken) {
            return attachmentSetOf(ctx, id, leaseToken);
        },

        async skillPin(id, leaseToken) {
            return skillPinOf(ctx, id, leaseToken);
        },
    };
}

/**
 * The organization is bound at construction: it is a constant for the life of the process, and a
 * per-call parameter is one more thing a write path can forget.
 */
export { LEASE_EXPIRED_REASON } from './job-store-run-control.js';
export {
    INTERRUPTION_BUDGET,
    INTERRUPTION_WINDOW_MS,
    NODE_LOSS_BUDGET,
    NODE_LOSS_WINDOW_MS,
} from './job-store-interruption-budget.js';
export { CLAIM_PREPARE_SECONDS } from './job-store-claim.js';

export function createJobStore(deps: CreateJobStoreDeps): JobStore {
    const {
        sql,
        orgId,
        ready,
        env,
        githubApp = false,
        plan: planReader,
        executorConfig,
        prs,
        admission = {},
        batches = true,
        deploymentMode = SELF_HOSTED,
        metrics,
    } = deps;
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
        metrics,
        wallTick: wallTickFragment(sql),
        authorJoin: authorJoinFragment(sql),
        authorColumns: authorColumnsFragment(sql),
        taskPreviewColumns: taskPreviewColumnsFragment(sql),
        waitLateral: waitLateralFragment(sql, orgId),
        publicationJoin: publicationJoinFragment(sql),
        publicationColumns: publicationColumnsFragment(sql),
        admission,
        batches,
        deploymentMode,
    };

    return gated(gate, jobStoreMethods(ctx));
}

type StoreMethod = (...args: never[]) => Promise<unknown>;

/**
 * The store with every method waiting for the migrations (`ready`) first. One wrapper over the typed store, so a new
 * method can never forget the wait: every `JobStore` member is an async method.
 */
function gated(gate: () => Promise<void>, store: JobStore): JobStore {
    const wrapped: Record<string, StoreMethod> = {};
    for (const [name, method] of Object.entries(store) as [string, StoreMethod][]) {
        wrapped[name] = async (...args) => {
            await gate();
            return method(...args);
        };
    }
    return wrapped as unknown as JobStore;
}

/**
 * The store's methods, delegating one-to-one to the free functions the sibling job-store-*.ts
 * files own (the header's map). Split from `createJobStore` so the factory stays thin: the
 * context is closed over here, and a new method is one more entry in this
 * literal, never a line against the function-length ceiling.
 */
function jobStoreMethods(ctx: JobStoreContext): JobStore {
    return {
        ...workerMethods(ctx),

        async create(command, createdBy, target) {
            return createTitledJob(ctx, command, createdBy, target);
        },

        // The rest tuple keeps the interface's five parameters (the params ceiling is for hand-written signatures).
        async createFollowUp(
            ...[parentId, command, createdBy, idempotency, connectionIds, admin, attachmentIds]: Parameters<
                JobStore['createFollowUp']
            >
        ) {
            if (await batchThreadHidden(ctx, parentId)) return 'batches_disabled';
            return createFollowUpRow(ctx.sql, {
                orgId: ctx.orgId,
                parentId,
                command,
                createdBy,
                idempotency,
                connectionIds,
                admin,
                attachmentIds,
                githubApp: ctx.githubApp,
            });
        },

        async bindConnection(id, input, userId) {
            return bindConnectionRow(ctx.sql, { orgId: ctx.orgId, id, userId, ...input });
        },

        async dismissRequirement(id, provider, userId) {
            return dismissRequirementRow(ctx.sql, { orgId: ctx.orgId, id, provider, userId });
        },

        async createRetry(id, createdBy, idempotency, admin) {
            if (await batchThreadHidden(ctx, id)) return 'batches_disabled';
            return createRetryRow(ctx.sql, { orgId: ctx.orgId, id, createdBy, idempotency, admin });
        },

        async editCommand(id, command, caller) {
            return editJobCommand(ctx, id, command, caller);
        },

        async renameTask(id, rename) {
            return renameTaskRow(ctx, id, rename);
        },

        async markDone(id, doneBy) {
            return markJobDone(ctx, id, doneBy);
        },

        async closeMergedPr(repo, prNumber, deliveryId, mergedAt) {
            return closeMergedPr(ctx, repo, prNumber, { deliveryId, ...(mergedAt ? { mergedAt } : {}) });
        },

        async answerQuestion(id, questionId, answers, answeredBy) {
            return answerQuestionBy(ctx, { id, questionId, answers, answeredBy });
        },

        async stop(id, stoppedBy) {
            return stopJob(ctx, id, stoppedBy);
        },

        async interrupt(id, leaseToken, interruption) {
            return interruptJob(ctx, id, leaseToken, interruption);
        },
        async suspend(id, leaseToken) {
            return suspendJob(ctx, id, leaseToken);
        },

        async removeThread(id, removedBy) {
            return removeJobThread(ctx, id, removedBy);
        },

        async cancelWait(id, cancelledBy, admin) {
            return cancelThreadWait(ctx, id, cancelledBy, admin);
        },

        async pokeWait(id, pokedBy, admin) {
            return pokeThreadWait(ctx, id, pokedBy, admin);
        },

        async reopen(id) {
            return reopenJob(ctx, id);
        },

        async claimReclaim(worker, leaseSeconds) {
            return claimReclaimRow(ctx, worker, leaseSeconds);
        },

        async ackReclaim(id, token) {
            return ackReclaimRow(ctx, id, token);
        },

        async renewReclaim(id, token, leaseSeconds) {
            return renewReclaimRow(ctx, id, token, leaseSeconds);
        },

        async thread(id) {
            return threadOf(ctx, id);
        },

        async get(id) {
            return getJob(ctx, id);
        },

        async taskJobIds(id) {
            return taskJobIdsOf(ctx, id);
        },

        async activityRecords(jobIds) {
            return activityRecordsOf(ctx, jobIds);
        },

        async waitForSettle(id, timeoutMs, signal) {
            return waitForSettleOf(ctx, id, timeoutMs, signal);
        },

        async list(filter) {
            return listJobs(ctx, filter);
        },

        async listTasks(filters) {
            return listTasksOf(ctx, filters);
        },
    };
}
