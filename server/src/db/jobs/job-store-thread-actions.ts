/**
 * What members do to tasks: create, follow up, retry, edit, mark done, remove, control a parked PR wait
 * and reopen — and the reclaim a thread queues once its last member is done.
 */

import type { Sql, TransactionSql } from 'postgres';
import { type DeploymentMode, OBJECTIVE_MODE, USER_SCOPE, WORKFLOW_MODE } from '@factory-ai/core';
import { lockThreadRootInTx } from '../connection-bindings.js';
import { cancelWaitsWithEvent, insertAdminActionEvent } from './job-store-admin-event.js';
import { addFollowUpBindings, bindOnCreate } from './job-store-connections.js';
import { bindAttachmentsInTx, revokeThreadAttachmentsInTx } from './job-store-attachments.js';
import { backsBatchTask, batchThreadState, exists, workspacePathFor, hasRunningMember } from './job-store-rows.js';
import { queueReclaimIfThreadDone } from './job-store-reclaim-queue.js';
import { recordCreateDecisionInTx, recordFollowUpDecisionInTx } from './job-store-skill-pin.js';
import { threadRefusalOf } from './job-store-thread-refusal.js';
import { type IdempotencyInput, replayOf, stampKey } from './job-store-idempotency.js';
import type {
    EditCommandResult,
    BatchesDisabledRefusal,
    JobStatus,
    JobStore,
    JobStoreContext,
} from './job-store-types.js';
import { markExecutionsRemoved } from './job-store-provenance.js';
import { wakeOneRound } from '../workflows/workflow-blocks/runtime.js';
import { authorOwnsFragment, terminalFragment, doneFragment, threadIdleFragment } from './job-store-sql-fragments.js';
import type { CreatedRef, CreateTarget } from './job-store-action-types.js';
import { PlanLimitError } from '../plan-limits.js';
import { refuseOverTokens } from '../plan-allowances.js';
import { refuseInactiveOrg } from '../org-status.js';

/** A workflow column's value: the JSON when a workflow was named, SQL null otherwise. */
const jsonOrNull = (sql: Sql, value: object | undefined) => (value ? sql.json(value as never) : null);

/**
 * Refuses a create once the org queues `cap` rows (its plan's queued limit), naming `queued`. The org's creates take
 * turns on one transaction lock, so two at once never both take the last place.
 */
async function refuseAtQueuedCap(tx: TransactionSql, orgId: string, cap: number | undefined): Promise<void> {
    if (cap === undefined) return;
    await tx`select pg_advisory_xact_lock(hashtextextended(${`plan:queued:${orgId}`}, 0))`;
    const [row] = await tx<{ n: number }[]>`
        select count(*)::int as n from job where org_id = ${orgId} and status = 'queued' and review_of is null
    `;
    if (row!.n >= cap) throw new PlanLimitError('queued', cap);
}

/**
 * The create's body (`createTitledJob`'s), for a caller that already holds a transaction: the batch scheduler creates
 * a task's root in the same transaction that records the decision to. `queuedCap` is the org plan's queued limit
 * the member's create is refused at, `tokenAllowance` its tokens per period (`plan-allowances.ts`), and
 * `deploymentMode` refuses it for a cloud org that is not active (`org-status.ts`); the batch scheduler passes none.
 */
export async function insertJobInTx(
    tx: TransactionSql,
    ctx: Pick<JobStoreContext, 'sql' | 'orgId'> & { githubApp?: boolean | undefined },
    {
        command,
        createdBy,
        target,
        queuedCap,
        tokenAllowance,
        deploymentMode,
    }: {
        command: string;
        createdBy: string | null;
        target: CreateTarget;
        queuedCap?: number | undefined;
        tokenAllowance?: number | undefined;
        deploymentMode?: DeploymentMode | undefined;
    }
): Promise<CreatedRef> {
    const { sql, orgId } = ctx;
    const idem = target.idempotency;
    // A repeat of a recorded request answers the row it made, before anything else is decided.
    const replayed = await replayOf(tx, orgId, createdBy, idem);
    if (replayed) return { id: replayed, replayed: true };
    if (deploymentMode) await refuseInactiveOrg(tx, orgId, deploymentMode);
    await refuseOverTokens(tx, orgId, tokenAllowance);
    await refuseAtQueuedCap(tx, orgId, queuedCap);
    // id and root_job_id are the SAME uuid, computed once in the select so the column can
    // be not null from insert — the root's root is itself (022). The workflow triple rides
    // the same insert when a workflow was named: workflow_id names what the task walks,
    // workflow_name freezes the resolved record's NAME on the row (033), workflow_node is
    // the entry the first run carries, the snapshot freezes the graph onto
    // the root — where every transition decision reads it — and workflow_params freezes the
    // validated launch values beside it (030). The mode (051) is decided here, once: no
    // named workflow is objective, and the thread inherits it.
    const mode = target.workflow ? WORKFLOW_MODE : OBJECTIVE_MODE;
    const rows = await tx<{ id: string }[]>`
            insert into job (
                org_id, command, created_by, repo, executor, executor_scope, id, root_job_id,
                workflow_id, workflow_name, workflow_node, workflow_snapshot, workflow_params, mode,
                execution_user_id, skills, base_branch, skill_pin, skill_hidden
            )
            select ${orgId}, ${command}, ${createdBy}, ${target.repo}, ${target.executor}, ${target.executorScope ?? USER_SCOPE}, x, x,
                   ${target.workflow?.id ?? null},
                   ${target.workflow?.name ?? null},
                   ${target.workflow?.node ?? null},
                   ${jsonOrNull(sql, target.workflow?.snapshot)},
                   ${jsonOrNull(sql, target.workflow?.params)},
                   ${mode},
                   ${createdBy},
                   ${sql.array([...(target.skills ?? [])])}::text[],
                   ${target.baseBranch ?? null},
                   '[]'::jsonb, '[]'::jsonb
            from (select gen_random_uuid() as x) s
            returning id
        `;
    await bindOnCreate(tx, { orgId, rootJobId: rows[0]!.id, createdBy, target });
    const jobId = rows[0]!.id;
    // Pin and hide the row's skills after its bindings, in this transaction.
    await recordCreateDecisionInTx(tx, { orgId, jobId, createdBy, target, githubApp: ctx.githubApp });
    await bindAttachmentsInTx(tx, { orgId, jobId, rootJobId: jobId, createdBy, ids: target.attachmentIds ?? [] });
    await stampKey(tx, orgId, rows[0]!.id, idem);
    return { id: rows[0]!.id };
}

/**
 * createFollowUp's body. One conditional insert: the select carries every precondition (a finished
 * thread, no done on any of its members, same author, same org), so a follow-up can never land on a
 * parent that fails one. The done is the THREAD's, as a retry reads it: markDone stamps only the
 * named row, so a follow-up on another member of a done thread refuses task_done. The per-thread
 * advisory lock below makes a racing markDone on any member impossible to answer from a stale
 * snapshot — never a done task with queued follow-up work. The author
 * predicate is null-safe (`is not distinct from`): a null caller may only follow up a parent with
 * no author — the state every pre-accounts task is in — and an authored parent refuses a caller
 * with no account, which is the read below's forbidden answer. The session ids AND the executor
 * are copied at insert, which is what makes the claim resume the parent conversation, on the
 * executor that ran it, without any new claim-side rule. The parent's root_job_id comes across
 * with them — the child joins the SAME conversation (022), whether its parent is a root or a
 * mid-chain turn.
 *
 * WHICH session: a pre-workflow thread copies the PARENT's session — the newest run's, the
 * conversation chaining forward exactly as it always has. A workflow thread copies its PRIMARY
 * session — the first `resume`-policy run's, read off the root's snapshot (design.md Decision 3):
 * the newest row of a workflow thread is often a fresh-eyes review, whose session is a side
 * branch, and a follow-up must continue the thread, not the branch. The coalesce answers the
 * parent's session when no resume run has reported one yet. A session is never a precondition —
 * only done or removed closes a task: with none to resume the child starts a fresh session, and
 * its claim delivers a recap of the earlier turns ahead of the command (`job-store-claim.ts`).
 */
export interface FollowUpRowInput {
    connectionIds?: readonly string[] | undefined;
    attachmentIds?: readonly string[] | undefined;
    orgId: string;
    parentId: string;
    command: string;
    createdBy: string | null;
    idempotency?: IdempotencyInput | undefined;
    /** The route's org-admin verdict; ignored for a null caller. */
    admin?: boolean | undefined;
    githubApp?: boolean | undefined; // the `github` connection a skill may require
}

/**
 * Whether the route's admin verdict counts: a caller with no account is never an admin. The thread's owner is its
 * root's `execution_user_id`; `created_by` on a row is the ACTOR, which differs from the owner on an admin's turn.
 */
const adminActs = (createdBy: string | null, admin: boolean | undefined): boolean =>
    admin === true && createdBy !== null;

export type FollowUpRowResult = CreatedRef | 'missing' | 'task_done' | 'not_finished' | 'forbidden';

export async function createFollowUpRow(sql: Sql, input: FollowUpRowInput): Promise<FollowUpRowResult> {
    return sql.begin((tx) => followUpInTx(tx, input));
}

/**
 * The thread root of the named job (`root_job_id` is immutable, so the unlocked read is final), locked root row then
 * thread lock — the bind's order; the claim only tries. Null when the job or its root is gone.
 */
async function lockThreadOf(tx: TransactionSql, orgId: string, id: string): Promise<string | null> {
    const [named] = await tx<{ root_job_id: string }[]>`
        select root_job_id from job where org_id = ${orgId} and id = ${id}
    `;
    if (!named) return null;
    return (await lockThreadRootInTx(tx, orgId, named.root_job_id)) ? named.root_job_id : null;
}

/**
 * Whether any member of the thread is not terminal, read under the thread's advisory lock. A missing row or a
 * non-boolean answer throws: an unconfirmed read is never "idle".
 */
async function threadBusyInTx(tx: TransactionSql, orgId: string, rootJobId: string): Promise<boolean> {
    const [row] = await tx<{ busy: boolean }[]>`
        select exists (
            select 1 from job m
            where m.org_id = ${orgId} and m.root_job_id = ${rootJobId}
              and not ${terminalFragment(tx, 'm.status')}
        ) as busy
    `;
    if (typeof row?.busy !== 'boolean') throw new Error('the thread busy read returned no answer');
    return row.busy;
}

type Admission = { rootJobId: string } | { answer: 'missing' | 'not_finished' | CreatedRef | 'forbidden' };

/**
 * What a follow-up and a retry settle before their conditional insert: the named row's thread root, the replay of a
 * recorded idempotent request, the root row then the thread lock (the bind's order; the claim only tries), and the
 * busy answer. The lock makes the eligibility check and the insert atomic with a racing done on ANY member or a claim
 * of the head. A busy thread is answered here, not from the refusal read after the insert: that read is a later
 * snapshot, and a verdict committing in between would turn not_finished into forbidden. Under the lock no member
 * leaves terminal or appears (follow-up, retry and reopen take it too), so this and the insert's idle predicate agree.
 */
async function admitThreadInsert(
    tx: TransactionSql,
    source: {
        orgId: string;
        parentId: string;
        createdBy: string | null;
        admin: boolean;
        idem: IdempotencyInput | undefined;
    }
): Promise<Admission> {
    const { orgId, parentId, createdBy, admin, idem } = source;
    // The read resolves the thread root the advisory lock below is keyed by.
    const [label] = await tx<{ root_job_id: string }[]>`
        select root_job_id from job where org_id = ${orgId} and id = ${parentId}
    `;
    if (!label) return { answer: 'missing' };
    const replayed = await replayOf(tx, orgId, createdBy, idem);
    if (replayed) return { answer: await replayedFor(tx, { orgId, parentId, createdBy, admin }, replayed) };
    if (!(await lockThreadRootInTx(tx, orgId, label.root_job_id))) return { answer: 'missing' };
    if (await threadBusyInTx(tx, orgId, label.root_job_id)) return { answer: 'not_finished' };
    return { rootJobId: label.root_job_id };
}

/** createFollowUpRow's body, for a caller that already holds a transaction (the batch scheduler's repair). */
export async function followUpInTx(tx: TransactionSql, input: FollowUpRowInput): Promise<FollowUpRowResult> {
    const { orgId, parentId, command, createdBy, idempotency: idem, connectionIds = [], attachmentIds = [] } = input;
    const admin = adminActs(createdBy, input.admin);
    const admitted = await admitThreadInsert(tx, { orgId, parentId, createdBy, admin, idem });
    if ('answer' in admitted) return admitted.answer;
    const { rootJobId } = admitted;
    const rows = await tx<{ id: string }[]>`
            with parent as (
                select id, repo, executor, executor_scope, session_id, root_job_id, workflow_name, mode
                from job
                where org_id = ${orgId} and id = ${parentId}
                  and ${terminalFragment(tx)}
                  and ${authorOwnsFragment(tx, { orgId, admin, createdBy })}
                  -- A named-profile review is not a task: a follow-up of it would run as an
                  -- ordinary job with the author's full env and token.
                  and review_of is null
                for update
            ),
            root as (
                select root.id as root_id, root.workflow_snapshot as snapshot
                from parent, job root
                where root.org_id = ${orgId} and root.id = parent.root_job_id
            ),
            primary_session as (
                select
                    case
                        when root.snapshot is null then parent.session_id
                        else (
                            select r.session_id
                            from job r
                            where r.org_id = ${orgId} and r.root_job_id = root.root_id
                              and r.session_id is not null
                              and exists (
                                  select 1 from jsonb_array_elements(root.snapshot -> 'nodes') node
                                  where node->>'name' = r.workflow_node and node->>'session' = 'resume'
                              )
                            order by r.created_at, r.id
                            limit 1
                        )
                    end as session_id
                from parent, root
            )
            insert into job (org_id, command, created_by, repo, executor, executor_scope, parent_job_id, session_id, root_job_id, workflow_name, mode, skill_pin, skill_hidden)
            select ${orgId}, ${command}, ${createdBy}, parent.repo, parent.executor, parent.executor_scope, parent.id,
                   coalesce(primary_session.session_id, parent.session_id),
                   parent.root_job_id, parent.workflow_name, parent.mode, '[]'::jsonb, '[]'::jsonb
            from parent, root, primary_session
            -- Eligibility is the THREAD's, as a retry's is: a finished parent whose thread
            -- still holds unfinished work, or carries a done on any member, refuses — so a repeat
            -- never queues a second follow-up, and a closed thread never gets queued work.
            where ${threadIdleFragment(tx, orgId, 'parent.root_job_id')}
            returning id
        `;
    if (rows[0]) {
        await addFollowUpBindings(tx, { orgId, rootJobId: rootJobId, createdBy, connectionIds });
        await recordFollowUpDecisionInTx(tx, input, rows[0].id, rootJobId);
        const ref = { orgId, jobId: rows[0].id, rootJobId: rootJobId, createdBy };
        await bindAttachmentsInTx(tx, { ...ref, ids: attachmentIds });
        await stampKey(tx, orgId, rows[0].id, idem);
        await insertAdminActionEvent(tx, { orgId, jobId: rows[0].id, action: 'follow-up', actorId: createdBy });
        return { id: rows[0].id };
    }
    // Nothing inserted — one of the preconditions failed, and which one decides the answer
    // the route turns into a status code. A busy thread was answered before the insert, so this read runs only on a
    // thread that was idle under the lock: nothing can move a member out of terminal, or done in or out, so its
    // answer agrees with the insert's. The parent cannot have moved to deleted since the pre-read above —
    // remove deletes under this same advisory lock — so missing was decided before the lock.
    return threadRefusalOf(tx, orgId, parentId);
}

/**
 * The answer to a replayed follow-up or retry: the recorded row, but only while the parent it was
 * made from is still the caller's own — a stored result never outlives the author check the
 * original insert passed, so a parent that changed hands answers `forbidden` instead.
 */
async function replayedFor(
    tx: TransactionSql,
    source: { orgId: string; parentId: string; createdBy: string | null; admin: boolean },
    id: string
): Promise<CreatedRef | 'forbidden'> {
    const { orgId, parentId, createdBy, admin } = source;
    const [parent] = await tx<{ id: string }[]>`
        select id from job
        where org_id = ${orgId} and id = ${parentId}
          and ${authorOwnsFragment(tx, { orgId, admin, createdBy })}
    `;
    return parent ? { id, replayed: true } : 'forbidden';
}

/**
 * createRetry's body: queue a fresh attempt of the thread head's command in the SAME
 * thread, without resuming a session. One transaction and one conditional insert, shaped exactly
 * like the follow-up's. Eligibility is the
 * THREAD's, not the named row's: the `named` CTE carries only the caller's own-row predicate
 * under its `for update` lock, and the INSERT..SELECT admits the retry only when EVERY member of
 * the thread is terminal and NO member carries a done_at — the follow-up's rule. A terminal root
 * therefore cannot queue a second attempt under a head that is still queued or running, and a
 * terminal head whose thread the user closed anywhere refuses task_done. The refusal below names
 * the thread as it is now, never a stale snapshot.
 *
 * What is copied comes from the thread HEAD: its command, repo, executor, workflow_name and
 * root_job_id. What is deliberately ABSENT is the follow-up's other two columns: no
 * `parent_job_id` and no `session_id`. The claim computes `followUp` from `parent_job_id` and
 * keeps `session_id` only on a follow-up, so this row is delivered as an ordinary first run —
 * `resumeSessionId: null, followUp: false` — with no claim-side rule added, and it lands in the
 * thread's own worktree because the worktree is keyed by `root_job_id`.
 */
export async function createRetryRow(sql: Sql, input: RetryRowInput): Promise<RetryRowResult> {
    return sql.begin((tx) => retryInTx(tx, input));
}

export interface RetryRowInput {
    orgId: string;
    id: string;
    createdBy: string | null;
    idempotency?: IdempotencyInput | undefined;
    /** The route's org-admin verdict; ignored for a null caller. */
    admin?: boolean | undefined;
}

export type RetryRowResult = CreatedRef | 'missing' | 'not_finished' | 'task_done' | 'forbidden';

/** createRetryRow's body, for a caller that already holds a transaction (the batch scheduler). */
export async function retryInTx(tx: TransactionSql, input: RetryRowInput): Promise<RetryRowResult> {
    const { orgId, id, createdBy, idempotency: idem } = input;
    const admin = adminActs(createdBy, input.admin);
    const admitted = await admitThreadInsert(tx, { orgId, parentId: id, createdBy, admin, idem });
    if ('answer' in admitted) return admitted.answer;
    const rows = await tx<{ id: string }[]>`
            with named as (
                select id, root_job_id
                from job
                where org_id = ${orgId} and id = ${id}
                  and ${authorOwnsFragment(tx, { orgId, admin, createdBy })}
                  -- A named-profile review is not a task: a retry of it would run as an ordinary
                  -- job with the author's full env and token, in the reviewer's worktree.
                  and review_of is null
                  -- A running or queued member answers not_finished: locking it here would wait on a row
                  -- a claim or a verdict holds while that one waits on the lock above.
                  and ${terminalFragment(tx)}
                for update
            ),
            head as (
                select command, repo, executor, executor_scope, root_job_id, workflow_name, mode, skill_pin, skill_hidden
                from job
                where org_id = ${orgId} and root_job_id = (select root_job_id from named)
                order by created_at desc, id desc
                limit 1
            )
            -- The pin is the head's, as the command is: a retry re-runs the head with the versions it was locked to.
            insert into job (org_id, command, created_by, repo, executor, executor_scope, root_job_id, workflow_name, mode, skill_pin, skill_hidden)
            select ${orgId}, head.command, ${createdBy}, head.repo, head.executor, head.executor_scope,
                   head.root_job_id, head.workflow_name, head.mode, head.skill_pin, head.skill_hidden
            from named, head
            where ${threadIdleFragment(tx, orgId, 'head.root_job_id')}
            returning id
        `;
    if (rows[0]) {
        await stampKey(tx, orgId, rows[0].id, idem);
        await insertAdminActionEvent(tx, { orgId, jobId: rows[0].id, action: 'retry', actorId: createdBy });
        return { id: rows[0].id };
    }
    // Nothing inserted — one of the preconditions failed, and which one decides the answer
    // the route turns into a status code.
    return threadRefusalOf(tx, orgId, id);
}

/**
 * editCommand's body. One conditional UPDATE carries every precondition — queued,
 * off-graph, the caller's own task — so an edit can never land on a row a worker already holds:
 * the UPDATE takes the row's lock, and under READ COMMITTED whichever statement gets the lock
 * second re-checks its predicates against the row's newest committed version. A claim that
 * commits first turns the edit's 0-rows answer into `not_queued`; an edit that commits first is
 * what the claim's `RETURNING command` delivers. No advisory lock — this touches ONE row, and
 * the row lock is the serialization, exactly as stop's single statement already relies on it;
 * the advisory lock is the pattern for thread-wide operations (claim, remove, reopen).
 *
 * The author predicate is null-safe (`is not distinct from`): a null caller may only edit an
 * authorless row, and an authored row refuses a caller with no account. `workflow_node is null`
 * is the prompt-built discriminator: a workflow root's and a queued continuation's command are
 * interpolated prompt text, never the member's own words — there is no raw line to edit from.
 * On 0 rows, one classification read answers which precondition failed — state before author,
 * the follow-up refusal's ordering.
 */
export async function editJobCommand(
    ctx: JobStoreContext,
    id: string,
    command: string,
    caller: string | null
): Promise<EditCommandResult> {
    const { sql, orgId } = ctx;
    return sql.begin(async (tx) => {
        const rows = await tx<{ id: string }[]>`
            update job set command = ${command}
            where org_id = ${orgId} and id = ${id}
              and status = 'queued'
              and workflow_node is null
              and created_by is not distinct from ${caller}
            returning id
        `;
        if (rows[0]) return { result: 'ok', command };
        const [row] = await tx<{ status: JobStatus; workflow_node: string | null; created_by: string | null }[]>`
            select status, workflow_node, created_by from job where org_id = ${orgId} and id = ${id}
        `;
        if (!row) return 'missing';
        if (row.status !== 'queued') return { result: 'not_queued', status: row.status };
        if (row.workflow_node !== null) return 'workflow';
        return 'forbidden';
    });
}

export async function markJobDone(
    ctx: JobStoreContext,
    id: string,
    doneBy: string | null
): Promise<{ status: JobStatus; doneAt: string } | 'missing' | 'conflict' | 'batch' | BatchesDisabledRefusal> {
    const { sql, orgId } = ctx;
    // One transaction, because done is what frees the tree now (issue #47's second half):
    // stamping done_at and queueing the worktree reclaim must be decided together, on the
    // thread AS THE DONE LANDS — the terminality read below runs on the same connection,
    // where the just-stamped row is visible and a follow-up inserted after the commit is
    // not. A thread that is still moving keeps its tree: its last completing attempt will
    // find every member terminal AND this done_at in place, and reclaim at the verdict.
    return sql.begin(async (tx) => {
        // Stamping done_at must be atomic with the follow-up and retry inserts — whose thread-done eligibility checks
        // read it — and with remove and reopen, or one of them could decide against a thread whose done it could not see.
        const rootJobId = await lockThreadOf(tx, orgId, id);
        if (!rootJobId) return 'missing';
        // A live batch task's thread is closed by the batch, never by a plain Done: Done would block
        // the task's retry and queue the reclaim of the tree that retry runs in. Once the batch ended
        // or a person force-closed the task, nothing retries it and Done closes it.
        // Off (BATCHES_ENABLED), the batch is hidden: the same thread answers the flag's refusal, not the batch's.
        if ((await batchThreadState(tx, orgId, rootJobId)) === 'live')
            return ctx.batches ? 'batch' : 'batches_disabled';
        // coalesce, not assignment: the second "done" answers the first one's instant,
        // which is what makes the route idempotent rather than silently rewriting history.
        // done_by rides the same rule: the first writer's actor survives a retried click.
        const rows = await tx<{ status: JobStatus; done_at: Date; root_job_id: string }[]>`
            update job set done_at = coalesce(done_at, now()), done_by = coalesce(done_by, ${doneBy})
            where org_id = ${orgId} and id = ${id}
              and ${terminalFragment(tx)}
            returning status, done_at, root_job_id
        `;
        const row = rows[0];
        if (!row) {
            return (await exists(sql, orgId, id)) ? 'conflict' : 'missing';
        }
        await queueReclaimIfThreadDone(tx, orgId, row.root_job_id);
        return { status: row.status, doneAt: row.done_at.toISOString() };
    });
}

export async function removeJobThread(
    ctx: JobStoreContext,
    id: string,
    removedBy: string | null
): ReturnType<JobStore['removeThread']> {
    const { sql, orgId, prs } = ctx;
    // The root row, then the thread lock (the bind's order; the claim only tries): the refusal check and the delete
    // must see every earlier claim of this thread commit, or a claim could walk out with a row after the check passed
    // and before the delete ran — a removed task with a member running again afterwards.
    return sql.begin(async (tx) => {
        const rootJobId = await lockThreadOf(tx, orgId, id);
        if (!rootJobId) return 'missing';

        // The thread's ROOT row carries the labels the reclaim is addressed by — the repo
        // the worktree was checked out from and the author whose checkout root it lives
        // under.
        const [root] = await tx<{ id: string; repo: string | null; created_by: string | null }[]>`
            select id, repo, created_by from job
            where org_id = ${orgId} and id = ${rootJobId}
        `;
        if (!root) return 'missing';
        if (await backsBatchTask(tx, orgId, rootJobId)) return 'batch';

        // Every member of the thread carries the same root_job_id (022), so the thread is
        // one indexed read. Branching included, should two adjustments ever land on one
        // parent.
        const members = await tx<{ id: string; status: JobStatus }[]>`
            select id, status from job
            where org_id = ${orgId} and root_job_id = ${rootJobId}
        `;
        // The one refusal: a member is running. The user stops it first — the per-task
        // worktree is a live runner's checkout, and tearing it out under the container would
        // corrupt a run that was happily going. Checked before the review rows are locked: a
        // running member's verdict holds those rows and waits on this root lock.
        if (hasRunningMember(members)) return 'conflict';
        // The thread's named-profile reviews are threads of their own, so they are
        // not in `members`: a running one is a live runner's checkout too, and they leave with it.
        const reviews = await tx<{ id: string; status: JobStatus }[]>`
            select id, status from job
            where org_id = ${orgId} and review_of = any(${members.map((m) => m.id)}::uuid[])
            for update
        `;
        if (hasRunningMember([...members, ...reviews])) return 'conflict';

        // The rows are gone for good — nothing joins through job.id at claim time (the
        // claim copies its session labels onto its own row), so deleting the audit trail is
        // the removal, not a cleanup that orphans something.
        const removedIds = [...members, ...reviews].map((m) => m.id);
        await markExecutionsRemoved(tx, orgId, removedIds);
        await tx`
            delete from job
            where org_id = ${orgId} and id = any(${removedIds})
        `;

        // The thread is gone, and with it every PR wait folded for it — the webhook's
        // next redelivery folds into nothing, which is the point: no ghost thread wakes.
        if (prs) {
            await prs.cancelWaitsForRoot(rootJobId, 'task removed', tx);
        }
        // Any parked or already-woken block-wait round is this thread's audit data
        // too — cancelWaitsForRoot above already makes it permanently unwakeable, this is just not
        // leaving it behind forever.
        await revokeThreadAttachmentsInTx(tx, orgId, rootJobId);
        await tx`delete from workflow_round where org_id = ${orgId} and root_job_id = ${rootJobId}`;
        // The merge-closure marker is the thread's audit data the same way: the rows
        // it discriminates are gone.
        await tx`delete from job_merge_close where org_id = ${orgId} and root_job_id = ${rootJobId}`;

        // Queue the worktree reclaim. The driver polls this queue — nothing is holding a
        // lease on a removed thread, so no live driver would ever notice the deletion
        // otherwise — and takes the tree down, acking the row when it has. Same relative
        // path the claim derives, empty labels included: a tree keyed only on the root id
        // still gets reclaimed, pointing at nothing additional is fine.
        const workspacePath = workspacePathFor(orgId, root.created_by);
        // One per tree: the thread's own, and each review's (its worktree is keyed by its own id).
        for (const tree of [rootJobId, ...reviews.map((review) => review.id)]) {
            await tx`
                insert into task_reclaim (org_id, root_job_id, repo, workspace_path, removed_by)
                values (${orgId}, ${tree}, ${root.repo}, ${workspacePath}, ${removedBy})
            `;
        }

        return { result: 'ok', rootJobId, repo: root.repo, workspacePath };
    });
}

/**
 * The shared preamble of both wait-control verbs: resolve the named id to its
 * thread root and check the caller may act on the thread. `id` may be any member — the wait
 * belongs to the root, exactly as `removeThread` resolves. Author-scoped like the follow-up (the
 * woken continuation runs in the author's worktree): only the account that queued the thread —
 * or an anonymous caller on a thread with no author — gets past here.
 */
type ControlledRoot =
    | { ok: true; root: string; ownerId: string | null }
    | { ok: false; refusal: 'missing' | 'forbidden' };

async function resolveControlledRoot(
    { sql, orgId }: JobStoreContext,
    id: string,
    caller: string | null,
    admin: boolean | undefined
): Promise<ControlledRoot> {
    const [named] = await sql<{ root_job_id: string; owner_id: string | null }[]>`
        select n.root_job_id, r.execution_user_id as owner_id
        from job n
        join job r on r.org_id = n.org_id and r.id = n.root_job_id
        where n.org_id = ${orgId} and n.id = ${id}
    `;
    if (!named) return { ok: false, refusal: 'missing' };
    if (named.owner_id !== caller && !adminActs(caller, admin)) return { ok: false, refusal: 'forbidden' };
    return { ok: true, root: named.root_job_id, ownerId: named.owner_id };
}

/**
 * The user's wait-cancel: `cancelWaitsForRoot` with the user reason and the acting
 * caller, decided atomically enough — the update's `cancelled_at is null` predicate IS the
 * no-open-wait answer, so a cancel racing itself answers `ok` exactly once and `no_wait` after.
 * No advisory lock, exactly like `cancelForRepoPr`/`cancelWaitsForRoot` today: a cancel can land
 * at any time, including between a wake committing and the continuation being claimed, and the
 * claim-time cancellation fence is what makes cancellation win that race.
 */
export async function cancelThreadWait(
    ctx: JobStoreContext,
    id: string,
    cancelledBy: string | null,
    admin?: boolean
): ReturnType<JobStore['cancelWait']> {
    const resolved = await resolveControlledRoot(ctx, id, cancelledBy, admin);
    if (!resolved.ok) return resolved.refusal;
    const cancelled = await cancelWaitsWithEvent(ctx, resolved.root, cancelledBy);
    return cancelled > 0 ? { result: 'ok' } : 'no_wait';
}

/**
 * The user's poke: re-evaluate the parked PR now. The board's only GitHub input is
 * webhook deliveries, so "re-evaluate" cannot mean fetching GitHub here — it means running the
 * wake transaction (`wakeOneRound`) for the thread's parked rounds without the sweep's
 * `pending > 0` gate: whatever IS folded is claimed honestly (a poke that folds nothing stamps
 * `delivery_count = 0` — the audit signature of a user wake), and the continuation's own
 * claim-time pre-helper is what actually re-fetches the PR state. Pre-reads run unlocked, exactly
 * like the sweep's candidate list; `wakeOneRound` re-checks everything that matters under the
 * thread's advisory lock, so two concurrent pokes wake a round exactly once.
 */
export async function pokeThreadWait(
    ctx: JobStoreContext,
    id: string,
    pokedBy: string | null,
    admin?: boolean
): ReturnType<JobStore['pokeWait']> {
    const { sql, orgId, prs } = ctx;
    const resolved = await resolveControlledRoot(ctx, id, pokedBy, admin);
    if (!resolved.ok) return resolved.refusal;
    if (!prs) return 'no_wait';
    const root = resolved.root;

    // The no-open-wait refusal first — the issue's one mandated 409: a thread that never parked,
    // or whose wait already ended, has nothing to evaluate. Distinct from the `woken: false`
    // answer an OPEN wait with nothing parked gets below (already woken, active member, done).
    const [open] = await sql<{ one: number }[]>`
        select 1 as one from workflow_wait
        where org_id = ${orgId} and root_job_id = ${root}
          and completed_at is null and cancelled_at is null
    `;
    if (!open) return 'no_wait';

    // The same shape the sweep's candidate query takes, scoped to this thread: an open wait
    // joined to its parked round. `woken: false` for none — nothing parked, or already woken.
    const parked = await sql<{ workflow_node: string }[]>`
        select r.workflow_node
        from workflow_round r
        join workflow_wait w
          on w.org_id = r.org_id and w.root_job_id = r.root_job_id and w.reason = r.workflow_node
        where r.org_id = ${orgId}
          and r.root_job_id = ${root}
          and r.woken_at is null
          and w.completed_at is null and w.cancelled_at is null
        order by r.parked_at
    `;
    if (parked.length === 0) return { result: 'ok', woken: false };

    let woken = false;
    for (const round of parked) {
        // An admin's poke is an admin's turn on the owner's thread: the actor rides into the wake transaction, which
        // stamps the continuation row with it. The slice-2 notification joins that same transaction.
        const actor =
            pokedBy !== null && pokedBy !== resolved.ownerId
                ? { userId: pokedBy, ownerId: resolved.ownerId }
                : undefined;
        const jobId = await wakeOneRound({ sql, orgId, prs, actor }, root, round.workflow_node, false);
        woken = woken || jobId !== null;
    }
    return { result: 'ok', woken };
}

/**
 * Done's inverse: clear the done stamp on every member of the thread and withdraw a
 * task_reclaim row that has not run yet, so a task closed by mistake can be followed up again —
 * createFollowUpRow's thread-wide done predicate is exactly what this reverses. The whole decision
 * is one transaction under the thread's root row and then its advisory lock (the claim only tries
 * the latter): the refusal checks, the withdraw and the clear must see every earlier claim and ack of this
 * thread commit, or a reclaim claim could take the row between the check and the withdraw — a tree
 * removed for a task that believes itself reopened. A row any acquisition took (a `claim_token`,
 * 075) is refused outright (`reclaiming`), its lease live or expired: a kubernetes reclaim group
 * outlives its driver, and nothing fences it from the follow-up's checkout claim, so only the
 * ack — the tree confirmed gone, `reclaimed` — ends the refusal. Only a never-acquired row is
 * withdrawn. The lock does NOT cover done or complete (deliberately — docs/jobs.md
 * forbids stalling them behind claim preparation), so a redundant done click or a verdict whose
 * aggregate straddles this commit can still queue or order a removal after the withdraw; the
 * follow-up recovers by recreating the tree from the surviving branch.
 */
export async function reopenJob(ctx: JobStoreContext, id: string): ReturnType<JobStore['reopen']> {
    const { sql, orgId } = ctx;
    return sql.begin(async (tx) => {
        const rootJobId = await lockThreadOf(tx, orgId, id);
        if (!rootJobId) return 'missing';

        // A removed tree is unrecoverable: a follow-up resumes a session in the tree it ran in,
        // and there is no tree. The marker (045) is stamped only at the ack (a threadDone verdict
        // queues its reclaim claimed) — the queue row alone could not carry this,
        // because ack deletes it. The root read doubles as the remove-lost-the-race
        // check: remove deletes the rows under this same lock, so no root row means the thread
        // is gone, whatever the pre-lock read saw.
        const [root] = await tx<{ worktree_reclaimed_at: Date | null }[]>`
            select worktree_reclaimed_at from job
            where org_id = ${orgId} and id = ${rootJobId}
        `;
        if (!root) return 'missing';
        if (await backsBatchTask(tx, orgId, rootJobId)) return 'batch';
        if (root.worktree_reclaimed_at !== null) return 'reclaimed';

        // Any acquisition of the row may be mid-removal, its lease live or not — refuse rather
        // than reopen over a tree that may be coming down. The post-withdraw re-check below is
        // what catches a claim that commits between here and the delete (claimReclaimRow takes no
        // advisory lock).
        const claimed = (table: typeof tx) => table`
            select id from task_reclaim
            where org_id = ${orgId} and root_job_id = ${rootJobId}
              and claim_token is not null
        `;
        if ((await claimed(tx))[0]) return 'reclaiming';

        // A thread nobody closed has nothing to reopen — and reopen is deliberately NOT
        // idempotent: the second call answers this, the state the first one left behind.
        const [members] = await tx<{ done: number }[]>`
            select count(*)::int as done from job
            where org_id = ${orgId} and root_job_id = ${rootJobId} and ${doneFragment(tx)}
        `;
        if (!members || members.done === 0) return 'not_done';

        // Withdraw the queued reclaim BEFORE clearing the stamp, in the same transaction — and
        // only rows no acquisition ever took. The DELETE's row lock is what serializes
        // against claimReclaimRow's `for update skip locked` candidate: a row being withdrawn is
        // skipped, never handed out; a row claimed mid-transaction fails this delete's re-checked
        // predicate and survives it, which the re-read below then refuses.
        await tx`
            delete from task_reclaim
            where org_id = ${orgId} and root_job_id = ${rootJobId}
              and claim_token is null
        `;
        if ((await claimed(tx))[0]) return 'reclaiming';

        // The stamp is the thread's done (the UI marks the head, so it can sit on any member):
        // cleared wherever it sits, which is what makes the follow-up possible again.
        await tx`
            update job set done_at = null, done_by = null
            where org_id = ${orgId} and root_job_id = ${rootJobId} and ${doneFragment(tx)}
        `;
        // A merge closure's marker is the discriminator complete's transition reads:
        // gone with the stamps, so a thread the user reopens after an automatic Done walks its
        // graph again — and the surviving `pr_merge` ledger row is what keeps a redelivered merge
        // from re-closing it.
        await tx`
            delete from job_merge_close
            where org_id = ${orgId} and root_job_id = ${rootJobId}
        `;
        return { result: 'ok' };
    });
}
