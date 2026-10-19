import { ERROR_CODES, executorSuspendedMessage, type ExecutorScope } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { OrgRegistry } from '../orgs.js';
import { type BoardScanner, boardsFor, executorsFor, storeFor, userReposFor, workflowsFor } from './job-context.js';
import { resolveJiraConnection } from './connections.js';
import { resolveLaunchWorkflow } from './job-workflow-resolution.js';
import { createIdempotencyOf, guardKeyed, sendQueued } from './job-idempotency.js';
import {
    type ResolvedWorkflow,
    validateCommandField,
    validateExecutorField,
    validateExecutorScopeField,
    validateGates,
    validateRepoField,
    validateSkillsField,
    validateVerdictBody,
} from './job-field-validation.js';
import { skillCatalog } from '../skills.js';
import { bad, body, guard } from './helpers.js';
import { resolveClaimRoute, resolveJobRoute } from './route-guards.js';
import { fullName, UUID } from '../config.js';
import {
    HTTP_CONFLICT,
    HTTP_NO_CONTENT,
    HTTP_NOT_FOUND,
    HTTP_OK,
    HTTP_UNAVAILABLE,
    LEASE_BATCH_MAX,
    LEASE_SECONDS_MAX,
    OUTPUT_LIMIT,
    SESSION_ID,
    conclusionConflict,
    leaseSeconds,
    leaseLost,
    noBoard,
    notFoundJob,
    runtimeVitals,
} from './job-limits.js';

/**
 * A suspended profile launches nothing (issue 440): refused with its own code, so a client is told
 * why instead of queueing a task the claim would fail. True when a refusal (or a failed read) has
 * already landed on `reply`.
 */
async function refusedAsSuspended(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: {
        executorsStore: Awaited<ReturnType<typeof executorsFor>>;
        executor: string | null;
        executorScope: ExecutorScope;
        createdBy: string | null;
    }
): Promise<boolean> {
    const { executorsStore, executor, executorScope, createdBy } = opts;
    if (!executorsStore || !createdBy || !executor) return false;
    const target = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'executor row read failed'),
        () => executorsStore.configFor(createdBy, executor, executorScope)
    );
    if (!target.ok) return true;
    if (!target.value?.suspended) return false;
    bad(reply, ERROR_CODES.EXECUTOR_SUSPENDED, executorSuspendedMessage(executorScope, executor), HTTP_CONFLICT);
    return true;
}

/**
 * A task runs against a checkout (issue 263): the repository must be in the caller's own selection
 * AND `ready`. Revalidated here, whatever the browser believed — a deselection or a failed clone
 * between page load and submit is refused, never queued. True when a refusal (or a failed read) has
 * already landed on `reply`. Skipped where no member or repo store exists: the route tests'
 * configuration, as for the suspension check above.
 */
async function refusedAsNotSynced(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { userRepos: Awaited<ReturnType<typeof userReposFor>>; repo: string | null; createdBy: string | null }
): Promise<boolean> {
    const { userRepos, repo, createdBy } = opts;
    if (!userRepos || !createdBy) return false;
    if (repo === null) {
        bad(reply, ERROR_CODES.REPO_REQUIRED, 'Select a synced repository to run this task against.');
        return true;
    }
    const selected = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'repo selection read failed'),
        () => userRepos.list(createdBy)
    );
    if (!selected.ok) return true;
    const row = selected.value.find((candidate) => fullName(candidate) === repo);
    if (row?.status === 'ready') return false;
    if (!row) {
        bad(reply, ERROR_CODES.REPO_REQUIRED, `${repo} is not in your selected repositories.`);
    } else {
        bad(
            reply,
            ERROR_CODES.REPO_NOT_READY,
            `${repo} is ${row.status}, not synced yet. Wait for it to finish syncing, then start the task.`,
            HTTP_CONFLICT
        );
    }
    return true;
}

/**
 * The create body's `skills` (issue #545): a well-formed list of installed catalog names, or null
 * once a refusal — `400 BAD_SKILLS` for the shape, `404 UNKNOWN_SKILL` naming each missing name —
 * has landed on `reply`.
 */
function selectedSkillsOf(reply: FastifyReply, raw: unknown): string[] | null {
    const result = validateSkillsField(raw);
    if (!result.ok) {
        bad(reply, ERROR_CODES.BAD_SKILLS, result.message);
        return null;
    }
    const installed = skillCatalog().map((skill) => skill.name);
    const unknown = result.value.filter((name) => !installed.includes(name));
    if (unknown.length > 0) {
        const named = unknown.map((name) => `"${name}"`).join(', ');
        bad(
            reply,
            ERROR_CODES.UNKNOWN_SKILL,
            `unknown skill ${named} (installed: ${installed.join(', ')})`,
            HTTP_NOT_FOUND
        );
        return null;
    }
    return result.value;
}

export async function handleCreateJob(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const fields = body(request.body);
    const commandResult = validateCommandField(fields.command);
    if (!commandResult.ok) return bad(reply, ERROR_CODES.BAD_COMMAND, commandResult.message);
    // The command the task runs: the member's line verbatim — or, when a workflow resolves, the
    // interpolated ENTRY prompt built below.
    let command = commandResult.value;

    const repoResult = validateRepoField(fields.repo);
    if (!repoResult.ok) return bad(reply, ERROR_CODES.BAD_REPO, repoResult.message);
    const executorResult = validateExecutorField(fields.executor);
    if (!executorResult.ok) return bad(reply, ERROR_CODES.BAD_EXECUTOR, executorResult.message);
    const scopeResult = validateExecutorScopeField(fields.executorScope);
    if (!scopeResult.ok) return bad(reply, ERROR_CODES.BAD_EXECUTOR_SCOPE, scopeResult.message);
    const repo = repoResult.value;
    const executor = executorResult.value;
    const executorScope = scopeResult.value;
    const selectedSkills = selectedSkillsOf(reply, fields.skills);
    if (selectedSkills === null) return reply;
    const skills = selectedSkills;
    // What the create asks for, as the client spelled it: the key's fingerprint, so the same key
    // with a changed body is refused rather than replayed (issue #589).
    const idempotency = createIdempotencyOf(request, reply, fields);
    if (!idempotency.ok) return reply;

    // Read off the authenticated request, never off the body: a client-supplied author is
    // impersonation. Null only when the app was built with no auth store at all, which is the
    // route tests' configuration rather than a deployment's.
    const createdBy = callerOf(request)?.user.id ?? null;

    /*
     * The workflow the task walks (issue #543's launch contract): an explicit `workflow` name
     * resolves the caller's visible scopes and freezes its snapshot onto the root row; an omitted
     * one is objective mode — nothing resolves and the raw command is the job.
     */
    const workflowsStore = await workflowsFor(orgs, request);
    const executorsStore = await executorsFor(orgs, request);
    if (await refusedAsSuspended(request, reply, { executorsStore, executor, executorScope, createdBy })) {
        return reply;
    }
    const userRepos = await userReposFor(orgs, request);
    if (await refusedAsNotSynced(request, reply, { userRepos, repo, createdBy })) return reply;
    const resolved = await resolveLaunchWorkflow(request, reply, {
        workflowsStore,
        fields,
        repo,
        createdBy,
        command,
    });
    if (resolved.handled) return reply;
    const workflow: ResolvedWorkflow | null = resolved.workflow;
    command = resolved.command;
    // Parameters are workflow-bound: sent beside an objective-mode task they are a client bug —
    // refused, never silently dropped. A named workflow already validated `workflowParams`
    // against its own definition's declarations before returning here.
    if (fields.workflowParams !== undefined && fields.workflowParams !== null && workflow === null) {
        return bad(reply, ERROR_CODES.BAD_WORKFLOW_PARAMS, 'workflowParams requires a resolved workflow');
    }

    const jira = await resolveJiraConnection(orgs, { request, reply, createdBy }, fields.jiraConnection);
    if (jira.handled) return reply;

    const created = await guardKeyed(
        reply,
        (e) => request.log.error({ err: e }, 'job create failed'),
        () =>
            store.create(command, createdBy, {
                repo,
                executor,
                executorScope,
                skills,
                jiraConnectionId: jira.id,
                ...(workflow ? { workflow } : {}),
                idempotency: idempotency.value,
            })
    );
    if (!created.ok) return reply;
    return sendCreated(reply, created.value);
}

/**
 * The answer to a create. The author's checkout row was `purging` when the insert transaction took
 * its lock (issue #92): a task cannot be queued into a checkout that is being deleted.
 */
function sendCreated(reply: FastifyReply, created: { id: string; replayed?: boolean } | 'purging') {
    if (created === 'purging') {
        return reply.code(HTTP_CONFLICT).send({
            error: 'The checkout for this task is being deleted from disk',
            code: ERROR_CODES.PURGE_IN_PROGRESS,
        });
    }
    return sendQueued(reply, created);
}

export async function handleClaimJob(
    orgs: OrgRegistry,
    firstJobClaim: BoardScanner,
    request: FastifyRequest,
    reply: FastifyReply
) {
    const claimRoute = await resolveClaimRoute(orgs, request, reply);
    if (!claimRoute) return reply;
    const { boards, worker, lease } = claimRoute;

    const claimFailed = (e: Error) => request.log.error({ err: e }, 'job claim failed');
    const claim = await guard(reply, claimFailed, () =>
        firstJobClaim(boards, claimFailed, (board) => board.claim(worker, lease))
    );
    if (!claim.ok) return reply;
    // 204, not 200 with a null: an idle poll is the common case and it should not have to be
    // parsed to be recognised.
    if (claim.value === null) return reply.code(HTTP_NO_CONTENT).send();
    return reply.code(HTTP_OK).send(claim.value);
}

export async function handleHeartbeat(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { leaseToken, leaseSeconds: requested } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const lease = leaseSeconds(requested);
    if (lease === null) {
        return bad(reply, ERROR_CODES.BAD_LEASE, `leaseSeconds must be an integer 1..${LEASE_SECONDS_MAX}`);
    }

    const beat = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job heartbeat failed'),
        () => store.heartbeat(id, leaseToken, lease)
    );
    if (!beat.ok) return reply;
    if (beat.value.result === 'missing') return notFoundJob(reply);
    // The board cannot stop a worker, only refuse it. A 409 here means this container is running
    // a job that belongs to someone else now, and it must terminate itself.
    if (beat.value.result === 'lost') return leaseLost(reply);
    // `cancelRequested` is the stop channel: the user's /stop stamped the row, and this is the
    // worker reading that it must park. False on every ordinary beat. `answeredQuestions` is the
    // answer channel (050): always present, `[]` when nothing is answered.
    return reply.code(HTTP_OK).send({
        leaseExpiresAt: beat.value.leaseExpiresAt,
        cancelRequested: beat.value.cancelRequested,
        answeredQuestions: beat.value.answeredQuestions,
    });
}

// Reported separately from the completion, and not folded into the claim: the driver mints the
// session id at spawn time, and a run that is still going is exactly when a reader wants to open
// it.
export async function handleSession(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { leaseToken, sessionId } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    // An explicit null clears the session: a refused start's minted id never ran.
    if (sessionId !== null && (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId))) {
        return bad(reply, ERROR_CODES.BAD_SESSION_ID, 'sessionId must be a short opaque token');
    }

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job session failed'),
        () => store.session(id, leaseToken, sessionId)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'lost') return leaseLost(reply);
    return reply.code(HTTP_OK).send({ id, sessionId });
}

// A rolling tail of the running attempt's output, so the dashboard shows the work while it
// happens. Separate from complete because the run has not ended — there is no verdict here, and
// the final complete report overwrites whatever this last stored. The driver owns the window:
// this stores the tail it is sent, replacing the previous one, truncated by the same rule
// complete applies. An optional `runtime` object rides beside the tail — the driver's latest
// sample of the runner container's CPU/memory plus the agent's current activity line, the
// dashboard's "is it stuck or working" answer. Absent (or null) means no fresh sample: the last
// stored one stays. Replaced, never appended, like the tail.
export async function handleOutput(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { leaseToken, output, runtime } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    if (typeof output !== 'string') {
        return bad(reply, ERROR_CODES.BAD_OUTPUT, 'output must be a string');
    }
    const vitals = runtimeVitals(runtime);
    if (typeof vitals === 'string') return bad(reply, ERROR_CODES.BAD_RUNTIME, vitals);

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job output failed'),
        () => store.progress(id, leaseToken, output.slice(0, OUTPUT_LIMIT), vitals)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'lost') return leaseLost(reply);
    return reply.code(HTTP_OK).send({ id });
}

// The verification gates a job's checkout declares, executed by the driver in the declared
// environment image. Separate from /output because the run has not ended and there is no verdict
// here; the report REPLACES the stored list, which is what makes the UI's "current/last ran only"
// honest rather than a truncation somebody has to remember.
export async function handleGates(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { leaseToken, gates } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const parsed = validateGates(gates);
    if (!parsed.ok) return bad(reply, ERROR_CODES.BAD_GATES, parsed.message);

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job gates failed'),
        () => store.gates(id, leaseToken, parsed.value)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'lost') return leaseLost(reply);
    return reply.code(HTTP_OK).send({ id });
}

// Ending a running job's attempt. Separate from complete because there is no worker outcome
// here: an exit code would have to be invented, and inventing one makes a user's stop
// indistinguishable from a run that ended on its own. The row lands `stopped` — the park is the
// user's stop landing — and the answer carries the status.
export async function handleSuspend(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { leaseToken } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job suspend failed'),
        () => store.suspend(id, leaseToken)
    );
    if (!result.ok) return reply;
    if (result.value.result === 'missing') return notFoundJob(reply);
    if (result.value.result === 'lost') return leaseLost(reply);
    if (result.value.result === 'conflict') return conclusionConflict(reply);
    return reply.code(HTTP_OK).send({ id, status: result.value.status });
}

// Handing a pre-run claim back after checkout contention (issue #559): no agent ran, so there is
// no outcome to report — the board requeues the row with its attempt refunded, or settles it
// stopped when a Stop got there first, and the answer carries which.
export async function handleRequeue(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { leaseToken } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job requeue failed'),
        () => store.requeue(id, leaseToken)
    );
    if (!result.ok) return reply;
    if (result.value.result === 'missing') return notFoundJob(reply);
    if (result.value.result === 'lost') return leaseLost(reply);
    if (result.value.result === 'conflict') return conclusionConflict(reply);
    return reply.code(HTTP_OK).send({ id, status: result.value.status });
}

// The attempt's final envelope, staged under its lease before its verdict and its teardown (issue
// #821): the very body complete takes, parsed by the same validation so the staged fingerprint is
// the receipt's, with the lease renewed by `leaseSeconds`. The board commits it should the lease
// expire before the complete lands; a different one under the lease is a 409 of its own.
export async function handleConclusion(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const { leaseToken } = fields;
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const lease = leaseSeconds(fields.leaseSeconds);
    if (lease === null) {
        return bad(reply, ERROR_CODES.BAD_LEASE, `leaseSeconds must be an integer 1..${LEASE_SECONDS_MAX}`);
    }
    const parsed = validateVerdictBody(fields);
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job conclusion failed'),
        () => store.stageConclusion(id, leaseToken, parsed.value, lease)
    );
    if (!result.ok) return reply;
    if (result.value.result === 'missing') return notFoundJob(reply);
    if (result.value.result === 'lost') return leaseLost(reply);
    if (result.value.result === 'conflict') return conclusionConflict(reply);
    return reply.code(HTTP_OK).send({ id, status: parsed.value.status });
}

/** The longest interruption reason the board records (issue #792): one driver sentence. */
const INTERRUPTION_REASON_MAX = 500;

/** The interruption body's fields, or the refusal message for the first bad one. */
function interruptionOf(
    raw: Record<string, unknown>
): { reason: string; release: boolean; claimSeq: number | null } | string {
    const { reason, release, claimSeq } = raw;
    if (typeof reason !== 'string' || !reason.trim() || reason.length > INTERRUPTION_REASON_MAX) {
        return `reason must be a non-empty string of at most ${INTERRUPTION_REASON_MAX} characters`;
    }
    if (typeof release !== 'boolean') return 'release must be a boolean';
    if (claimSeq !== undefined && claimSeq !== null && (!Number.isSafeInteger(claimSeq) || (claimSeq as number) < 1)) {
        return 'claimSeq must be a positive integer';
    }
    // An adoption records the earlier claim it adopted, never the adopter's own.
    if (!release && (claimSeq === undefined || claimSeq === null))
        return 'an adoption (release false) names its claimSeq';
    return { reason, release, claimSeq: (claimSeq as number | null | undefined) ?? null };
}

// An attempt the infrastructure interrupted (issue #792): handed back claimable at once with its
// attempt refunded (`release`), or recorded by the claim that adopted it. Lease-guarded; a spent
// interruption budget is a 409 of its own, and the driver then treats the attempt as before.
export async function handleInterrupt(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const { leaseToken } = fields;
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const interruption = interruptionOf(fields);
    if (typeof interruption === 'string') return bad(reply, ERROR_CODES.BAD_BODY, interruption);

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job interrupt failed'),
        () => store.interrupt(id, leaseToken, interruption)
    );
    if (!result.ok) return reply;
    if (result.value.result === 'missing') return notFoundJob(reply);
    if (result.value.result === 'lost') return leaseLost(reply);
    if (result.value.result === 'conflict') return conclusionConflict(reply);
    if (result.value.result === 'exhausted') {
        return bad(
            reply,
            ERROR_CODES.INTERRUPTIONS_EXHAUSTED,
            'this job has spent its interruption budget',
            HTTP_CONFLICT
        );
    }
    return reply.code(HTTP_OK).send({ id, status: result.value.status });
}

/*
 * The orphan reaper's one board route (issue #301): a batched "what does the board think of these
 * job ids" — each known id's status and CURRENT lease, absent for the ids it does not know. The
 * shared secret authenticates the driver, not an org, so like the claim this is offered every
 * org's board and the answers merge by id; uuids cannot collide across orgs. Unlike every other
 * worker route there is NO lease guard — the reaper holds no lease, and that is the whole point —
 * and it is read-only: it answers facts a terminal row's reader could already see.
 *
 * The strictness is the driver's safety: ANY board failing ⇒ 503, so a sweep is never decided by
 * a partial answer — "absent means unknown" is only true when every board that could know the id
 * actually answered.
 */
export async function handleLeases(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const boards = await boardsFor(orgs, request);
    if (!boards.length) return noBoard(reply);
    // Fail closed on the every-org worker path: boardsFor DROPS an org whose runtime failed to
    // build, and every id of a dropped board would read as "unknown to the board" — a reap
    // verdict. Answering from a partial registry is the one thing this route must never do, so a
    // registry that cannot fully answer is a 503, exactly like a board that throws. The org-less
    // shape is the worker-token path only; `none` mode falls through to the caller's own org —
    // one board IS the whole registry there, whatever foreign org rows a shared database holds.
    if (
        request.auth?.kind === 'worker' &&
        request.auth.orgId === null &&
        (await orgs.list()).length !== boards.length
    ) {
        return bad(reply, ERROR_CODES.UNAVAILABLE, 'Not every organization board answered', HTTP_UNAVAILABLE);
    }

    const { ids } = body(request.body);
    if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > LEASE_BATCH_MAX ||
        ids.some((id) => typeof id !== 'string' || !UUID.test(id))
    ) {
        return bad(reply, ERROR_CODES.BAD_ID, `ids must be 1..${LEASE_BATCH_MAX} uuids`);
    }

    const answered = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job lease lookup failed'),
        () => Promise.all(boards.map((board) => board.leases(ids as string[])))
    );
    if (!answered.ok) return reply;
    const jobs = [...new Map(answered.value.flat().map((row) => [row.id, row])).values()];
    return reply.code(HTTP_OK).send({ jobs });
}
