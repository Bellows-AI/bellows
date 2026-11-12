/**
 * Row shapes and the row-to-API mappers, plus the small SQL helpers every other job-store file
 * shares: the author join/columns fragments `createJobStore` precompiles, the
 * `exists` probe, the running-member check and the workspace-path rule.
 */

import {
    USER_SCOPE,
    WORKFLOW_MODE,
    type ExecutorScope,
    type JobMode,
    type TaskTitleOrigin,
    type UserRef,
} from '@factory-ai/core';
import type { Sql, Fragment, TransactionSql } from 'postgres';
import type {
    JobStatus,
    GateReport,
    RuntimeVitals,
    Job,
    JobInterruption,
    TaskSummary,
    JobStoreContext,
} from './job-store-types.js';
import { stagedUnderLease } from './job-store-staged.js';

/** The row's interruptions (071); the per-run lists do not select them, and serve none. */
const interruptionsOf = (row: JobRow): JobInterruption[] => row.interruptions ?? [];

export interface JobRow {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    max_attempts: number;
    claimed_by: string | null;
    created_by: string | null;
    /** The authorship joins (see authorJoin): app_user labels for created_by/stopped_by/done_by. */
    creator_id: string | null;
    creator_login: string | null;
    creator_name: string | null;
    creator_avatar_url: string | null;
    stopper_id: string | null;
    stopper_login: string | null;
    stopper_name: string | null;
    stopper_avatar_url: string | null;
    doner_id: string | null;
    doner_login: string | null;
    doner_name: string | null;
    doner_avatar_url: string | null;
    stopped_by: string | null;
    done_by: string | null;
    session_id: string | null;
    exit_code: number | null;
    output?: string | null;
    /** Absent from reads before 028 filled it; null is unmeasured, never empty. */
    summary?: string | null;
    /** The structured terminal reason (044); null is "not a failure", never "unknown". */
    failure_kind?: string | null;
    failure_cause?: string | null;
    /** Absent from the list() select — a list view shows no checks, and bounded is not free. */
    gates?: GateReport[] | null;
    /**
     * On list() rows: the vitals object is a few hundred bytes, and the task tree and the tab
     * strip render `runtime.activity` as the task's live summary — the tabs' "what is it doing"
     * answer. Unlike `output`, whose unbounded tail would tank every poll for a line no list view
     * draws.
     */
    runtime?: RuntimeVitals | null;
    repo: string | null;
    executor: string | null;
    /** Null on rows stamped before 047; reads as 'user' — the pre-391 meaning. */
    executor_scope: string | null;
    parent_job_id: string | null;
    root_job_id: string;
    /** The row's graph position (027); null on workflow-less rows and user follow-ups. */
    workflow_node: string | null;
    /** The thread's frozen workflow name (033); null on workflow-less rows. */
    workflow_name: string | null;
    /** The row's execution mode (051), inherited from the thread root. */
    mode: JobMode;
    done_at: Date | null;
    cancel_requested_at: Date | null;
    command_delivered_at: Date | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
    /** Selected by every read (the list and detail serve it); bigint reads back as a string. */
    wall_clock_ms?: string | null;
    /** Selected by the per-run reads; null is unmeasured (026). */
    agent_turns?: number | null;
    /** Only the detail reads (get/thread) select it (069); bigint reads back as a string. */
    setup_ms?: string | null;
    /** Only the detail reads (get/thread) select it (071); the per-run lists serve it empty. */
    interruptions?: JobInterruption[];
    /** Only thread() and the grouped terminal list select it; bigint (and the sum over it) read
     * back as a string. */
    task_wall_clock_ms?: string | null;
    /** Only the detail reads (get/thread) join the wait lateral; absent from the lists. */
    wait_reason?: string | null;
    waiting_since?: Date | null;
    wait_terminal_reason?: string | null;
    /** Only the detail reads (get/thread) join `job_pr` (#324); absent from the lists. */
    publication_repo?: string | null;
    publication_pr_number?: number | null;
    publication_pr_url?: string | null;
    publication_head_branch?: string | null;
    publication_base_branch?: string | null;
    /** Only the detail reads (get/thread) select the thread's effective base branch. */
    base_branch?: string | null;
    /** Only `get` selects the row's own visibility decision (132). */
    skill_hidden?: { name: string; reason: 'switched_off' | 'needs_connection' }[];
    /** The thread root's title columns (122); absent on a read that does not project them. */
    title?: string | null;
    title_origin?: TaskTitleOrigin | null;
    title_revision?: number;
}

/**
 * One row of the task summary read — the `task` CTE's projection. Page rows arrive as parsed
 * postgres rows (timestamps as Date); the navigation previews arrive inside json, where the same
 * columns read back as strings — every stamp is accepted in either shape.
 */
export interface TaskRow {
    id: string;
    head_id: string;
    command: string;
    repo: string | null;
    executor: string | null;
    executor_scope: string | null;
    created_at: Date | string;
    status: JobStatus;
    done_at: Date | string | null;
    cancel_requested_at: Date | string | null;
    summary: string | null;
    runtime: RuntimeVitals | null;
    activity_at: Date | string;
    creator_id: string | null;
    creator_login: string | null;
    creator_name: string | null;
    creator_avatar_url: string | null;
    wait_reason: string | null;
    waiting_since: Date | string | null;
    wait_terminal_reason: string | null;
    needs_answer: boolean;
    title: string | null;
    title_origin: TaskTitleOrigin | null;
    title_revision: number;
}

export const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** A stamp from either engine: a parsed Date from the row, an ISO string out of the json. */
export const stampOf = (value: Date | string | null): string | null =>
    value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

// A left join answers null columns when the uuid matched nothing; a matched row always has its
// login (not null in app_user), so id+login is the honest presence test.
export function userRef(
    id: string | null,
    login: string | null,
    name: string | null,
    avatarUrl: string | null
): UserRef | null {
    return id === null || login === null ? null : { id, login, name, avatarUrl };
}

/** `<orgId>/<userId>` when there is an author, the same rule everywhere a job row's identity path is derived. */
export function workspacePathFor(orgId: string, createdBy: string | null): string | null {
    return createdBy ? `${orgId}/${createdBy}` : null;
}

/**
 * The key-wise patch one vitals report applies to the stored `runtime` jsonb. Null numbers are
 * "not read this round" — left OUT, so the last good sample stays (the missed-sample rule, now
 * per part) — and a missing `services` key means the fleet half did not change and stays too.
 * `activity`, `sampledAt` and `memPercent` are always written: null is legitimate data for each.
 */
export function runtimePatch(runtime: RuntimeVitals): Record<string, unknown> {
    return {
        ...(runtime.cpuPercent !== null ? { cpuPercent: runtime.cpuPercent } : {}),
        ...(runtime.memUsedMb !== null ? { memUsedMb: runtime.memUsedMb } : {}),
        memPercent: runtime.memPercent,
        activity: runtime.activity,
        sampledAt: runtime.sampledAt,
        ...(runtime.services ? { services: runtime.services } : {}),
        ...(runtime.transcriptExport ? { transcriptExport: runtime.transcriptExport } : {}),
    };
}

/** Why a failed run failed: the kind, and beside a `gate`/`publish`/`helper` kind its cause. */
const failureOf = (row: JobRow): Pick<Job, 'failureKind' | 'failureCause'> => ({
    failureKind: (row.failure_kind as Job['failureKind']) ?? null,
    failureCause: (row.failure_cause as Job['failureCause']) ?? null,
});

const titleOf = (row: JobRow) => ({
    title: row.title ?? null,
    titleOrigin: row.title_origin ?? null,
    titleRevision: row.title_revision ?? 0,
});

const baseBranchOf = (row: JobRow): string | null => row.base_branch ?? null;

/** The detail reads' hidden skills, name and reason only; absent from a read that does not select them. */
const hiddenSkillsOf = (row: JobRow) =>
    row.skill_hidden ? { hiddenSkills: row.skill_hidden.map(({ name, reason }) => ({ name, reason })) } : {};

export function toJob(orgId: string, row: JobRow): Job {
    return {
        id: row.id,
        command: row.command,
        ...titleOf(row),
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        claimedBy: row.claimed_by,
        createdBy: row.created_by,
        author: userRef(row.creator_id, row.creator_login, row.creator_name, row.creator_avatar_url),
        stoppedBy: userRef(row.stopper_id, row.stopper_login, row.stopper_name, row.stopper_avatar_url),
        doneBy: userRef(row.doner_id, row.doner_login, row.doner_name, row.doner_avatar_url),
        baseBranch: baseBranchOf(row),
        ...hiddenSkillsOf(row),
        sessionId: row.session_id,
        exitCode: row.exit_code,
        output: row.output ?? null,
        summary: row.summary ?? null,
        ...failureOf(row),
        gates: row.gates ?? null,
        runtime: row.runtime ?? null,
        repo: row.repo,
        executor: row.executor,
        executorScope: (row.executor_scope ?? USER_SCOPE) as ExecutorScope,
        followUpTo: row.parent_job_id,
        rootJobId: row.root_job_id,
        workflowNode: row.workflow_node ?? null,
        workflowName: row.workflow_name ?? null,
        mode: row.mode,
        doneAt: iso(row.done_at),
        cancelRequestedAt: iso(row.cancel_requested_at),
        // The claim builds the same path only for jobs it hands out; every read carries it too,
        // which is what the task view's status sidebar shows.
        workspacePath: workspacePathFor(orgId, row.created_by),
        createdAt: row.created_at.toISOString(),
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
        wallClockMs: row.wall_clock_ms == null ? null : Number(row.wall_clock_ms),
        agentTurns: row.agent_turns ?? null,
        setupMs: row.setup_ms == null ? null : Number(row.setup_ms),
        interruptions: interruptionsOf(row),
        taskWallClockMs: row.task_wall_clock_ms == null ? null : Number(row.task_wall_clock_ms),
        waitReason: row.wait_reason ?? null,
        waitingSince: row.waiting_since ? row.waiting_since.toISOString() : null,
        waitTerminalReason: row.wait_terminal_reason ?? null,
        // A matched job_pr row is NOT NULL throughout (036), so the repo column's presence is
        // the honest test; the non-null assertions below are the receipt of that shape.
        publication:
            row.publication_repo == null
                ? null
                : {
                      repo: row.publication_repo,
                      prNumber: row.publication_pr_number!,
                      prUrl: row.publication_pr_url!,
                      headBranch: row.publication_head_branch!,
                      baseBranch: row.publication_base_branch!,
                  },
        // The detail reads (get/thread) attach the stored questions; every other read has none.
        questions: [],
        attachments: [],
        connections: [],
        bindingRevision: 0,
        integrationRequirements: [],
        executionUser: null,
        actingFor: null,
    };
}

// The task summary mapper. Deliberately NOT toJob with synthetic fields: a summary is a different
// shape with a different contract — bounded fields only, run detail (output, gates, the runtime
// object, session ids) left behind, and the head's activity line carried alone.
export function toTask(row: TaskRow): TaskSummary {
    return {
        id: row.id,
        headRunId: row.head_id,
        command: row.command,
        title: row.title,
        titleOrigin: row.title_origin,
        titleRevision: row.title_revision,
        status: row.status,
        cancelRequestedAt: stampOf(row.cancel_requested_at),
        doneAt: stampOf(row.done_at),
        repo: row.repo,
        executor: row.executor,
        executorScope: (row.executor_scope ?? USER_SCOPE) as ExecutorScope,
        author: userRef(row.creator_id, row.creator_login, row.creator_name, row.creator_avatar_url),
        activity: row.runtime?.activity ?? null,
        summary: row.summary,
        waitReason: row.wait_reason,
        waitingSince: stampOf(row.waiting_since),
        waitTerminalReason: row.wait_terminal_reason,
        needsAnswer: row.needs_answer,
        // Both are NOT NULL in the schema — created_at by the column, activity_at through
        // greatest() with created_at in it.
        createdAt: stampOf(row.created_at)!,
        activityAt: stampOf(row.activity_at)!,
    };
}

export const toJobRow = (ctx: JobStoreContext, row: JobRow): Job => toJob(ctx.orgId, row);

/** One workflow successor's insert, shared by an ordinary transition and a block-wait wake (#231)
 *  — an ordinary queued job, byte-identical either way; the caller decides which row triggers it. */
export interface WorkflowSuccessorInput {
    orgId: string;
    command: string;
    createdBy: string | null;
    repo: string | null;
    executor: string | null;
    executorScope: ExecutorScope;
    parentJobId: string;
    sessionId: string | null;
    rootJobId: string;
    workflowId: string | null;
    workflowName: string | null;
    workflowNode: string;
}

export async function insertWorkflowSuccessor(tx: TransactionSql, input: WorkflowSuccessorInput): Promise<string> {
    const rows = await tx<{ id: string }[]>`
        insert into job (org_id, command, created_by, repo, executor, executor_scope, parent_job_id, session_id, root_job_id, workflow_id, workflow_name, workflow_node, mode, skill_pin, skill_hidden)
        select ${input.orgId}, ${input.command}, ${input.createdBy}, ${input.repo},
               ${input.executor}, ${input.executorScope}, ${input.parentJobId}, ${input.sessionId}, ${input.rootJobId},
               ${input.workflowId}, ${input.workflowName}, ${input.workflowNode}, ${WORKFLOW_MODE},
               -- The predecessor's pin (BEL-273): a successor continues the same run with the same skill versions.
               coalesce((select p.skill_pin from job p where p.org_id = ${input.orgId} and p.id = ${input.parentJobId}), '[]'::jsonb),
               -- And its visibility decision (BEL-286), for the same reason.
               coalesce((select p.skill_hidden from job p where p.org_id = ${input.orgId} and p.id = ${input.parentJobId}), '[]'::jsonb)
        returning id
    `;
    return rows[0]!.id;
}

/** Separates "no such job" from "the lease is not yours" once a guarded update matched nothing. */
export async function exists(sql: Sql | TransactionSql, orgId: string, id: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`select id from job where org_id = ${orgId} and id = ${id}`;
    return rows.length > 0;
}

/** Locks the running row the lease names: its claim_seq, or why the lease holds nothing. */
export async function lockRunningAttempt(
    tx: TransactionSql,
    orgId: string,
    id: string,
    leaseToken: string
): Promise<{ claim_seq: string } | { result: 'lost' | 'missing' }> {
    const [row] = await tx<{ claim_seq: string }[]>`
        select claim_seq from job
        where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken}
        for update
    `;
    if (!row) return { result: (await exists(tx, orgId, id)) ? 'lost' : 'missing' };
    return row;
}

/** Why a read under the lease is refused, or null while the lease still holds a running attempt. */
export async function leaseRefusal(
    sql: Sql,
    orgId: string,
    id: string,
    leaseToken: string
): Promise<{ result: 'lost' | 'missing' } | null> {
    const [row] = await sql<{ lease_token: string | null; status: string }[]>`
        select lease_token, status from job where org_id = ${orgId} and id = ${id}
    `;
    if (!row) return { result: 'missing' };
    if (row.status !== 'running' || row.lease_token !== leaseToken) return { result: 'lost' };
    return null;
}

/**
 * removeThread's one refusal: a member is running. The user stops it first — the per-task
 * worktree is a live runner's checkout, and tearing it out under the container would corrupt a
 * run that was happily going.
 */
export function hasRunningMember(members: { status: JobStatus }[]): boolean {
    return members.some((member) => member.status === 'running');
}

/**
 * The Stop statement over the live rows `where` selects (a fragment over the `job` table), shared
 * by a member's Stop of one row and the cancellation of a caller's reviews (issue #549) — one
 * rule for what a stop does to a queued, a leased and an expired-lease row. `stopJob` explains it.
 */
export function stopRows(
    sql: Sql | TransactionSql,
    stop: { orgId: string; wallTick: Fragment; stoppedBy: string | null; where: Fragment }
) {
    const { orgId, wallTick, stoppedBy, where } = stop;
    return sql<{ id: string; status: JobStatus; cancel_requested_at: Date | null; root_job_id: string }[]>`
        update job set
            status = case
                when status = 'queued' then 'stopped'
                when status = 'running' and lease_expires_at <= now() then 'stopped'
                else status
            end,
            finished_at = case
                when status = 'queued' then now()
                when status = 'running' and lease_expires_at <= now() then now()
                else finished_at
            end,
            wall_clock_ms = case
                when status = 'running' and lease_expires_at <= now() then ${wallTick}
                else wall_clock_ms
            end,
            attempts = case
                when status = 'running' and lease_expires_at <= now() then greatest(attempts - 1, 0)
                else attempts
            end,
            lease_token = case
                when status = 'running' and lease_expires_at <= now() then null
                else lease_token
            end,
            lease_expires_at = case
                when status = 'running' and lease_expires_at <= now() then now()
                else lease_expires_at
            end,
            cancel_requested_at = case
                when status = 'running' and lease_expires_at > now() then coalesce(cancel_requested_at, now())
                else null
            end,
            stopped_by = coalesce(stopped_by, ${stoppedBy})
        where org_id = ${orgId} and ${where}
          and status in ('queued','running')
          -- An expired attempt that staged its conclusion is the board's to commit (issue #821).
          and not (status = 'running' and lease_expires_at <= now() and ${stagedUnderLease(sql, 'job')})
        returning id, status, cancel_requested_at, root_job_id
    `;
}

/**
 * Stops every live review of the given callers — what a caller's Stop, its verdict and its dead
 * retirement all do, so no review outlives the work it assessed (issue #549). A queued review
 * settles `stopped`, a leased one is stamped and its heartbeat delivers the kill; one that already
 * ended is left alone, which is what makes a retried Stop change nothing.
 */
export async function stopReviewsOf(
    sql: Sql | TransactionSql,
    stop: { orgId: string; wallTick: Fragment; stoppedBy: string | null },
    callerIds: readonly string[]
): Promise<void> {
    if (callerIds.length === 0) return;
    await stopRows(sql, { ...stop, where: sql`review_of = any(${[...callerIds]}::uuid[])` });
}

// The authorship joins, shared by get/thread/list: created_by, stopped_by and done_by resolve to
// app_user labels at read time, never denormalised onto the job row (logins and display names go
// stale; the join does not). Left joins on nullable uuids — a pre-accounts row or an unstamped
// action joins to nothing and reads as null, never a synthetic author. `job.` is qualified on the
// columns app_user also has (id, created_at); every other selected column exists only on job.
export function authorJoinFragment(sql: Sql): Fragment {
    return sql`
        left join app_user cu on cu.id = job.created_by
        left join app_user su on su.id = job.stopped_by
        left join app_user du on du.id = job.done_by
    `;
}

export function authorColumnsFragment(sql: Sql): Fragment {
    return sql`
        , cu.id as creator_id, cu.github_login as creator_login, cu.display_name as creator_name
        , cu.avatar_url as creator_avatar_url
        , su.id as stopper_id, su.github_login as stopper_login, su.display_name as stopper_name
        , su.avatar_url as stopper_avatar_url
        , du.id as doner_id, du.github_login as doner_login, du.display_name as doner_name
        , du.avatar_url as doner_avatar_url
    `;
}

/**
 * The thread's wait (036), joined by both detail reads (`get`, `thread`) — the open wait first,
 * else the most recently active terminal one, the rule `listTasksOf()` also applies. Correlated to
 * `job`, so it composes wherever the FROM walks the job table under that alias.
 */
export function waitLateralFragment(sql: Sql, orgId: string): Fragment {
    return sql`
        left join lateral (
            select w.reason as wait_reason, w.active_at as waiting_since,
                   w.terminal_reason as wait_terminal_reason
            from workflow_wait w
            where w.org_id = ${orgId} and w.root_job_id = job.root_job_id
            order by (w.completed_at is null and w.cancelled_at is null) desc, w.active_at desc
            limit 1
        ) wl on true
    `;
}

/**
 * The thread's publication (036, #324), joined by both detail reads (`get`, `thread`). A lateral
 * subselect, the `wl` wait lateral's exact shape: the aliased outputs keep the outer query's bare
 * `repo`/`root_job_id` unambiguous, and the primary key `(org_id, root_job_id)` guarantees one
 * row at most, so the join cannot multiply the job rows. Parameter-free on the org side —
 * `job.org_id` is the same bound org every read of this table filters by.
 */
export function publicationJoinFragment(sql: Sql): Fragment {
    return sql`
        left join lateral (
            select p.repo as publication_repo, p.pr_number as publication_pr_number,
                   p.pr_url as publication_pr_url, p.head_branch as publication_head_branch,
                   p.base_branch as publication_base_branch
            from job_pr p
            where p.org_id = job.org_id and p.root_job_id = job.root_job_id
        ) pub on true
    `;
}

/**
 * The branch a thread bases on, for the claim and every read alike: the frozen target branch of the
 * batch task the thread works, else the branch the ROOT job was created with. Neither means the
 * remote default. Indexed lookups by root, so a thread's every row reads the same value.
 */
export function threadBaseBranchFragment(sql: Sql): Fragment {
    return sql`coalesce((select tg.branch from batch_task t
                         join batch_target tg on tg.org_id = t.org_id and tg.batch_id = t.batch_id
                                             and tg.key = t.target_key
                         where t.org_id = job.org_id and t.root_job_id = job.root_job_id),
                         (select r.base_branch from job r where r.org_id = job.org_id and r.id = job.root_job_id))`;
}

/**
 * The thread ROOT's title columns for a read whose `job` alias is any member of the thread: the
 * title lives on the root only (122), so every member reads it from there.
 */
export function threadTitleColumnsFragment(sql: Sql): Fragment {
    return sql`(select r.title from job r where r.org_id = job.org_id and r.id = job.root_job_id) as title,
               (select r.title_origin from job r where r.org_id = job.org_id and r.id = job.root_job_id) as title_origin,
               (select r.title_revision from job r where r.org_id = job.org_id and r.id = job.root_job_id) as title_revision`;
}

export function publicationColumnsFragment(sql: Sql): Fragment {
    return sql`
        , pub.publication_repo, pub.publication_pr_number, pub.publication_pr_url
        , pub.publication_head_branch, pub.publication_base_branch
    `;
}

// The task summary's columns once the `task` CTE has named them — selected again inside every
// navigation-preview and page subquery, which read the derived set rather than the tables.
export function taskPreviewColumnsFragment(sql: Sql): Fragment {
    return sql`
        id, head_id, command, repo, executor, executor_scope, created_at, status, done_at, cancel_requested_at,
        summary, runtime, activity_at, creator_id, creator_login, creator_name, creator_avatar_url,
        wait_reason, waiting_since, wait_terminal_reason, needs_answer, title, title_origin, title_revision
    `;
}

/**
 * A thread that backs a batch task is the batch's history and a completed stage's evidence
 * (docs/batches.md): removing it, reopening it or closing it on a PR merge would rewrite what the
 * batch already decided, or block the task's retry. The batch's retry and cancel are the sanctioned
 * paths; done is `batchThreadState`'s.
 */
export async function backsBatchTask(tx: TransactionSql, orgId: string, rootJobId: string): Promise<boolean> {
    const rows = await tx`select 1 from batch_task where org_id = ${orgId} and root_job_id = ${rootJobId}`;
    return rows.length > 0;
}

/**
 * Whether the named job's thread backs a batch task while `BATCHES_ENABLED` is off (BEL-264): the batch
 * is hidden then, so a retry or follow-up on its thread (a new job on the batch's task) is refused. A job
 * outside a batch, a missing job, and every job with the flag on are not hidden.
 */
export async function batchThreadHidden(
    { sql, orgId, batches }: Pick<JobStoreContext, 'sql' | 'orgId' | 'batches'>,
    id: string
): Promise<boolean> {
    if (batches) return false;
    const rows = await sql`
        select 1 from job j join batch_task t on t.org_id = j.org_id and t.root_job_id = j.root_job_id
        where j.org_id = ${orgId} and j.id = ${id}
    `;
    return rows.length > 0;
}

/**
 * Whether Done may close a batch task's thread: null when no task backs it, `closed` once the
 * batch ended (completed, cancelled or expired) or a person force-closed the task — nothing will
 * retry it — and `live` otherwise, where Done would block the task's retry (docs/batches.md).
 */
export async function batchThreadState(
    tx: TransactionSql,
    orgId: string,
    rootJobId: string
): Promise<'closed' | 'live' | null> {
    const [row] = await tx<{ closed: boolean }[]>`
        select (b.completed_at is not null or b.cancelled_at is not null or b.expired_at is not null
                or t.closed_at is not null) as closed
        from batch_task t
        join batch b on b.org_id = t.org_id and b.id = t.batch_id
        where t.org_id = ${orgId} and t.root_job_id = ${rootJobId}
    `;
    if (!row) return null;
    return row.closed ? 'closed' : 'live';
}
