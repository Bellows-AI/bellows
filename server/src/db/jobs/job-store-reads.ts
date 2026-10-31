/**
 * The read side the dashboard polls: one job, one thread, the job list, and the task list with its
 * filter fragments and keyset cursor.
 */

import type { Sql, Fragment } from 'postgres';
import { bindingsOf, requirementsOf } from '../connection-bindings.js';
import { type JobRow, toJobRow, type TaskRow, toTask, userRef, workspacePathFor } from './job-store-rows.js';
import type {
    Job,
    JobArtifactScope,
    JobStatus,
    JobStore,
    JobStoreContext,
    SettleOutcome,
    TaskListFilters,
    TaskListResponse,
    TaskSummary,
} from './job-store-types.js';
import type { RestoreScopeResult } from '../restore-types.js';
import type { JobLeaseInfo, JobThreadFacts } from '../lease-types.js';
import type { ActivityRecords } from '../../telemetry/run-activity.js';
import { questionsOfJobs } from './job-store-questions.js';
import { type TaskCursor, decodeCursor, encodeCursor } from '../task-summary.js';

/** The reads: a job, a thread, the task list, the settle wait, and the scopes artifacts and restore resolve against. */
export interface JobReadStore {
    /**
     * The batched lease lookup behind `POST /api/jobs/leases` (issue #301): every named id's
     * status and current lease, in no particular order. Ids this org's board does not know are
     * simply not answered — the driver reads an absent id as "no such job here". Read-only, and
     * deliberately NOT lease-guarded: the reaper holding no lease is the whole point. `withThreads`
     * adds the thread facts (issue #775) to every ROOT's row; the task-volume sweep asks for them, the group sweep does not.
     */
    leases(ids: readonly string[], withThreads?: boolean): Promise<JobLeaseInfo[]>;

    /**
     * What an artifact upload for this job is authorized against (the artifact routes): the
     * member and root it is filed under and the newest claim sequence that exists. Deliberately
     * NOT lease-guarded, and it writes nothing: a stale attempt may finish uploads to its own
     * claim prefix, and that is all it may do. Null when the org has no such job.
     */
    artifactScope(id: string): Promise<JobArtifactScope | null>;

    /**
     * The thread facts the restore reads (issue #775), authorized by the LIVE lease of `id`: the
     * root's checkpoint pointer and the thread's rows. `lost` is a known job whose lease is not
     * `leaseToken` (or is not running); `missing` an unknown one. Writes nothing.
     */
    restoreScope(id: string, leaseToken: string): Promise<RestoreScopeResult>;

    /**
     * The whole follow-up chain containing `id` — the root task and every adjustment after it,
     * oldest first. Accepts ANY member of the chain (the UI keeps one URL per conversation, so a
     * member deep in the thread must resolve to the same view): every member carries the same
     * `root_job_id` (022), which is what the read keys on. Null when `id` is not a job here.
     */
    thread(id: string): Promise<Job[] | null>;

    get(id: string): Promise<Job | null>;

    /**
     * The settle long-poll (issue #323): holds until the named job's THREAD settles — the chain
     * head (the newest member, created then id, the sidenav's rule) reaches a terminal status, or
     * an open PR wait (036) stands on the thread — the same predicate `listTasksOf` buckets by,
     * so a waiting client and the sidenav can never disagree about "still moving". Answers
     * `terminal` or `parked` the moment a read says so, `timeout` once `timeoutMs` has elapsed,
     * each with the thread's root and head identity, and null — without holding — when the org
     * holds no such job.
     */
    waitForSettle(id: string, timeoutMs: number): Promise<SettleOutcome | null>;

    /**
     * The gate executions, reused completion checks, managed PR operations and classified transcript
     * calls of these jobs (issue #983), for the activity read. Reads only; the reduction is the caller's.
     */
    activityRecords(jobIds: readonly string[]): Promise<ActivityRecords>;

    /**
     * Every job of the task `id` belongs to — its thread plus the named reviews, which carry thread
     * roots of their own — from board records, so it is the same with telemetry on, off or failing.
     * Empty when `id` is not a job in this org.
     */
    taskJobIds(id: string): Promise<string[]>;

    /**
     * Newest first. `output` is not selected — it is unbounded and no list view shows it — and
     * `gates` stays off the same way; `runtime` does travel, a bounded vitals object whose
     * `activity` line is the live summary the nav and task view render (issue #61).
     *
     * `status: 'terminal'` is the one pseudo-value, and its answer is grouped as one row per
     * TASK, not per run (#124): the settled verdicts (`succeeded`/`failed`/`dead`/`stopped` —
     * the same set the thread-done computation uses) are folded by `root_job_id`, so a finished
     * conversation with follow-ups is one row. Identity fields are the ROOT's (id, command,
     * author, created), present-tense fields the chain HEAD's (status, summary, runtime,
     * session, started) — the rule the sidenav's `chainHead` already applies — and the wall
     * clock and completion stamp are the thread's (sum and max over the members); `doneAt`
     * comes from whichever member carries the thread's done. A thread with a member still
     * queued or running is not completed and is excluded whole. Ordering is by the
     * thread's newest completion, and the limit bounds tasks. The per-run lists (no status,
     * one named status) keep their row-per-run contract — the tasks pages and sidenav group on
     * the client.
     */
    list(filter: {
        status?: JobStatus | 'terminal' | undefined;
        repo?: string | undefined;
        limit: number;
    }): Promise<Job[]>;

    /**
     * The task read model (#157): one summary per thread root — identity and authorship from the
     * ROOT row, present tense from the chain HEAD (the newest member, created then id — the
     * sidenav's chainHead rule), bucketed running/review/past exactly as `taskSections()` does in
     * the web layer, including a done task resurrected by a queued follow-up. The response
     * carries the org's whole navigation (counts and previews, immune to the page's filters) and
     * one keyset-paginated page on (activity_at, root_id) — never OFFSET. Cursor validation is
     * the caller's first line of defence and repeated here: a cursor that does not decode under
     * the handed filters throws rather than answering a page of a different question.
     */
    listTasks(filters: TaskListFilters): Promise<TaskListResponse>;
}

export async function threadOf(ctx: JobStoreContext, id: string): Promise<Job[] | null> {
    const { sql, orgId, authorJoin, authorColumns, waitLateral, publicationJoin, publicationColumns } = ctx;
    // The named row's root_job_id is the whole resolution (022): every member of the
    // conversation carries the same value, so the chain is one indexed read, oldest
    // first. If two adjustments ever landed on one parent, both come back in creation
    // order — the conversation still reads top to bottom. An absent id resolves nothing
    // and the read answers null.
    const rows = await sql<JobRow[]>`
        select job.id, command, status, attempts, max_attempts, claimed_by, created_by,
               session_id, exit_code, output, gates, runtime, repo, executor, executor_scope,
               parent_job_id, root_job_id, workflow_node, workflow_name, job.mode, done_at, cancel_requested_at, job.created_at, started_at, finished_at,
               -- The task's overall wall clock, summed over the thread the WHERE already
               -- scoped: every member carries the total, so the view reads it off any of
               -- them. A sum over all-null banks is null — nothing measurable, never zero.
               sum(wall_clock_ms) over () as task_wall_clock_ms,
               wall_clock_ms, agent_turns, setup_ms, interruptions, summary, failure_kind, failure_cause,
               wl.wait_reason, wl.waiting_since, wl.wait_terminal_reason
               ${publicationColumns}
               ${authorColumns}
        from job ${authorJoin}
        -- The thread's wait (036), carried on every member alike — the open wait first, else
        -- the most recently active terminal one, the same rule listTasksOf() applies.
        ${waitLateral}
        -- The thread's publication (036, #324), the same thread-wide rule: one row at most.
        ${publicationJoin}
        where org_id = ${orgId}
          and root_job_id = (select root_job_id from job where org_id = ${orgId} and id = ${id})
        order by job.created_at, job.id
    `;
    const [first] = rows;
    if (!first) return null;
    const questions = await questionsOfJobs(
        ctx,
        rows.map((row) => row.id)
    );
    const integrations = await integrationsOf(ctx, first.root_job_id);
    return rows.map((row) => ({
        ...toJobRow(ctx, row),
        questions: questions.get(row.id) ?? [],
        ...ownedBy(ctx.orgId, row.created_by, integrations),
    }));
}

type ThreadIntegrations = Pick<Job, 'connections' | 'bindingRevision' | 'integrationRequirements' | 'executionUser'> & {
    ownerId: string | null;
};

/**
 * What the detail reads attach to a row from its thread root. The workspace is the owner's whoever queued the row, and
 * a row queued by someone else is an admin acting for the owner: `actingFor` names the owner there.
 */
function ownedBy(
    orgId: string,
    createdBy: string | null,
    { ownerId, ...integrations }: ThreadIntegrations
): ThreadIntegrationsForRow {
    const acting = ownerId !== null && createdBy !== null && createdBy !== ownerId;
    return {
        ...integrations,
        workspacePath: ownerId === null ? workspacePathFor(orgId, createdBy) : workspacePathFor(orgId, ownerId),
        actingFor: acting ? integrations.executionUser : null,
    };
}

type ThreadIntegrationsForRow = Omit<ThreadIntegrations, 'ownerId'> & Pick<Job, 'workspacePath' | 'actingFor'>;

/** The thread root's bindings, revision and open requirements: the detail reads attach them to every row. */
async function integrationsOf(ctx: JobStoreContext, rootJobId: string): Promise<ThreadIntegrations> {
    const { sql, orgId } = ctx;
    const [root] = await sql<
        {
            binding_revision: number;
            owner_id: string | null;
            exec_id: string | null;
            exec_login: string | null;
            exec_name: string | null;
            exec_avatar_url: string | null;
        }[]
    >`
        select job.binding_revision, job.execution_user_id as owner_id, eu.id as exec_id, eu.github_login as exec_login,
               eu.display_name as exec_name, eu.avatar_url as exec_avatar_url
        from job left join app_user eu on eu.id = job.execution_user_id
        where job.org_id = ${orgId} and job.id = ${rootJobId}
    `;
    const bound = await bindingsOf(sql, orgId, rootJobId);
    const open = await requirementsOf(sql, orgId, rootJobId);
    return {
        connections: bound.map((b) => ({
            connectionId: b.connectionId,
            provider: b.provider,
            account: b.externalAccountId,
            site: b.site,
            revision: b.revision,
            source: b.source,
            live: b.live,
        })),
        bindingRevision: root?.binding_revision ?? 0,
        integrationRequirements: open,
        executionUser: root ? userRef(root.exec_id, root.exec_login, root.exec_name, root.exec_avatar_url) : null,
        ownerId: root?.owner_id ?? null,
    };
}

export async function getJob(ctx: JobStoreContext, id: string): Promise<Job | null> {
    const { sql, orgId, authorJoin, authorColumns, waitLateral, publicationJoin, publicationColumns } = ctx;
    const rows = await sql<JobRow[]>`
        select job.id, command, status, attempts, max_attempts, claimed_by, created_by,
               session_id, exit_code, output, gates, runtime, repo, executor, executor_scope,
               parent_job_id, root_job_id, workflow_node, workflow_name, job.mode, done_at, cancel_requested_at, job.created_at, started_at, finished_at,
               summary, wall_clock_ms, agent_turns, setup_ms, interruptions, failure_kind, failure_cause,
               -- The thread's wait (036) and publication (#324), served by the detail reads on
               -- the same thread-wide rule thread() follows — the per-run lists answer null.
               wl.wait_reason, wl.waiting_since, wl.wait_terminal_reason
               ${publicationColumns}
               ${authorColumns}
        from job ${authorJoin}
        ${waitLateral}
        ${publicationJoin}
        where org_id = ${orgId} and job.id = ${id}
    `;
    const row = rows[0];
    if (!row) return null;
    const questions = await questionsOfJobs(ctx, [row.id]);
    const integrations = await integrationsOf(ctx, row.root_job_id);
    return {
        ...toJobRow(ctx, row),
        questions: questions.get(row.id) ?? [],
        ...ownedBy(ctx.orgId, row.created_by, integrations),
    };
}

/**
 * The settle long-poll's one check (issue #323): where does the named job's thread stand? The
 * predicate is `listTasksOf`'s terminal rule verbatim — the chain head (newest member, created
 * then id) in `succeeded|failed|dead|stopped` is `terminal`, OR an open `workflow_wait` (036) on
 * the thread — a wait row with no terminal reason yet, the open one preferred exactly as the task
 * read prefers it — is `parked`. One indexed read; no row when the org holds no such job.
 */
export async function settleStateOf(ctx: JobStoreContext, id: string): Promise<SettleOutcome | null> {
    const { sql, orgId } = ctx;
    const rows = await sql<
        {
            root_job_id: string;
            head_id: string;
            head_status: JobStatus;
            terminal: boolean;
            wait_reason: string | null;
            parked: boolean;
        }[]
    >`
        select r.root_job_id, head.id as head_id, head.status as head_status,
               head.status in ('succeeded', 'failed', 'dead', 'stopped') as terminal,
               wl.wait_reason,
               (wl.wait_reason is not null and wl.wait_terminal_reason is null) as parked
        from (select root_job_id from job where org_id = ${orgId} and id = ${id}) r
        join lateral (
            select h.id, h.status
            from job h
            where h.org_id = ${orgId} and h.root_job_id = r.root_job_id
            order by h.created_at desc, h.id desc
            limit 1
        ) head on true
        left join lateral (
            select w.reason as wait_reason, w.terminal_reason as wait_terminal_reason
            from workflow_wait w
            where w.org_id = ${orgId} and w.root_job_id = r.root_job_id
            order by (w.completed_at is null and w.cancelled_at is null) desc, w.active_at desc
            limit 1
        ) wl on true
    `;
    const row = rows[0];
    if (!row) return null;
    return {
        // `timeout` here means "still moving": only the hold's deadline turns it into an answer.
        result: row.terminal ? 'terminal' : row.parked ? 'parked' : 'timeout',
        rootJobId: row.root_job_id,
        headJobId: row.head_id,
        headStatus: row.head_status,
        waitReason: row.parked ? row.wait_reason : null,
    };
}

/** How often the settle long-poll re-reads the thread while it holds — cheap by design. */
export const SETTLE_POLL_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The hold itself: check first (an already-settled thread answers without sleeping), then re-read
 * every `SETTLE_POLL_MS` until the deadline. No connection is held between polls — one query per
 * round, bounded by the timeout the route already capped. The answer carries its own `result`
 * (`terminal`, `parked` or `timeout`), so no caller infers why the hold ended from how long it
 * lasted. A job that vanishes mid-hold (a `removeThread` winning the race) answers null, never a
 * stale result.
 */
export async function waitForSettleOf(
    ctx: JobStoreContext,
    id: string,
    timeoutMs: number
): Promise<SettleOutcome | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const state = await settleStateOf(ctx, id);
        if (state === null) return null;
        if (state.result !== 'timeout') return state;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return state;
        await sleep(Math.min(SETTLE_POLL_MS, remaining));
    }
}

/**
 * The orphan reaper's batched lease lookup (issue #301): status and CURRENT lease token for every
 * named id this org holds, nothing for the ids it does not. No author join and no audit columns —
 * the reaper needs three facts, and a worker credential must never pull more of a row than the
 * question asked for.
 */
export async function leasesOf(
    ctx: JobStoreContext,
    ids: readonly string[],
    withThreads = false
): Promise<JobLeaseInfo[]> {
    const { sql, orgId } = ctx;
    const rows = await sql<{ id: string; status: JobStatus; lease_token: string | null }[]>`
        select id, status, lease_token from job
        where org_id = ${orgId} and id = any(${[...ids]}::uuid[])
    `;
    // Thread facts cost a subquery per root, so only the task-volume sweep (which names roots) asks for them.
    const threads = withThreads ? await threadFactsOf(ctx, ids) : new Map<string, JobThreadFacts>();
    return rows.map((row) => {
        const thread = threads.get(row.id);
        return { id: row.id, status: row.status, leaseToken: row.lease_token, ...(thread ? { thread } : {}) };
    });
}

/**
 * The thread facts of every ROOT id among `ids` (issue #775), in the one round trip the lease lookup
 * already makes. The newest attempt is the thread's newest row at its current claim sequence; a stream
 * of it with chunks and no manifest, or a `partial` manifest, is an artifact still pending.
 */
async function threadFactsOf(ctx: JobStoreContext, ids: readonly string[]): Promise<Map<string, JobThreadFacts>> {
    const { sql, orgId } = ctx;
    const rows = await sql<
        {
            id: string;
            live: boolean;
            claimed_id: string | null;
            claimed_seq: string | null;
            last_status: JobStatus | null;
            last_finished_at: Date | null;
            pending: boolean | null;
            on_last: boolean | null;
            checkpoint_truncated: boolean | null;
            checkpoint_finalized_at: Date | null;
            last_manifest_at: Date | null;
        }[]
    >`
        select r.id, r.checkpoint_truncated, r.checkpoint_finalized_at,
               exists (select 1 from job t where t.org_id = r.org_id and t.root_job_id = r.id
                       and t.status in ('queued', 'running')) as live,
               claimed.id::text as claimed_id, claimed.claim_seq as claimed_seq, last.status as last_status, last.finished_at as last_finished_at,
               (select max(m.created_at) from artifact_manifest m
                where m.org_id = r.org_id and m.job_id = last.id::text and m.claim_seq = last.claim_seq) as last_manifest_at,
               (r.checkpoint_job_id = last.id::text and r.checkpoint_claim_seq = last.claim_seq) as on_last,
               (exists (select 1 from artifact_chunk c
                        where c.org_id = r.org_id and c.root_job_id = r.id::text
                          and c.job_id = last.id::text and c.claim_seq = last.claim_seq
                          and not exists (select 1 from artifact_manifest m
                                          where m.org_id = c.org_id and m.member_id = c.member_id
                                            and m.root_job_id = c.root_job_id and m.job_id = c.job_id
                                            and m.claim_seq = c.claim_seq and m.executor = c.executor
                                            and m.session_id = c.session_id and m.stream = c.stream))
                or exists (select 1 from artifact_manifest m
                           where m.org_id = r.org_id and m.root_job_id = r.id::text
                             and m.job_id = last.id::text and m.claim_seq = last.claim_seq
                             and m.state = 'partial')) as pending
        from job r
        left join lateral (
            select t.id, t.status, t.finished_at, t.claim_seq from job t
            where t.org_id = r.org_id and t.root_job_id = r.id
            order by t.created_at desc, t.id desc limit 1
        ) last on true
        left join lateral (
            select t.id, t.claim_seq from job t
            where t.org_id = r.org_id and t.root_job_id = r.id and t.claim_seq >= 1
            order by t.created_at desc, t.id desc limit 1
        ) claimed on true
        where r.org_id = ${orgId} and r.id = any(${[...ids]}::uuid[]) and r.root_job_id = r.id
    `;
    // The thread is idle from its newest finalize: the attempt, its checkpoint, or a manifest that landed late.
    const latestOf = (row: (typeof rows)[number]): Date =>
        new Date(
            Math.max(
                row.last_finished_at?.getTime() ?? 0,
                row.checkpoint_finalized_at?.getTime() ?? 0,
                row.last_manifest_at?.getTime() ?? 0
            )
        );
    return new Map(
        rows.map((row) => {
            const finalized = row.last_status !== null && !LIVE_STATUSES.includes(row.last_status);
            const pointed = row.checkpoint_finalized_at !== null;
            let checkpoint: JobThreadFacts['checkpoint'] = 'none';
            if (pointed && row.on_last === true) checkpoint = row.checkpoint_truncated ? 'truncated' : 'complete';
            return [
                row.id,
                {
                    live: row.live,
                    lastFinalizedAt: finalized && row.last_finished_at ? latestOf(row).toISOString() : null,
                    artifactsComplete: row.pending === false,
                    checkpoint,
                    checkpointFinalizedAt: row.checkpoint_finalized_at?.toISOString() ?? null,
                    lastJobId: row.claimed_id,
                    lastClaimSeq: row.claimed_seq === null ? null : Number(row.claimed_seq),
                },
            ];
        })
    );
}

const LIVE_STATUSES: readonly JobStatus[] = ['queued', 'running'];

/**
 * The coordinates an artifact upload is filed under and the newest claim that may be named: read
 * from the row alone, never from a lease, so a superseded attempt still resolves its own claim.
 */
export async function artifactScopeOf(ctx: JobStoreContext, id: string): Promise<JobArtifactScope | null> {
    const { sql, orgId } = ctx;
    const rows = await sql<{ created_by: string | null; root_job_id: string; claim_seq: string }[]>`
        select created_by, root_job_id, claim_seq from job where org_id = ${orgId} and id = ${id}
    `;
    const row = rows[0];
    return row ? { member: row.created_by, root: row.root_job_id, claimSeq: Number(row.claim_seq) } : null;
}

/**
 * The root's checkpoint pointer and the thread's rows, for the live lease of `id` (issue #775). The
 * lease check is the claim's own: running, and the token the row holds now.
 */
export async function restoreScopeOf(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string
): Promise<RestoreScopeResult> {
    const { sql, orgId } = ctx;
    const [live] = await sql<{ root_job_id: string }[]>`
        select root_job_id from job
        where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken}
    `;
    if (!live) {
        const known = await sql`select 1 from job where org_id = ${orgId} and id = ${id}`;
        return { result: known.length > 0 ? 'lost' : 'missing' };
    }
    const [root] = await sql<
        {
            checkpoint_job_id: string | null;
            checkpoint_claim_seq: string | null;
            checkpoint_executor: string | null;
            checkpoint_session: string | null;
            checkpoint_truncated: boolean | null;
            checkpoint_cause: string | null;
            checkpoint_finalized_at: Date | null;
        }[]
    >`
        select checkpoint_job_id, checkpoint_claim_seq, checkpoint_executor, checkpoint_session,
               checkpoint_truncated, checkpoint_cause, checkpoint_finalized_at
        from job where org_id = ${orgId} and id = ${live.root_job_id}
    `;
    const rows = await sql<{ id: string; created_by: string | null; claim_seq: string }[]>`
        select id, created_by, claim_seq from job
        where org_id = ${orgId} and root_job_id = ${live.root_job_id}
        order by created_at, id
    `;
    const pointed = root?.checkpoint_job_id != null && root.checkpoint_finalized_at != null;
    return {
        result: 'ok',
        scope: {
            root: live.root_job_id,
            checkpoint: pointed
                ? {
                      jobId: root.checkpoint_job_id!,
                      claimSeq: Number(root.checkpoint_claim_seq),
                      executor: root.checkpoint_executor ?? '',
                      session: root.checkpoint_session ?? '',
                      truncated: root.checkpoint_truncated === true,
                      cause: root.checkpoint_cause,
                      finalizedAt: root.checkpoint_finalized_at!,
                  }
                : null,
            jobs: rows.map((row) => ({ id: row.id, member: row.created_by, claimSeq: Number(row.claim_seq) })),
        },
    };
}

export type ListFilter = Parameters<JobStore['list']>[0];

export async function listJobs(ctx: JobStoreContext, filter: ListFilter): Promise<Job[]> {
    const { sql, orgId, authorColumns, authorJoin } = ctx;
    const { status, repo, limit } = filter;
    // The recently-completed view asks for TASKS, not runs (#124): the terminal set folds
    // into one row per thread. Identity (id, command, author, created) comes from the
    // root; the present tense (status, summary, runtime, session, started) from the HEAD
    // — the newest member, the same resolution `chainHead` renders in the sidenav; the
    // clock and the completion stamp are the thread's sum and max; the done comes from
    // whichever member carries it (one done is the thread's). A thread with a member
    // still queued or running is not completed and is excluded whole — which
    // also makes the sum exact, because nothing in it is still banking.
    if (status === 'terminal') {
        const rows = await sql<JobRow[]>`
            with finished_thread as (
                -- The rollup rides the terminality scan: one read of the org's history
                -- answers both the settled-verdict filter and the per-thread clock and
                -- completion stamps. The order+limit below therefore binds to AGGREGATE
                -- rows, and the per-thread head and actor resolution afterwards runs for
                -- the selected tasks alone — not once per thread the retention keeps.
                select root_job_id,
                       sum(wall_clock_ms) as task_wall_clock_ms,
                       max(done_at) as done_at,
                       max(finished_at) as finished_at
                from job
                -- A named-profile review (issue #549) is its caller's evidence, not a task.
                where org_id = ${orgId} and review_of is null
                group by root_job_id
                having count(*) filter (
                    where status not in ('succeeded', 'failed', 'dead', 'stopped')
                ) = 0
            ),
            picked as (
                select finished_thread.root_job_id as root_job_id,
                       finished_thread.task_wall_clock_ms as task_wall_clock_ms,
                       finished_thread.done_at as done_at,
                       finished_thread.finished_at as finished_at
                from finished_thread
                join job on job.org_id = ${orgId} and job.id = finished_thread.root_job_id
                ${repo ? sql`where job.repo = ${repo}` : sql``}
                order by finished_thread.finished_at desc, job.created_at desc, job.id
                limit ${limit}
            )
            select job.id as id, job.command as command, head.status as status,
                   head.attempts as attempts, head.max_attempts as max_attempts,
                   head.claimed_by as claimed_by, job.created_by as created_by,
                   head.session_id as session_id,
                   head.exit_code as exit_code, head.summary as summary, head.runtime as runtime,
                   head.failure_kind as failure_kind, head.failure_cause as failure_cause,
                   head.wall_clock_ms as wall_clock_ms,
                   job.repo as repo, job.executor as executor, job.executor_scope as executor_scope,
                   job.parent_job_id as parent_job_id, job.root_job_id as root_job_id,
                   job.workflow_node as workflow_node, job.workflow_name as workflow_name,
                   job.mode as mode,
                   picked.done_at as done_at, head.cancel_requested_at as cancel_requested_at,
                   job.created_at as created_at, head.started_at as started_at,
                   picked.finished_at as finished_at,
                   picked.task_wall_clock_ms as task_wall_clock_ms
                   ${authorColumns}
            from picked
            join job on job.org_id = ${orgId} and job.id = picked.root_job_id
            join lateral (
                select h.*
                from job h
                where h.org_id = ${orgId} and h.root_job_id = job.root_job_id
                order by h.created_at desc, h.id desc
                limit 1
            ) head on true
            -- The authorship joins, aimed per member: the author is the thread's (the
            -- root's — a follow-up's creator is forced to the parent's), the stopper the
            -- head's (the status is the head's verdict), the doner the member carrying
            -- the thread's done. The shared authorJoin cannot be reused here: it binds
            -- su/du to the row's own stopped_by/done_by, which in this query is the
            -- root's.
            left join app_user cu on cu.id = job.created_by
            left join app_user su on su.id = head.stopped_by
            left join app_user du on du.id = (
                select d.done_by from job d
                where d.org_id = ${orgId} and d.root_job_id = job.root_job_id
                  and d.done_by is not null
                order by d.done_at desc, d.id desc
                limit 1
            )
            order by picked.finished_at desc, job.created_at desc, job.id
        `;
        return rows.map((row) => toJobRow(ctx, row));
    }
    const rows = await sql<JobRow[]>`
        select job.id, command, status, attempts, max_attempts, claimed_by, created_by,
               session_id, exit_code, runtime, repo, executor, executor_scope,
               parent_job_id, root_job_id, workflow_name, job.mode, done_at, cancel_requested_at, job.created_at, started_at, finished_at,
               -- The close-time summary and the run's own banked clock ride beside the
               -- vitals, both bounded where output is not (#109); the structured failure
               -- kind (044) is what a list badge or a query reads.
               summary, wall_clock_ms, agent_turns, failure_kind, failure_cause
               ${authorColumns}
        from job ${authorJoin}
        where org_id = ${orgId} ${
            // The terminal set is the branch above; this query is the per-run lists.
            status ? sql`and status = ${status}` : sql``
        }
          ${repo ? sql`and repo = ${repo}` : sql``}
        order by job.created_at desc, job.id
        limit ${limit}
    `;
    return rows.map((row) => toJobRow(ctx, row));
}

export async function listTasksOf(ctx: JobStoreContext, filters: TaskListFilters): ReturnType<JobStore['listTasks']> {
    const { sql, taskPreviewColumns, orgId } = ctx;
    const cursor = resolveTaskCursor(filters);
    const newest = filters.sort === 'newest';

    // One statement, one derived set. `head` resolves each thread's newest run exactly as
    // the sidenav's chainHead does (created desc, id desc); `task` keeps one row per ROOT
    // — the root row for identity and authorship, the head for the present tense — and
    // computes the bucket and the activity stamp once, so the state filter, the counts
    // and the previews cannot disagree. Navigation reads the set UNFILTERED (org-wide,
    // rule of the read model); the page reads it under every filter, paginated by keyset
    // on (activity_at, id) — direction flips with the sort, never an OFFSET.
    const stateWhere = taskStateWhere(sql, filters.state);
    const pageOrder = newest ? sql`activity_at desc, id desc` : sql`activity_at asc, id asc`;
    const cursorWhere = taskCursorWhere(sql, cursor, newest);

    const [row] = await sql<
        {
            counts: { running: number; review: number; past: number };
            running_preview: TaskRow[] | null;
            review_preview: TaskRow[] | null;
            page: TaskRow[] | null;
        }[]
    >`
        with head as (
            select distinct on (root_job_id)
                   root_job_id, id, status, done_at, cancel_requested_at,
                   created_at, started_at, finished_at, summary, runtime
            from job
            -- A named-profile review (issue #549) is a thread of its own, linked to its caller: it is
            -- the caller's evidence, not a task a member queued, so it is not a row of this list.
            where org_id = ${orgId} and review_of is null
            order by root_job_id, created_at desc, id desc
        ),
        task as (
            -- The root row joins back by PK from the head's root id (one index lookup per
            -- thread) rather than scanning the org's runs and filtering id = root_job_id —
            -- the EXPLAIN-measured difference between touching every run and touching one
            -- row per thread.
            select h.root_job_id as id, h.id as head_id, r.command, r.repo, r.executor, r.executor_scope, r.created_at,
                   h.status, h.done_at, h.cancel_requested_at, h.summary, h.runtime,
                   -- The sort key is truncated to milliseconds, the precision an ISO
                   -- stamp and a JS Date carry: the cursor's value round-trips EXACTLY,
                   -- so the exclusive keyset predicate cannot re-admit a row that only
                   -- differs from the boundary below the millisecond.
                   date_trunc('milliseconds',
                              greatest(h.created_at, h.started_at, h.finished_at, h.done_at)) as activity_at,
                   -- An open wait (a wait row with no terminal reason yet) is terminal for
                   -- bucketing the same way a settled status is: a thread parked on a human's
                   -- review is never "running", whatever status the row itself carries while
                   -- parked on it (206). A wait that has gone terminal carries no extra weight
                   -- here — the status/done rule alone decides, same as a thread that never waited.
                   (h.status in ('succeeded', 'failed', 'dead', 'stopped')
                       or (wl.wait_reason is not null and wl.wait_terminal_reason is null)) as terminal,
                   cu.id as creator_id, cu.github_login as creator_login,
                   cu.display_name as creator_name, cu.avatar_url as creator_avatar_url,
                   wl.wait_reason, wl.waiting_since, wl.wait_terminal_reason,
                   -- A member is wanted (050): any run of the thread holds a question the answer
                   -- route would accept (the answerable condition), evaluated per thread.
                   exists (
                       select 1 from job_question q
                       join job qj on qj.org_id = q.org_id and qj.id = q.job_id
                       where q.org_id = ${orgId} and qj.root_job_id = h.root_job_id
                         and q.state = 'pending' and qj.status = 'running'
                         and qj.lease_token = q.lease_token and qj.cancel_requested_at is null
                   ) as needs_answer
            from head h
            join job r on r.org_id = ${orgId} and r.id = h.root_job_id
            left join app_user cu on cu.id = r.created_by
            -- The thread's wait, when it has one (036): the OPEN wait first, else the most
            -- recently active terminal one — one row, so a waiting thread reads waiting and
            -- a finished wait reads what exhausted it.
            left join lateral (
                select w.reason as wait_reason, w.active_at as waiting_since,
                       w.terminal_reason as wait_terminal_reason
                from workflow_wait w
                where w.org_id = ${orgId} and w.root_job_id = h.root_job_id
                order by (w.completed_at is null and w.cancelled_at is null) desc, w.active_at desc
                limit 1
            ) wl on true
        )
        select
            (
                select json_build_object(
                           'running', count(*) filter (where not terminal),
                           'review', count(*) filter (where terminal and done_at is null),
                           'past', count(*) filter (where terminal and done_at is not null)
                       )
                from task
            ) as counts,
            (
                select coalesce(json_agg(p), '[]'::json)
                from (select ${taskPreviewColumns} from task
                      where not terminal
                      order by activity_at desc, id desc limit 3) p
            ) as running_preview,
            (
                select coalesce(json_agg(p), '[]'::json)
                from (select ${taskPreviewColumns} from task
                      where terminal and done_at is null
                      order by activity_at desc, id desc limit 5) p
            ) as review_preview,
            (
                select coalesce(json_agg(p), '[]'::json)
                from (select ${taskPreviewColumns} from task
                      where ${stateWhere}
                        ${taskQWhere(sql, filters.q)}
                        ${taskRepoWhere(sql, filters.repo)}
                        ${taskAuthorWhere(sql, filters.author)}
                        ${cursorWhere}
                      order by ${pageOrder}
                      limit ${filters.limit + 1}) p
            ) as page
    `;

    // Fetch limit + 1: the extra row is the only honest nextCursor signal — a page filled
    // exactly is not — and the cursor is minted from the last row RETURNED.
    const pageRows = (row?.page ?? []).map(toTask);
    const items = pageRows.slice(0, filters.limit);
    return {
        navigation: {
            counts: row?.counts ?? { running: 0, review: 0, past: 0 },
            running: (row?.running_preview ?? []).map(toTask),
            review: (row?.review_preview ?? []).map(toTask),
        },
        page: {
            items,
            nextCursor: nextTaskCursor(filters, pageRows.length, items),
        },
    };
}

/**
 * listTasks's cursor: the route already refused one that does not decode under the handed
 * filters, so a store call that carries one anyway is a programming error, thrown rather than
 * answered with a page of a different question.
 */
export function resolveTaskCursor(filters: TaskListFilters): TaskCursor | null {
    if (filters.cursor === undefined) return null;
    const cursor = decodeCursor(filters.cursor, filters);
    if (cursor === null) throw new Error('invalid task cursor');
    return cursor;
}

export function taskStateWhere(sql: Sql, state: TaskListFilters['state']): Fragment {
    return {
        attention: sql`not (terminal and done_at is not null)`,
        running: sql`not terminal`,
        review: sql`terminal and done_at is null`,
        past: sql`terminal and done_at is not null`,
    }[state];
}

/** The keyset predicate: direction flips with the sort, never an OFFSET. */
export function taskCursorWhere(sql: Sql, cursor: TaskCursor | null, newest: boolean): Fragment {
    if (cursor === null) return sql``;
    return newest
        ? sql`and (activity_at, id) < (${cursor.activityAt}::timestamptz, ${cursor.rootId}::uuid)`
        : sql`and (activity_at, id) > (${cursor.activityAt}::timestamptz, ${cursor.rootId}::uuid)`;
}

export function taskQWhere(sql: Sql, q: string | undefined): Fragment {
    return q === undefined ? sql`` : sql`and strpos(lower(command), lower(${q})) > 0`;
}

export function taskRepoWhere(sql: Sql, repo: string | undefined): Fragment {
    return repo === undefined ? sql`` : sql`and repo = ${repo}`;
}

export function taskAuthorWhere(sql: Sql, author: string | undefined): Fragment {
    return author === undefined ? sql`` : sql`and lower(creator_login) = lower(${author})`;
}

/**
 * Fetch limit + 1: the extra row is the only honest nextCursor signal — a page filled exactly is
 * not — and the cursor is minted from the last row RETURNED.
 */
export function nextTaskCursor(filters: TaskListFilters, pageRowCount: number, items: TaskSummary[]): string | null {
    const last = items[items.length - 1];
    if (pageRowCount <= filters.limit || last === undefined) return null;
    return encodeCursor({
        sort: filters.sort,
        state: filters.state,
        q: filters.q,
        repo: filters.repo,
        author: filters.author,
        activityAt: last.activityAt,
        rootId: last.id,
    });
}
