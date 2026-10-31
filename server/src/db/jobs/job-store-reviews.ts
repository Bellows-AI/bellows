/**
 * Independent reviewer invocation (issue #549), the store half. A review is a job row of its OWN
 * thread — `root_job_id` is its own id — linked to the caller by `review_of`, so it never contends
 * with the caller for the thread's one running row and runs in a worktree of its own. The caller
 * asks under a key (`(caller, key)` is unique: a retried or reclaimed caller gets the same review
 * back), reads the verdict by the same key, and the thread's review evidence — what the policy
 * validator reads at completion — counts the review's row as bound to the revision the caller
 * asked about. Cancellation is the rest of the lifecycle: a Stop, the caller's verdict and a
 * removal all reach the reviews (`job-store-actions.ts`, `job-store-worker.ts`).
 */

import { OBJECTIVE_MODE, USER_SCOPE, type JobMode } from '@factory-ai/core';
import type { TransactionSql } from 'postgres';
import type { ReviewEvidence } from '../evidence-policy.js';
import { readReviewEvidence } from './job-store-evidence.js';
import { LEASE_EXPIRED_REASON } from './job-store-actions.js';
import { buildClaimResult } from './job-store-claim.js';
import { withClaimAttachments } from './job-store-claim-row.js';
import { resolveClaimExecutor } from './job-store-claim-executor.js';
import { recordExecution } from './job-store-provenance.js';
import { exists, workspacePathFor } from './job-store-rows.js';
import type {
    Claim,
    FailureKind,
    JobStatus,
    JobStoreContext,
    ReadReviewResult,
    RequestReviewResult,
    ReviewerSpec,
    ReviewRequest,
    ReviewView,
} from './job-store-types.js';
import { reviewerPrompts } from '../review-prompt.js';
import { tailMatches } from '../workflows/workflow-schema.js';
import { REVIEW_BLOCKERS_MARKER, REVIEW_VERDICT_MARKER } from '../workflows/workflow-templates.js';

/** Named-profile reviews an agent requests and reads back. */
export interface JobReviewStore {
    /**
     * Starts a named reviewer's separate run over the revision the caller names (issue #549),
     * under the caller's live lease. Idempotent on `(caller, key)`: a retried or reclaimed caller
     * gets the stored review back (`existing`), never a second run. The profile must be one the
     * repository declared when the caller was claimed (`unknown_profile`); a workflow thread's
     * caller is `unsupported` — its graph owns its own review node.
     */
    requestReview(id: string, leaseToken: string, request: ReviewRequest): Promise<RequestReviewResult>;

    /** The review the caller asked for under `key`, with the thread's review evidence; lease-fenced. */
    readReview(id: string, leaseToken: string, key: string): Promise<ReadReviewResult>;
}

/**
 * The git ref one review's snapshot lives under in the shared clone, keyed by the CALLER ROW — the
 * same scope the board's uniqueness is, so a follow-up or retry (a new row of the same thread)
 * never meets a ref an earlier row made. The driver builds the same string
 * (`driver/src/review/review-snapshot.ts`) before it asks — a copy, not an import — and the board refuses
 * any other, so a request can never point a reviewer at a ref that is not this caller's.
 */
export const reviewRefOf = (callerId: string, key: string): string => `refs/factory/review/${callerId}/${key}`;

interface CallerRow {
    id: string;
    claim_seq: string;
    claimed_by: string | null;
    lease_expires_at: Date;
    root_job_id: string;
    /** The thread root's `execution_user_id`: the review is authored by the owner, not by an admin acting for them. */
    owner_id: string | null;
    repo: string | null;
    executor: string | null;
    executor_scope: string | null;
    mode: string;
    reviewers: ReviewerSpec[] | null;
}

interface ReviewRow {
    id: string;
    review_caller_seq: string | null;
    review_key: string;
    review_profile: string;
    review_revision: string;
    status: JobStatus;
    output: string | null;
    failure_kind: FailureKind | null;
}

/** The verdict a review row's output ends on: only a SUCCEEDED run's marker counts. */
function verdictOf(row: Pick<ReviewRow, 'status' | 'output'>): ReviewView['verdict'] {
    if (row.status !== 'succeeded') return 'none';
    if (tailMatches(row.output, REVIEW_BLOCKERS_MARKER)) return 'blockers';
    return tailMatches(row.output, REVIEW_VERDICT_MARKER) ? 'clean' : 'none';
}

const viewOf = (row: ReviewRow, evidence: ReviewEvidence): ReviewView => ({
    id: row.id,
    key: row.review_key,
    profile: row.review_profile,
    status: row.status,
    verdict: verdictOf(row),
    revision: row.review_revision,
    findings: row.output,
    failureKind: row.failure_kind,
    evidence,
});

async function reviewByKey(
    tx: TransactionSql,
    orgId: string,
    callerId: string,
    key: string
): Promise<ReviewRow | undefined> {
    const [row] = await tx<ReviewRow[]>`
        select id, review_caller_seq, review_key, review_profile, review_revision, status, output, failure_kind
        from job
        where org_id = ${orgId} and review_of = ${callerId} and review_key = ${key}
    `;
    return row;
}

/** The caller under its live lease, locked: the guard and the serializer of one request. */
async function lockedCaller(
    tx: TransactionSql,
    orgId: string,
    id: string,
    leaseToken: string
): Promise<CallerRow | undefined> {
    const [caller] = await tx<CallerRow[]>`
        select id, claim_seq, claimed_by, lease_expires_at, root_job_id, repo, executor, executor_scope, mode,
               (select r.execution_user_id from job r where r.org_id = job.org_id and r.id = job.root_job_id) as owner_id,
               reviewers
        from job
        where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken}
        for update
    `;
    return caller;
}

export async function requestReviewFor(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    request: ReviewRequest
): Promise<RequestReviewResult> {
    const { sql, orgId } = ctx;
    return sql.begin(async (tx): Promise<RequestReviewResult> => {
        const caller = await lockedCaller(tx, orgId, id, leaseToken);
        if (!caller) return { result: (await exists(tx, orgId, id)) ? 'lost' : 'missing' };
        // A workflow thread's graph owns its review node; a profile review belongs to the
        // objective path, whose evidence has no graph to read it from.
        if (caller.mode !== OBJECTIVE_MODE) return { result: 'unsupported' };
        const evidence = () => readReviewEvidence(tx, { orgId, rootJobId: caller.root_job_id }, null);
        const stored = await reviewByKey(tx, orgId, id, request.key);
        if (stored) return storedAnswer(ctx, tx, caller, { stored, evidence: await evidence() });
        const spec = caller.reviewers?.find((profile) => profile.name === request.profile);
        const refusal = refusalOf(caller, request, spec);
        if (refusal) return { result: refusal };
        // One review of a caller runs at a time: the next key waits for the verdict of this one.
        const running = await runningReview(tx, orgId, id);
        if (running) return { result: 'running', review: viewOf(running, await evidence()) };
        const created = await insertReview(tx, orgId, { caller, spec: spec!, request });
        const claim = await reviewClaim(ctx, tx, created.id);
        return { result: 'created', review: viewOf(created, await evidence()), claim };
    });
}

/** A finished review is answered from its row; a live one is leased to THIS caller claim. */
async function storedAnswer(
    ctx: JobStoreContext,
    tx: TransactionSql,
    caller: CallerRow,
    found: { stored: ReviewRow; evidence: ReviewEvidence }
): Promise<RequestReviewResult> {
    const { stored, evidence } = found;
    if (stored.status !== 'running') return { result: 'existing', review: viewOf(stored, evidence) };
    return { result: 'existing', ...(await leasedView(ctx, tx, caller, { row: stored, evidence })) };
}

async function runningReview(tx: TransactionSql, orgId: string, callerId: string): Promise<ReviewRow | undefined> {
    const [row] = await tx<ReviewRow[]>`
        select id, review_caller_seq, review_key, review_profile, review_revision, status, output, failure_kind
        from job where org_id = ${orgId} and review_of = ${callerId} and status = 'running'
        limit 1
    `;
    return row;
}

/** Why a new review is refused before any row is written, or null. */
function refusalOf(
    caller: CallerRow,
    request: ReviewRequest,
    spec: ReviewerSpec | undefined
): 'unknown_profile' | 'invalid_ref' | null {
    if (!spec) return 'unknown_profile';
    // The reviewer's worktree starts from this ref in the SHARED clone: it must be the one
    // snapshot namespace of this caller and key, never another's ref or a branch.
    return request.ref === reviewRefOf(caller.id, request.key) ? null : 'invalid_ref';
}

/**
 * The review row, born leased to the caller's claim: it never waits in the open queue (issue #774).
 * `id` and `root_job_id` are the SAME uuid, as a task's root row is: the review is its own thread.
 */
async function insertReview(
    tx: TransactionSql,
    orgId: string,
    new_: { caller: CallerRow; spec: ReviewerSpec; request: ReviewRequest }
): Promise<ReviewRow> {
    const { caller, spec, request } = new_;
    const [root] = await tx<{ command: string }[]>`
        select command from job where org_id = ${orgId} and id = ${caller.root_job_id}
    `;
    const { command } = reviewerPrompts(spec, root?.command ?? '');
    await tx`
        insert into job (
            org_id, command, created_by, repo, executor, executor_scope, id, root_job_id, mode,
            review_of, review_key, review_profile, review_spec, review_revision, review_ref,
            status, claimed_by, lease_token, lease_expires_at, attempts, claim_seq, started_at,
            review_caller_seq
        )
        select ${orgId}, ${command}, ${caller.owner_id}, ${caller.repo}, ${caller.executor},
               ${caller.executor_scope ?? USER_SCOPE}, x, x, ${OBJECTIVE_MODE},
               ${caller.id}, ${request.key}, ${spec.name}, ${tx.json(spec as never)}, ${request.revision}, ${request.ref},
               'running', ${caller.claimed_by}, gen_random_uuid(), ${caller.lease_expires_at}, 1, 1, now(),
               ${caller.claim_seq}
        from (select gen_random_uuid() as x) s
    `;
    return (await reviewByKey(tx, orgId, caller.id, request.key))!;
}

/**
 * The claim of a review that is running: re-leased when the caller's claim moved on (a lost runner
 * is claimed again and asks the same key — the session the lost reviewer reported resumes, the
 * superseded lease dies with its token), the same live claim handed back again when this very
 * caller claim asks twice (a response lost in flight).
 */
async function leaseRunning(
    ctx: JobStoreContext,
    tx: TransactionSql,
    caller: CallerRow,
    reviewId: string
): Promise<Claim | undefined> {
    const { orgId, wallTick } = ctx;
    // The old lease may have finished the review since the caller read it `running`: lock the row
    // and hand out a claim only for a review that still is.
    const [live] =
        await tx`select 1 from job where org_id = ${orgId} and id = ${reviewId} and status = 'running' for update`;
    if (!live) return undefined;
    const expiry = tx.json({ reason: LEASE_EXPIRED_REASON, at: new Date().toISOString() });
    await tx`
        update job set
            lease_token = gen_random_uuid(),
            claim_seq = claim_seq + 1,
            claimed_by = ${caller.claimed_by},
            lease_expires_at = ${caller.lease_expires_at},
            review_caller_seq = ${caller.claim_seq},
            interruptions = interruptions || jsonb_build_array(${expiry}::jsonb || jsonb_build_object('claimSeq', claim_seq)),
            started_at = now(),
            wall_clock_ms = case when started_at is null then wall_clock_ms else ${wallTick} end,
            runtime = null
        where org_id = ${orgId} and id = ${reviewId} and status = 'running'
          and review_caller_seq is distinct from ${caller.claim_seq}
    `;
    return reviewClaim(ctx, tx, reviewId);
}

/** A review read `running`, leased; when it finished meanwhile, its current row answers with no claim. */
async function leasedView(
    ctx: JobStoreContext,
    tx: TransactionSql,
    caller: CallerRow,
    read: { row: ReviewRow; evidence: ReviewEvidence }
): Promise<{ review: ReviewView; claim?: Claim }> {
    const { row, evidence } = read;
    const claim = await leaseRunning(ctx, tx, caller, row.id);
    if (claim) return { review: viewOf(row, evidence), claim };
    const fresh = (await reviewByKey(tx, ctx.orgId, caller.id, row.review_key))!;
    return { review: viewOf(fresh, evidence) };
}

interface ReviewClaimRow {
    id: string;
    command: string;
    attempts: number;
    max_attempts: number;
    claim_seq: string;
    lease_token: string;
    lease_expires_at: Date;
    run_as: string | null;
    session_id: string | null;
    repo: string | null;
    parent_job_id: string | null;
    executor: string | null;
    executor_scope: string | null;
    workflow_node: string | null;
    workflow_name: string | null;
    mode: JobMode;
    review_spec: ReviewerSpec;
    review_ref: string;
    resumes_interrupted: boolean;
}

/**
 * A running review's claim (issue #549, #774): the row is its own thread, leased under the profile's
 * frozen spec. What it does NOT carry is the point — no minted GitHub token and no member env
 * beyond the profile's `connections`, no gates, no publish, no helpers, no policy to enforce on
 * itself — and what it does carry that others do not is the profile's own system prompt and
 * `reviewRun`, the snapshot ref its worktree starts from and the wall-clock budget the profile
 * grants. The board decides all of it; the caller names none of it.
 */
async function reviewClaim(ctx: JobStoreContext, tx: TransactionSql, reviewId: string): Promise<Claim> {
    const { orgId, env, executorConfig } = ctx;
    await recordExecution(tx, orgId, reviewId);
    const [row] = await tx<ReviewClaimRow[]>`
        select id, command, attempts, max_attempts, claim_seq, lease_token, lease_expires_at, execution_user_id as run_as,
               session_id, repo, parent_job_id, executor, executor_scope, workflow_node, workflow_name, mode,
               review_spec, review_ref,
               (session_id is not null
                and coalesce((interruptions -> -1 ->> 'claimSeq')::bigint = claim_seq - 1, false))
                   as resumes_interrupted
        from job where org_id = ${orgId} and id = ${reviewId}
    `;
    const spec = row!.review_spec;
    const executor = await resolveClaimExecutor(tx, { env, executorConfig, grant: spec.connections }, row!);
    const claim = buildClaimResult(
        {
            ...row!,
            follow_up: false,
            root_command: row!.command,
            skills: [],
            live_providers: [],
            base_branch: null,
            last_attempt: false,
            own_session: row!.session_id !== null,
        },
        row!.id,
        {
            ...executor,
            claimPath: workspacePathFor(orgId, row!.run_as),
            claimGates: null,
            claimServices: [],
            planRevision: null,
            planRefusal: null,
            claimPolicy: null,
            claimReviewers: [],
            publish: false,
            helperPlans: undefined,
            masterPrompt: reviewerPrompts(spec, '').masterPrompt,
            turnContext: null,
            // A reviewer selects no skills and no managed connection: nothing to refuse.
            skillRefusal: null,
        }
    );
    const reviewRun = { profile: spec.name, ref: row!.review_ref, timeoutMinutes: spec.timeoutMinutes };
    // The review binds nothing: its files are the reviewed row's, and a read that throws fails the claim.
    return withClaimAttachments(tx, orgId, { ...claim, reviewRun });
}

export async function readReviewFor(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    key: string
): Promise<ReadReviewResult> {
    const { sql, orgId } = ctx;
    return sql.begin(async (tx): Promise<ReadReviewResult> => {
        const caller = await lockedCaller(tx, orgId, id, leaseToken);
        if (!caller) return { result: (await exists(tx, orgId, id)) ? 'lost' : 'missing' };
        const row = await reviewByKey(tx, orgId, id, key);
        if (!row) return { result: 'unknown' };
        const evidence = await readReviewEvidence(tx, { orgId, rootJobId: caller.root_job_id }, null);
        // A running review is the caller claim's to supervise: a re-claimed caller that reads it
        // (a different key's request answers `running`) takes the lease over here.
        if (row.status === 'running')
            return { result: 'ok', ...(await leasedView(ctx, tx, caller, { row, evidence })) };
        return { result: 'ok', review: viewOf(row, evidence) };
    });
}
