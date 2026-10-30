import { ERROR_CODES, EXECUTOR_TYPES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerOf } from '../../auth/plugin.js';
import type { OrgRegistry } from '../../orgs.js';
import { refusedAsUnusable } from './executor-usable.js';
import { type FairBoardScanner, boardsFor, executorsFor, reposFor, storeFor, workflowsFor } from './job-context.js';
import { parseConnectionIds } from '../connections.js';
import { resolveLaunchWorkflow } from './job-workflow-resolution.js';
import { createIdempotencyOf, guardKeyed, sendQueued } from './job-idempotency.js';
import {
    type ResolvedWorkflow,
    validateCommandField,
    validateExecutorField,
    validateExecutorScopeField,
    validateRepoField,
    validateSkillsField,
    validateVerdictBody,
} from './job-field-validation.js';
import { validateGates } from './job-gate-validation.js';
import { skillCatalog } from '../../skills.js';
import { bad, body, checkReposVisible, guard } from '../helpers.js';
import { resolveClaimRoute, resolveJobRoute } from '../route-guards.js';
import { UUID } from '../../identifiers.js';
import type { ClaimPollOutcome } from '../../metrics.js';
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
import type { JobActionStore } from '../../db/jobs/job-store-actions.js';
import type { JobAdmissionStore } from '../../db/jobs/job-store-admission.js';
import type { JobClaimStore } from '../../db/jobs/job-store-claim.js';
import type { JobConclusionStore } from '../../db/jobs/job-store-conclusions.js';
import type { JobReadStore } from '../../db/jobs/job-store-reads.js';
import type { JobWorkerStore } from '../../db/jobs/job-store-worker.js';

/**
 * A task runs against a repository: it must be one this board tracks (the org's repo list).
 * Revalidated here, whatever the browser believed. A miss invalidates the cached list and asks once
 * more before refusing, so a repo that became visible after the last read is not refused for the
 * cache's age; a miss while the list read has an error is a 503, never `UNKNOWN_REPO`
 * (`checkReposVisible`). Follow-up and retry are not re-checked: they inherit the root's repo.
 * True when a refusal (or a failed read) has already landed on `reply`.
 */
async function refusedAsUntracked(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { repos: Awaited<ReturnType<typeof reposFor>>; repo: string | null }
): Promise<boolean> {
    const { repos, repo } = opts;
    if (repo === null) {
        bad(reply, ERROR_CODES.BAD_REPO, 'repo is required: name the repository the task runs against (owner/name)');
        return true;
    }
    if (!repos) return false;
    const [owner, name] = repo.split('/') as [string, string];
    const check = async () =>
        guard(
            reply,
            (e) => request.log.error({ err: e }, 'repo list read failed'),
            () => checkReposVisible(repos, [{ owner, name }], { subject: 'the repository' })
        );
    let checked = await check();
    if (!checked.ok) return true;
    if (!checked.value.ok) {
        repos.invalidate();
        checked = await check();
        if (!checked.ok) return true;
    }
    const verdict = checked.value;
    if (verdict.ok) return false;
    bad(reply, verdict.code, verdict.message, verdict.status);
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
    const store = await storeFor<keyof JobActionStore>(orgs, request);
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
    if (
        await refusedAsUnusable(request, reply, {
            executors: executorsStore,
            createdBy,
            executor,
            scope: executorScope,
        })
    ) {
        return reply;
    }
    if (await refusedAsUntracked(request, reply, { repos: await reposFor(orgs, request), repo })) return reply;
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

    const connectionIds = parseConnectionIds(fields.connections);
    if (typeof connectionIds === 'string') return bad(reply, ERROR_CODES.BAD_CONNECTION, connectionIds);

    const created = await guardKeyed(
        reply,
        (e) => request.log.error({ err: e }, 'job create failed'),
        () =>
            store.create(command, createdBy, {
                repo,
                executor,
                executorScope,
                skills,
                connectionIds,
                ...(workflow ? { workflow } : {}),
                idempotency: idempotency.value,
            })
    );
    if (!created.ok) return reply;
    return sendQueued(reply, created.value);
}

export async function handleClaimJob(
    claiming: { orgs: OrgRegistry; firstJobClaim: FairBoardScanner; claimPoll?: (outcome: ClaimPollOutcome) => void },
    request: FastifyRequest,
    reply: FastifyReply
) {
    const { orgs, firstJobClaim, claimPoll } = claiming;
    const claimRoute = await resolveClaimRoute<keyof (JobClaimStore & JobAdmissionStore)>(orgs, request, reply);
    if (!claimRoute) return reply;
    const { boards, worker, lease } = claimRoute;

    const claimFailed = (e: Error) => request.log.error({ err: e }, 'job claim failed');
    const claim = await guard(reply, claimFailed, () =>
        firstJobClaim(boards, claimFailed, (board, options) => board.claim(worker, lease, options))
    );
    if (!claim.ok) {
        claimPoll?.('error');
        return reply;
    }
    // 204, not 200 with a null: an idle poll is the common case and it should not have to be
    // parsed to be recognised.
    if (claim.value === null) {
        claimPoll?.('idle');
        return reply.code(HTTP_NO_CONTENT).send();
    }
    claimPoll?.('claimed');
    return reply.code(HTTP_OK).send(claim.value);
}

export async function handleHeartbeat(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobWorkerStore>(orgs, request, reply);
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
        requirementWait: beat.value.requirementWait,
    });
}

// Reported separately from the completion, and not folded into the claim: the driver mints the
// session id at spawn time, and a run that is still going is exactly when a reader wants to open
// it.
export async function handleSession(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobWorkerStore>(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { leaseToken, sessionId, agent, observed } = body(request.body);
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
        () =>
            store.session(id, leaseToken, sessionId, {
                agent:
                    typeof agent === 'string' && (EXECUTOR_TYPES as readonly string[]).includes(agent) ? agent : null,
                observed: observed === true,
            })
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
    const route = await resolveJobRoute<keyof JobWorkerStore>(orgs, request, reply);
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
    const route = await resolveJobRoute<keyof JobWorkerStore>(orgs, request, reply);
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
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
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

// The attempt's final envelope, staged under its lease before its verdict and its teardown (issue
// #821): the very body complete takes, parsed by the same validation so the staged fingerprint is
// the receipt's, with the lease renewed by `leaseSeconds`. The board commits it should the lease
// expire before the complete lands; a different one under the lease is a 409 of its own.
export async function handleConclusion(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobConclusionStore>(orgs, request, reply);
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

/**
 * The flags only a release carries: a start the runner refused is a released attempt's outcome (an
 * adoption has a runner), and a claim that waits on a leftover still terminating (BEL-160) or on a
 * connection the task asked for (BEL-174) is a release outside the budget.
 */
function releaseFlagsOf(
    raw: Record<string, unknown>,
    release: boolean
): { refused: boolean; blocked: boolean; requirement: boolean } | string {
    for (const name of ['refused', 'blocked', 'requirement'] as const) {
        if (raw[name] !== undefined && typeof raw[name] !== 'boolean') return `${name} must be a boolean`;
        if (raw[name] === true && !release) return `${name} applies to a release`;
    }
    return { refused: raw.refused === true, blocked: raw.blocked === true, requirement: raw.requirement === true };
}

/** The interruption body's fields, or the refusal message for the first bad one. */
function interruptionOf(
    raw: Record<string, unknown>
):
    | { reason: string; release: boolean; claimSeq: number | null; refused?: true; blocked?: true; requirement?: true }
    | string {
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
    const flagged = releaseFlagsOf(raw, release);
    if (typeof flagged === 'string') return flagged;
    const { refused, blocked, requirement } = flagged;
    return {
        reason,
        release,
        claimSeq: (claimSeq as number | null | undefined) ?? null,
        ...(refused ? { refused: true as const } : {}),
        ...(blocked ? { blocked: true as const } : {}),
        ...(requirement ? { requirement: true as const } : {}),
    };
}

// An attempt the infrastructure interrupted (issue #792): handed back claimable at once with its
// attempt refunded (`release`), or recorded by the claim that adopted it. Lease-guarded; a spent
// interruption budget is a 409 of its own, and the driver then treats the attempt as before.
export async function handleInterrupt(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute<keyof JobActionStore>(orgs, request, reply);
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
    const boards = await boardsFor<keyof JobReadStore>(orgs, request);
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

    const { ids, threads } = body(request.body);
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
        () => Promise.all(boards.map((board) => board.leases(ids as string[], threads === true)))
    );
    if (!answered.ok) return reply;
    const jobs = [...new Map(answered.value.flat().map((row) => [row.id, row])).values()];
    return reply.code(HTTP_OK).send({ jobs });
}
