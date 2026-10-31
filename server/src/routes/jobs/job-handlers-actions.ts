import { ERROR_CODES, emptyBlock } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../../auth/plugin.js';
import type { OrgRegistry } from '../../orgs.js';
import { type BoardScanner, storeFor, telemetryFor } from './job-context.js';
import { TelemetryError } from '../../telemetry/errors.js';
import { buildRunActivity, gateActivityOf, prActivityOf } from '../../telemetry/run-activity.js';
import { retryRefusal, waitControlRefusal } from './job-refusals.js';
import { guardKeyed, idempotencyOf, sendQueued } from './job-idempotency.js';
import {
    validateCommandField,
    validateListQuery,
    validateVerdictBody,
    validateWaitQuery,
} from './job-field-validation.js';
import { bad, body, guard } from '../helpers.js';
import { resolveClaimRoute, resolveJobRoute } from '../route-guards.js';
import { UUID } from '../../identifiers.js';
import { adminOf } from './job-handlers-follow-up.js';
import type { Job, SettleOutcome } from '../../db/jobs/job-store-types.js';
import {
    HTTP_ACCEPTED,
    HTTP_CONFLICT,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_NO_CONTENT,
    HTTP_OK,
    conclusionConflict,
    LEASE_SECONDS_MAX,
    leaseLost,
    leaseSeconds,
    noBoard,
    notFoundJob,
} from './job-limits.js';
import type { JobActionStore } from '../../db/jobs/job-store-actions.js';
import type { JobReadStore } from '../../db/jobs/job-store-reads.js';
import type { JobReclaimStore } from '../../db/jobs/job-store-reclaims.js';
import type { JobWorkerStore } from '../../db/jobs/job-store-worker.js';

// BEL-59: the owner's answer to an open integration requirement — bind one of their own connections to the
// thread. The store decides who owns the thread (anyone else is a 404) and the revision race (409).
export async function handleBindConnection(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;
    const userId = callerOf(request)?.user.id ?? null;
    if (userId === null) return notFoundJob(reply);

    const { connectionId, bindingRevision } = body(request.body);
    if (typeof connectionId !== 'string' || !UUID.test(connectionId)) {
        return bad(reply, ERROR_CODES.BAD_CONNECTION, 'connectionId must be a connection id');
    }
    if (typeof bindingRevision !== 'number' || !Number.isInteger(bindingRevision) || bindingRevision < 0) {
        return bad(reply, ERROR_CODES.BAD_CONNECTION, 'bindingRevision must be a non-negative integer');
    }

    const bound = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job connection bind failed'),
        () => store.bindConnection(id, { connectionId, bindingRevision }, userId)
    );
    if (!bound.ok) return reply;
    if (bound.value.ok) return reply.code(HTTP_OK).send({ bindingRevision: bound.value.revision });
    switch (bound.value.reason) {
        case 'missing':
            return notFoundJob(reply);
        case 'stale-revision':
            return reply
                .code(HTTP_CONFLICT)
                .send({ error: 'The task bindings changed; reload it', code: ERROR_CODES.BINDING_REVISION_STALE });
        case 'duplicate':
            return bad(reply, ERROR_CODES.BAD_CONNECTION, 'That connection is already bound to this task');
        case 'not-authorized':
            return bad(
                reply,
                ERROR_CODES.CONNECTION_NOT_AUTHORIZED,
                'That connection does not exist or is not available to you. Pick one from GET /api/connections.',
                HTTP_FORBIDDEN
            );
    }
}

// Retry (issue #326): re-run the thread head's command as a FRESH attempt in the same thread — no
// session resumed — keeping the thread and its worktree. Nothing is taken from the body — the
// command, repo, executor and thread all come from the thread head at insert — and the store
// decides every refusal atomically with the insert, exactly as the follow-up's does. No lease
// token: the task is finished, nobody holds it.
export async function handleRetry(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    // Read off the authenticated request, never off the body — the create route's rule about
    // impersonation applies word for word here.
    const createdBy = callerOf(request)?.user.id ?? null;

    const idempotency = idempotencyOf(request, reply, 'retry', { id });
    if (!idempotency.ok) return reply;

    const created = await guardKeyed(
        reply,
        (e) => request.log.error({ err: e }, 'job retry failed'),
        () => store.createRetry(id, createdBy, idempotency.value, adminOf(request))
    );
    if (!created.ok) return reply;
    if (typeof created.value === 'string') return retryRefusal(reply, created.value);
    return sendQueued(reply, created.value);
}

// The edit of a queued task's command (issue #329): same id, same thread, where a stop plus a
// re-create would have burned both. The store decides every refusal atomically with the write —
// queued rows only, author only, workflow rows refused (their command is interpolated prompt
// text and the raw chat line was never stored) — so a row claimed as the request arrives
// answers 409 NOT_QUEUED instead of editing a run's input underneath its worker.
export async function handleEditJob(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const commandResult = validateCommandField(fields.command);
    if (!commandResult.ok) return bad(reply, ERROR_CODES.BAD_COMMAND, commandResult.message);

    // Read off the authenticated request, never off the body — the create route's rule about
    // impersonation applies word for word here.
    const caller = callerOf(request)?.user.id ?? null;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job edit failed'),
        () => store.editCommand(id, commandResult.value, caller)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'workflow') {
        return reply.code(HTTP_CONFLICT).send({
            error: "The task's command is built by its workflow's prompt",
            code: ERROR_CODES.WORKFLOW_COMMAND_FROZEN,
        });
    }
    if (result.value === 'forbidden') {
        return reply.code(HTTP_FORBIDDEN).send({
            error: 'Only the account that queued the task can edit its command',
            code: ERROR_CODES.FORBIDDEN,
        });
    }
    if (result.value.result === 'not_queued') {
        return reply.code(HTTP_CONFLICT).send({
            error: `Task is ${result.value.status} — only a queued task's command can be edited`,
            code: ERROR_CODES.NOT_QUEUED,
            status: result.value.status,
        });
    }
    return reply.code(HTTP_OK).send({ id, status: 'queued', command: result.value.command });
}

// The user's verdict that the task is done — the one no run can make. Idempotent in the store, so
// a retried click answers the same instant rather than rewriting it. `force` closes a live batch's
// thread too (docs/batches.md): the batch stops it and cancels its task, 202 while the stopped run
// settles, and the PR it opened stays open, named in the answer.
export async function handleDone(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;
    const { force = false } = body(request.body);
    if (typeof force !== 'boolean') return bad(reply, ERROR_CODES.BAD_BODY, 'force must be a boolean');
    // The actor comes from the session, never a body — the same rule as create.
    const by = callerOf(request)?.user.id ?? null;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job done failed'),
        () => store.markDone(id, by)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'batch') {
        return force ? forceCloseBatchThread(orgs, { request, reply }, { id, by }) : liveBatchThreadRefusal(reply);
    }
    if (result.value === 'conflict') {
        return reply.code(HTTP_CONFLICT).send({ error: 'Task is not finished', code: ERROR_CODES.NOT_FINISHED });
    }
    return reply.code(HTTP_OK).send({ id, status: result.value.status, doneAt: result.value.doneAt });
}

// The user's stop. Two fates in one answer: a queued (never started) or a
// running row whose lease has already expired (#152) is settled `stopped` directly — the turn is
// over — while a running row under a live lease is left running and stamped, and the WORKER
// settles it when its next heartbeat reports the stamp (suspend lands `stopped` under the flag).
// Either way the turn ends and the session stays, so the follow-up composer is what the member
// sees next. 202 for the moving case, because the request RIDES to the worker and the settle
// lands moments later.
export async function handleStop(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job stop failed'),
        // The actor comes from the session, never a body — the same rule as create.
        () => store.stop(id, callerOf(request)?.user.id ?? null)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value.result === 'conflict') {
        return reply.code(HTTP_CONFLICT).send({
            error: `Task is ${result.value.status} — nothing to stop`,
            code: ERROR_CODES.NOT_STOPPABLE,
            status: result.value.status,
        });
    }
    if (result.value.result === 'requested') {
        return reply
            .code(HTTP_ACCEPTED)
            .send({ id, status: 'running', cancelRequestedAt: result.value.cancelRequestedAt });
    }
    return reply.code(HTTP_OK).send({ id, status: 'stopped' });
}

// A thread that backs a batch task is the batch's history: remove and reopen refuse it (docs/batches.md).
const batchThreadRefusal = (reply: FastifyReply) =>
    reply.code(HTTP_CONFLICT).send({
        error: 'This task is part of a batch — cancel or retry it through the batch',
        code: ERROR_CODES.BATCH_TASK_THREAD,
    });

// A forced done on a live batch's thread: the batch stops it, cancels its task and closes it — 202
// while the stopped run settles. `outcome` is `kept` when the task was already accepted or its batch
// ended first. The PR it opened stays open, named in the answer.
async function forceCloseBatchThread(
    orgs: OrgRegistry,
    { request, reply }: { request: FastifyRequest; reply: FastifyReply },
    { id, by }: { id: string; by: string | null }
) {
    const batches = (await orgs.for(orgOf(request)))?.batches;
    if (!batches) return liveBatchThreadRefusal(reply);
    const closed = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'batch thread close failed'),
        () => batches.closeTask(id, by)
    );
    if (!closed.ok) return reply;
    if (!closed.value) return liveBatchThreadRefusal(reply);
    const { batchId, task, outcome, pr, doneAt } = closed.value;
    return reply.code(doneAt ? HTTP_OK : HTTP_ACCEPTED).send({ id, batch: batchId, task, outcome, pr, doneAt });
}

// A plain done on a live batch's thread: the batch closes it when it ends, or a person forces it.
const liveBatchThreadRefusal = (reply: FastifyReply) =>
    reply.code(HTTP_CONFLICT).send({
        error:
            'This task is part of a live batch — the batch closes it when it ends. Pass --force (force: true) ' +
            'to stop it and cancel its batch task now: never retried, and a required task holds its stage ' +
            'until the batch is cancelled',
        code: ERROR_CODES.BATCH_TASK_THREAD,
    });

// The user's remove: the thread is gone and a worktree reclaim is queued. Person-gated like every
// job write here, not just because the driver has no use for it — the board secret deleting the
// audit rows of jobs it never held would be exactly the thread-read hole again.
export async function handleRemove(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job remove failed'),
        // The actor comes from the session, never a body — the same rule as create. It rides the
        // task_reclaim row: the thread rows are deleted in the same transaction.
        () => store.removeThread(id, callerOf(request)?.user.id ?? null)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'conflict') {
        return reply
            .code(HTTP_CONFLICT)
            .send({ error: 'The task is still running — stop it first', code: ERROR_CODES.TASK_RUNNING });
    }
    if (result.value === 'batch') return batchThreadRefusal(reply);
    return reply.code(HTTP_OK).send({ id, removed: true });
}

// The user's wait-cancel (issue #328): ends the durable PR wait a thread is parked on, so a
// missed webhook or a changed mind does not strand the thread forever. A person's action on a
// wait no worker holds a lease on — no lease token, actor off the session like stop/done/remove.
// Author-scoped in the store: the woken continuation would run in the author's worktree.
export async function handleWaitCancel(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job wait-cancel failed'),
        () => store.cancelWait(id, callerOf(request)?.user.id ?? null, adminOf(request))
    );
    if (!result.ok) return reply;
    // The string members are exactly the shared refusals; the object members differ per verb.
    if (typeof result.value === 'string') return waitControlRefusal(reply, result.value);
    return reply.code(HTTP_OK).send({ id, cancelled: true });
}

// The user's wait-poke (issue #328): re-evaluate the parked PR now — the wake transaction the
// sweep runs, minus the pending gate, because webhooks are the board's only GitHub input and the
// motivating case is one that never arrived. `woken: false` is an honest answer (nothing parked,
// already woken, an active member), never an error.
export async function handleWaitPoke(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job wait-poke failed'),
        () => store.pokeWait(id, callerOf(request)?.user.id ?? null, adminOf(request))
    );
    if (!result.ok) return reply;
    if (typeof result.value === 'string') return waitControlRefusal(reply, result.value);
    return reply.code(HTTP_OK).send({ id, woken: result.value.woken });
}

// The user's reopening of a done task (issue #327): done's inverse. Person-gated like done/remove
// — a person's verdict on a task no worker holds — and it takes no lease token for the same
// reason. The store refuses atomically: a task that was never done, one whose worktree a reclaim
// already removed (a follow-up would have nothing to resume in), and one whose worktree is being
// removed right now (retry once the reclaim settles) are all conflicts.
export async function handleReopen(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job reopen failed'),
        () => store.reopen(id)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'batch') return batchThreadRefusal(reply);
    if (result.value === 'not_done') {
        return reply.code(HTTP_CONFLICT).send({ error: 'Task is not done', code: ERROR_CODES.TASK_NOT_DONE });
    }
    if (result.value === 'reclaimed') {
        return reply.code(HTTP_CONFLICT).send({
            error: "The task's worktree was already reclaimed",
            code: ERROR_CODES.WORKTREE_RECLAIMED,
        });
    }
    if (result.value === 'reclaiming') {
        return reply.code(HTTP_CONFLICT).send({
            error: "A driver is removing the task's worktree — retry once the reclaim settles",
            code: ERROR_CODES.RECLAIM_IN_PROGRESS,
        });
    }
    return reply.code(HTTP_OK).send({ id, reopened: true });
}

// The driver's poll of the worktree-reclaim queue: the rows POST /remove left behind for
// worktrees no live driver holds a lease on. Claim and ack are the worker routes the job
// claim/complete are, and the body matches: the worker name is required (it is queued for
// exactly this claim), and an idle poll answers 204 rather than a parsed null.
export async function handleReclaimsClaim(
    orgs: OrgRegistry,
    firstReclaimClaim: BoardScanner,
    request: FastifyRequest,
    reply: FastifyReply
) {
    const claimRoute = await resolveClaimRoute<keyof JobReclaimStore>(orgs, request, reply);
    if (!claimRoute) return reply;
    const { boards, worker, lease } = claimRoute;

    const reclaimFailed = (e: Error) => request.log.error({ err: e }, 'reclaim claim failed');
    const claim = await guard(reply, reclaimFailed, () =>
        firstReclaimClaim(boards, reclaimFailed, (board) => board.claimReclaim(worker, lease))
    );
    if (!claim.ok) return reply;
    if (claim.value === null) return reply.code(HTTP_NO_CONTENT).send();
    return reply.code(HTTP_OK).send(claim.value);
}

// The driver's proof that a parked worktree is gone. Only the acquisition that holds the row may
// ack it — its token, never the worker name — so a re-offered row survives a stale ack, and the
// identical ack replayed after a lost response answers 200 again.
export async function handleReclaimsAck(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobReclaimStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { token } = body(request.body);
    if (typeof token !== 'string' || !UUID.test(token))
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'token must be a uuid');

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'reclaim ack failed'),
        () => store.ackReclaim(id, token)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return noSuchReclaim(reply);
    if (result.value === 'lost') return reclaimNotYours(reply);
    return reply.code(HTTP_OK).send({ id });
}

// The driver's renewal of a reclaim it is still removing: the lease is extended while the token
// still owns the row, so a deletion longer than the claim's lease is never re-offered under it.
export async function handleReclaimsRenew(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobReclaimStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { token, leaseSeconds: requested } = body(request.body);
    if (typeof token !== 'string' || !UUID.test(token))
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'token must be a uuid');
    const lease = leaseSeconds(requested);
    if (lease === null) {
        return bad(reply, ERROR_CODES.BAD_LEASE, `leaseSeconds must be an integer 1..${LEASE_SECONDS_MAX}`);
    }

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'reclaim renew failed'),
        () => store.renewReclaim(id, token, lease)
    );
    if (!result.ok) return reply;
    if (result.value.result === 'missing') return noSuchReclaim(reply);
    if (result.value.result === 'lost') return reclaimNotYours(reply);
    return reply.code(HTTP_OK).send({ leaseExpiresAt: result.value.leaseExpiresAt });
}

const noSuchReclaim = (reply: FastifyReply) =>
    reply.code(HTTP_NOT_FOUND).send({ error: 'No such reclaim', code: ERROR_CODES.NOT_FOUND });
const reclaimNotYours = (reply: FastifyReply) =>
    reply.code(HTTP_CONFLICT).send({ error: 'Reclaim is not yours', code: ERROR_CODES.LEASE_LOST });

// The worker's verdict that the run is over. The 200 body carries `threadDone` — the store's
// answer, computed in the same transaction as the verdict, to whether the job's whole thread is
// finished AND the user has closed it (a `done_at` on some member): it is the driver's only
// worktree-reclaim signal, and it rides the lease-guarded complete rather than a thread read, so a
// worker credential can never pull the audit data of jobs it does not hold (see docs/auth.md). A
// thread that merely finished keeps its tree. `reclaimId` names the reclaim row a threadDone verdict
// queued claimed by this worker (issue #821): the driver acks it once the tree is gone.
export async function handleCompleteJob(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobWorkerStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const { leaseToken } = fields;
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const parsed = validateVerdictBody(fields);
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job complete failed'),
        () => store.complete(id, leaseToken, parsed.value)
    );
    if (!result.ok) return reply;
    if (result.value.result !== 'ok') {
        if (result.value.result === 'missing') return notFoundJob(reply);
        // A conclusion the attempt staged is its outcome (issue #821): a different verdict is refused.
        if (result.value.result === 'conflict') return conclusionConflict(reply);
        return leaseLost(reply);
    }
    return reply.code(HTTP_OK).send({
        id,
        status: parsed.value.status,
        threadDone: result.value.threadDone,
        reclaimId: result.value.reclaimId,
    });
}

export async function handleGetJob(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobReadStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    // The settle long-poll (issue #323): `?waitFor=terminal&timeout=<s>` holds the request —
    // store-side, one indexed re-read every 250ms — until the thread's chain head reaches a
    // terminal status or an open PR wait stands on it, or the (capped) timeout elapses, then
    // answers `{ result, rootJobId, headJobId, headStatus, waitReason, job }` — the explicit wait
    // result (`terminal` | `parked` | `timeout`), so the client never infers it from timing. A
    // timeout is re-issued by the client. An unknown id is a 404 without any hold.
    const wait = validateWaitQuery(request.query as { waitFor?: unknown; timeout?: unknown });
    if (!wait.ok) return bad(reply, wait.code, wait.message);
    const timeoutMs = wait.value?.timeoutMs;
    let outcome: SettleOutcome | null = null;
    if (timeoutMs !== undefined) {
        const settled = await guard(
            reply,
            (e) => request.log.error({ err: e }, 'job wait failed'),
            () => store.waitForSettle(id, timeoutMs)
        );
        if (!settled.ok) return reply;
        if (settled.value === null) return notFoundJob(reply);
        outcome = settled.value;
    }

    const job = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job read failed'),
        () => store.get(id)
    );
    if (!job.ok) return reply;
    if (job.value === null) return notFoundJob(reply);
    return reply.code(HTTP_OK).send(outcome ? { ...outcome, job: job.value } : job.value);
}

// The run-activity read (issue #339): the run's own progress-over-time chart, bucketed from the
// session telemetry the executor already reported, beside the run's and the task's gate and PR
// activity (issue #983), which the board records itself. A person route, like the job read it extends —
// the org boundary is twice: `store.get` reads the job in the caller's org, and `fetchTaskFacts`
// resolves the task only through `job_execution.org_id` rows of that org. TELEMETRY_SOURCE=off is not
// a refusal: gates and PRs answer, and the token figures say `unavailable`.
export async function handleJobActivity(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobReadStore>(orgs, request, reply);
    if (!route) return reply;
    const { id } = route;

    const telemetry = await telemetryFor(orgs, request);

    const job = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job read failed'),
        () => route.store.get(id)
    );
    if (!job.ok) return reply;
    if (job.value === null) return notFoundJob(reply);
    const run = job.value;
    // The canonical task is resolved from the job's own execution rows, so a run, a follow-up and a
    // named review answer the same `task`. A job nobody ever claimed falls back to its thread root.
    const read = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job activity read failed'),
        async () => {
            const tokens = await tokenActivity(telemetry, run, id);
            // Task membership is the board's (thread plus named reviews), never telemetry's: the same jobs with telemetry on, off or failing.
            const taskJobIds = await route.store.taskJobIds(id);
            const jobIds = [...new Set([id, ...taskJobIds])];
            const records = await route.store.activityRecords(jobIds);
            return { tokens, jobIds, records };
        }
    );
    if (!read.ok) return reply;
    const { tokens, jobIds, records } = read.value;
    const activity = tokens.read?.run ?? null;
    // Nothing measured is not a quiet run: `usage.state` says unmeasured (or unavailable) and `buckets` stays empty.
    return reply.code(HTTP_OK).send({
        jobId: id,
        sessionId: run.sessionId,
        from: activity?.from ?? null,
        to: activity?.to ?? null,
        bucketMs: activity?.bucketMs ?? null,
        buckets: activity?.buckets ?? [],
        usage: activity?.usage ?? emptyBlock(tokens.read ? 'unmeasured' : 'unavailable'),
        task: tokens.read?.task ?? null,
        gates: gateActivityOf(records, [id]),
        prs: prActivityOf(records, [id]),
        taskActivity: { gates: gateActivityOf(records, jobIds), prs: prActivityOf(records, jobIds) },
    });
}

/** The token half of the activity read; `read` is null when telemetry is off or unreachable. */
async function tokenActivity(telemetry: Awaited<ReturnType<typeof telemetryFor>>, run: Job, id: string) {
    if (!telemetry) return { read: null };
    try {
        const { taskId, facts } = await telemetry.fetchTaskFacts({ jobId: id, rootJobId: run.rootJobId, edits: true });
        return { read: buildRunActivity(facts, taskId, id, new Date()) };
    } catch (e) {
        if (e instanceof TelemetryError) return { read: null };
        throw e;
    }
}

// The whole follow-up chain containing this task, oldest first. ANY member resolves to the same
// conversation — the UI keeps one task per thread, so the URL may name the root or any adjustment
// and the page must not change identity underneath the reader.
export async function handleThread(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobReadStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const jobs = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job thread read failed'),
        () => store.thread(id)
    );
    if (!jobs.ok) return reply;
    if (jobs.value === null) return notFoundJob(reply);
    return reply.code(HTTP_OK).send({ jobs: jobs.value });
}

export async function handleListJobs(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor<keyof JobReadStore>(orgs, request);
    if (!store) return noBoard(reply);
    const parsed = validateListQuery(request.query as { status?: string; limit?: string; repo?: string });
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);

    const jobs = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job list failed'),
        () => store.list(parsed.value)
    );
    if (!jobs.ok) return reply;
    return reply.code(HTTP_OK).send({ jobs: jobs.value });
}
