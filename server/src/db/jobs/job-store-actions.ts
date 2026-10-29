/**
 * What members do to tasks: create, follow up, mark done, reopen, stop, suspend, remove, control
 * a parked PR wait (issue #328) — and the reclaim a thread queues once its last member is done.
 */

import type { Fragment, Sql, TransactionSql } from 'postgres';
import { OBJECTIVE_MODE, USER_SCOPE, WORKFLOW_MODE } from '@factory-ai/core';
import { lockThreadRootInTx } from '../connection-bindings.js';
import { addFollowUpBindings, type BindConnectionResult, bindOnCreate } from './job-store-connections.js';
import {
    backsBatchTask,
    batchThreadState,
    exists,
    queueReclaimIfThreadDone,
    stopReviewsOf,
    stopRows,
    workspacePathFor,
    hasRunningMember,
} from './job-store-rows.js';
import { settleIfMergeClosed } from './job-store-merge.js';
import { fingerprintOf, missedSettle, recordReceipt, settleReplayOf, type SettleKey } from './job-store-receipts.js';
import { commitStagedForStop } from './job-store-conclusions.js';
import { stagedFingerprint } from './job-store-staged.js';
import { TERMINAL_STATUSES } from '../task-summary.js';
import { type IdempotencyInput, replayOf, stampKey } from './job-store-idempotency.js';
import type {
    CancelWaitResult,
    EditCommandResult,
    FollowUpRefusal,
    JobStatus,
    JobStore,
    JobStoreContext,
    PokeWaitResult,
    RemoveResult,
    ReopenResult,
    RetryRefusal,
    StopResult,
    SuspendResult,
} from './job-store-types.js';
import { markExecutionsRemoved, recordLaunchOutcome } from './job-store-provenance.js';
import { wakeOneRound } from '../workflows/workflow-blocks/runtime.js';
import type { ParamValues, WorkflowDefinition } from '../workflows/workflow-schema.js';
import type { ExecutorScope } from '@factory-ai/core';

/** The job and thread transitions the board writes: create, follow up, retry, edit, done, stop, remove, waits, reopen, and the worker-initiated suspend and interrupt. */
export interface JobActionStore {
    /**
     * `createdBy` is a parameter rather than something read off the body, and the route passes the
     * authenticated caller's id. A client-supplied one would be impersonation on the audit trail of
     * a route that runs shell commands.
     *
     * `target` carries the optional repo/executor labels the tasks chat groups and displays by,
     * and — when the task runs a workflow — the resolved workflow: the id, the ENTRY node the
     * thread's first run walks, and the definition SNAPSHOT frozen onto the root row. The snapshot
     * is the graph the whole thread walks: editing the workflow mid-flight changes later tasks,
     * never this one (docs/workflows.md). Null when no workflow resolved, which is the ordinary
     * create and behaves exactly as it did before 027.
     */
    create(
        command: string,
        createdBy: string | null,
        target: {
            repo: string | null;
            executor: string | null;
            /**
             * The scope the executor label names (issue 391): which profile list claim-time
             * resolution reads — the author's own rows (`user`) or the organization's (`org`).
             * Absent is `user`, the pre-391 meaning; the route normalizes the body's field and
             * refuses anything outside the pair, and the store stamps the resolved value.
             */
            executorScope?: ExecutorScope;
            /**
             * The skills the task selects (issue #545), names the route validated against the
             * catalog. Stored on the root row only; a follow-up, retry or successor reads the
             * root's selection at claim time (055). Absent is none.
             */
            skills?: readonly string[];
            /**
             * The connections (054, 094) the task names, bound on the ROOT in the create
             * transaction: each must be bindable by the author or the create is refused with
             * `ConnectionRefusedError`. A bindable provider the author has exactly one personal
             * connection for binds by default; a provider a selected skill requires with none
             * becomes an open requirement the claim waits on. Absent is none named.
             */
            connectionIds?: readonly string[];
            /**
             * When the task runs a workflow: the resolved workflow — the id, the NAME frozen on
             * the root row as workflow_name, the ENTRY node the thread's first run walks, the
             * definition SNAPSHOT frozen onto the root row, and the validated launch parameter
             * values (`{{param.*}}` resolves from them on every row of the thread). The route
             * validates the values against the definition's declarations before calling; the
             * store freezes them as given. The name comes off the resolved record, the same trust
             * pattern as `createdBy` — never off the body. Null when no workflow was named: the
             * row is stamped objective mode (051) and no graph ever walks it.
             */
            workflow?: {
                id: string;
                name: string;
                node: string;
                snapshot: WorkflowDefinition;
                params: ParamValues;
            } | null;
            /**
             * The request's `Idempotency-Key` (issue #589): a repeat of a recorded request answers
             * the row it made (`replayed`), a key reused for a different request throws
             * `IdempotencyKeyReusedError`. The same holds for `createFollowUp` and `createRetry`.
             */
            idempotency?: IdempotencyInput | undefined;
        }
    ): Promise<{ id: string; replayed?: boolean }>;

    /**
     * Queues a follow-up on a finished task: a new job that inherits the parent's repo, executor
     * and — the thread's PRIMARY — session ids, linked through `followUpTo`. Atomic and
     * conditional — the insert only lands when the parent is finished, no member of its thread is
     * unfinished, the parent is not done, and it is the caller's own task — so the refusals above
     * are decided in the same statement that would have created the row, never by a read that
     * could race a claim or a completion in between.
     *
     * The thread's labels, session and workflow name are ALL the parent's, taken from the row and
     * never from a body: an adjustment continues the run it adjusts, on the executor that ran it —
     * a conversation switching executors mid-thread is exactly the cross-CLI resume the driver
     * cannot do. On a workflow thread the session copied is the primary (the first resume run's),
     * whatever node ran last, and the follow-up row itself is off-graph — no `workflow_node` —
     * so its completion re-fires the halted node's edges (docs/workflows.md).
     */
    createFollowUp(
        parentId: string,
        command: string,
        createdBy: string | null,
        idempotency?: IdempotencyInput,
        /** Connections to append to the thread's bindings; `ConnectionRefusedError` when any is not the author's to bind. */
        connectionIds?: readonly string[]
    ): Promise<{ id: string; replayed?: boolean } | FollowUpRefusal>;

    /**
     * The owner's answer to an open requirement: appends `connectionId` to the thread root's bindings
     * when `bindingRevision` is still current, and satisfies the requirement for its provider. `id` may
     * be any member of the thread; anyone but the execution user, or an unknown job, is `missing`.
     */
    bindConnection(
        id: string,
        input: { connectionId: string; bindingRevision: number },
        userId: string
    ): Promise<BindConnectionResult>;

    /**
     * Queues a fresh attempt of the thread head's command (issue #326): a new job in the SAME
     * thread — the thread's `root_job_id`, with the head's command, repo, executor and workflow
     * name copied at insert — that resumes NOTHING: no `parent_job_id`, no session. The claim
     * delivers it like any first fresh run (`resumeSessionId: null`, `followUp: false`), and
     * the worktree is the thread's own, keyed by the root. It re-runs the head's command as it
     * was, where a follow-up sends a new one.
     *
     * Atomic and conditional like the follow-up insert: the preconditions (terminal, not done,
     * the caller's own task) ride the named row's select with its `for update` lock, so the
     * refusals are decided in the same statement that would have created the row.
     */
    createRetry(
        id: string,
        createdBy: string | null,
        idempotency?: IdempotencyInput
    ): Promise<{ id: string; replayed?: boolean } | RetryRefusal>;

    /**
     * Edits a queued task's command in place (issue #329): same id, same thread, where a stop
     * plus a re-create would have burned both. Queued rows only — the `job` row is an audit
     * record of what RAN, and a row that has run nothing has nothing audited to overwrite.
     * Author-scoped like the follow-up, null-safe both ways (`is not distinct from`): a null
     * caller may only edit an authorless row, the state every pre-accounts task is in.
     *
     * Workflow rows refuse (`workflow`): their command IS the interpolated entry prompt, and
     * the raw chat line that built it was never stored. Decided atomically against the claim:
     * the conditional UPDATE takes the row's lock, so a claim that commits while the edit
     * waits turns the edit's answer into `not_queued`, and an edit that commits first is what
     * the claim's `RETURNING command` hands the driver.
     */
    editCommand(id: string, command: string, caller: string | null): Promise<EditCommandResult>;

    /**
     * The user's verdict that the task is done. Terminal tasks only — a moving run is not the
     * user's to finish. Idempotent: marking a done task done again answers the same instant, and
     * the status rides along so the route can echo the task's state without a second read.
     *
     * Done is what frees the task worktree: when the whole thread is already terminal, the same
     * transaction queues a `task_reclaim` row for it — a failed or finished thread that nobody
     * closed keeps its tree, and the done on any one member (the UI marks the head) is what
     * makes it the thread's done. A thread still moving is not queued here; its last completing
     * attempt finds the done in place and reclaims at the verdict.
     *
     * `doneBy` is the authenticated caller's id, passed by the route like `createdBy` on create —
     * never read off a body. Stamped beside `doneAt` with the same coalesce: the second "done"
     * keeps the first writer's actor.
     */
    markDone(
        id: string,
        doneBy: string | null
    ): Promise<{ status: JobStatus; doneAt: string } | 'missing' | 'conflict' | 'batch'>;

    /**
     * The user's stop. A QUEUED row never started, so it is settled `stopped` right here: the
     * turn is over. A RUNNING row whose lease is still live is
     * stamped `cancel_requested_at` (idempotently) and left running: the driver reads the request
     * on the heartbeat it already sends, kills its runner and settles it with the existing
     * suspend route — the flag IS the stop travelling, and the settle clears it. A RUNNING row
     * whose lease has already expired settles `stopped` here instead (issue #152): nobody holds
     * the lease, and a stamp would wait for a heartbeat nobody will send. A row that already
     * ended refutes with its status.
     *
     * `stoppedBy` is the authenticated caller's id, passed by the route. Stamped at request time
     * with the same first-writer coalesce as the flag it rides beside.
     */
    stop(id: string, stoppedBy: string | null): Promise<StopResult>;

    /**
     * The user's remove. Deletes the WHOLE thread — the root and every follow-up — in one
     * transaction and queues a task_reclaim row for the worktree, so the driver (which is the only
     * thing that can remove the tree and the only thing with a live lease to do work in) reclaims
     * it without the removed thread having any job left to hang the work on. Refuses while any
     * member of the thread is running, under the same per-thread lock the claim takes, so a claim
     * can never slip a running row between the refusal check and the delete.
     *
     * `removedBy` is the authenticated caller's id, passed by the route. It rides the
     * task_reclaim row, because the thread rows are deleted in the same transaction — a
     * removed_by on job would be written and immediately deleted.
     */
    removeThread(id: string, removedBy: string | null): Promise<RemoveResult>;

    /**
     * The user's wait-cancel (issue #328): ends the thread's open durable PR wait with reason
     * `cancelled by user`, so a thread parked past a missed webhook can be closed out by hand.
     * Takes no lease — a wait holds no runner. Cancel ends the WAIT, never a running turn (stop
     * is for turns); a continuation already woken and claimed is settled by the claim's
     * cancellation fence, exactly as a PR close would.
     *
     * `cancelledBy` is the authenticated caller's id, passed by the route — recorded on the wait
     * row (045) with the same first-writer coalesce as the 025 actors, and used for the
     * author-scoping check. `id` may be ANY member of the thread: the wait belongs to the root.
     */
    cancelWait(id: string, cancelledBy: string | null): Promise<CancelWaitResult>;

    /**
     * The user's poke (issue #328): re-evaluates the thread's parked PR wait NOW — the wake
     * transaction the sweep runs, minus the pending gate, because the board has no other GitHub
     * input than webhooks and the motivating case is one that never arrived. The woken
     * continuation's own claim-time pre-helper re-fetches the PR state (a false wake costs a
     * helper container and a re-park, never an agent turn — the wait node's generous wake bound
     * absorbs those). `woken: false` on nothing parked, an already-woken round or an active
     * member; a poke folded nothing (delivery_count 0) is the audit signature of a user wake.
     *
     * `pokedBy` is the authenticated caller's id, used for the author-scoping check — the poke
     * queues a continuation that runs in the author's worktree under the author's executor.
     * `id` may be ANY member of the thread.
     */
    pokeWait(id: string, pokedBy: string | null): Promise<PokeWaitResult>;

    /**
     * The user's reopening of a done task (issue #327): clears the done stamp on EVERY member of
     * the thread and withdraws a queued task_reclaim row, so a task closed by mistake can be
     * followed up again — `createFollowUp`'s thread-wide done predicate is what this reverses.
     * Decided under the same per-thread advisory lock the claim, remove and reclaim ack take, so
     * the checks, the withdraw and the clear see every earlier claim and ack of the thread commit;
     * the withdraw only takes rows no acquisition ever took, and re-verifies after the delete, so a
     * row claimed mid-transaction is refused rather than yanked from under its worker.
     *
     * Refuses once the worktree is gone (`reclaimed` — the `worktree_reclaimed_at` marker, 045:
     * stamped at the ack), and while a reclaim may be in flight (`reclaiming` — any acquisition
     * of the row, its lease live or expired: a reclaim group can outlive its driver, so only the
     * ack ends the refusal), because a follow-up resumes a session in the tree it ran in. Not
     * idempotent: reopening a task that is not done answers `not_done`, and so does the second
     * reopen.
     */
    reopen(id: string): Promise<ReopenResult>;

    /**
     * Ends a running job's attempt. Lease-guarded, like every other worker write. The parking IS
     * the user's stop landing — the row settles `stopped` (terminal, session kept for the follow-up
     * that continues the conversation).
     */
    suspend(id: string, leaseToken: string): Promise<SuspendResult>;

    /**
     * Records an attempt the infrastructure interrupted (issue #792), lease-guarded, refunding the
     * attempt and appending the reason. `release` hands the claim back claimable at once (a drained
     * driver, an evicted runner) — queued, or stopped when a Stop got there first — with the
     * segment banked; without it the claim is an adopter's and keeps its lease, `claimSeq` naming
     * the earlier attempt it adopted; the adopting claim's launch becomes `adopted`, linked to that
     * claim. `refused` says the runner never started (issue #845). `blocked` (a release only) says the claim waits on a leftover still terminating (BEL-160): it spends no budget, is accepted past a spent one, and defers the next claim `BLOCKED_RETRY_SECONDS`. `exhausted` once `INTERRUPTION_BUDGET` is spent: nothing
     * changed, and the caller reports or leaves the attempt as before.
     */
    interrupt(
        id: string,
        leaseToken: string,
        interruption: {
            reason: string;
            release: boolean;
            claimSeq?: number | null;
            refused?: boolean;
            blocked?: boolean;
        }
    ): Promise<SuspendResult | { result: 'exhausted' }>;
}

export type CreateTarget = Parameters<JobStore['create']>[2];

/** A created row's id; `replayed` when a repeated idempotent request found it already made. */
export type CreatedRef = { id: string; replayed?: boolean };

/** A workflow column's value: the JSON when a workflow was named, SQL null otherwise. */
const jsonOrNull = (sql: Sql, value: object | undefined) => (value ? sql.json(value as never) : null);

export async function createJobRow(
    ctx: JobStoreContext,
    command: string,
    createdBy: string | null,
    target: CreateTarget
): Promise<CreatedRef> {
    return ctx.sql.begin((tx) => insertJobInTx(tx, ctx, { command, createdBy, target }));
}

/**
 * createJobRow's body, for a caller that already holds a transaction: the batch scheduler creates
 * a task's root in the same transaction that records the decision to.
 */
export async function insertJobInTx(
    tx: TransactionSql,
    ctx: Pick<JobStoreContext, 'sql' | 'orgId'>,
    { command, createdBy, target }: { command: string; createdBy: string | null; target: CreateTarget }
): Promise<CreatedRef> {
    const { sql, orgId } = ctx;
    const idem = target.idempotency;
    // A repeat of a recorded request answers the row it made, before anything else is decided.
    const replayed = await replayOf(tx, orgId, createdBy, idem);
    if (replayed) return { id: replayed, replayed: true };
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
                execution_user_id, skills
            )
            select ${orgId}, ${command}, ${createdBy}, ${target.repo}, ${target.executor}, ${target.executorScope ?? USER_SCOPE}, x, x,
                   ${target.workflow?.id ?? null},
                   ${target.workflow?.name ?? null},
                   ${target.workflow?.node ?? null},
                   ${jsonOrNull(sql, target.workflow?.snapshot)},
                   ${jsonOrNull(sql, target.workflow?.params)},
                   ${mode},
                   ${createdBy},
                   ${sql.array([...(target.skills ?? [])])}::text[]
            from (select gen_random_uuid() as x) s
            returning id
        `;
    await bindOnCreate(tx, { orgId, rootJobId: rows[0]!.id, createdBy, target });
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
    orgId: string;
    parentId: string;
    command: string;
    createdBy: string | null;
    idempotency?: IdempotencyInput | undefined;
}

export type FollowUpRowResult = CreatedRef | 'missing' | 'task_done' | 'not_finished' | 'forbidden';

export async function createFollowUpRow(sql: Sql, input: FollowUpRowInput): Promise<FollowUpRowResult> {
    return sql.begin((tx) => followUpInTx(tx, input));
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
              and m.status not in ${tx([...TERMINAL_STATUSES])}
        ) as busy
    `;
    if (typeof row?.busy !== 'boolean') throw new Error('the thread busy read returned no answer');
    return row.busy;
}

/** createFollowUpRow's body, for a caller that already holds a transaction (the batch scheduler's repair). */
export async function followUpInTx(tx: TransactionSql, input: FollowUpRowInput): Promise<FollowUpRowResult> {
    const { orgId, parentId, command, createdBy, idempotency: idem, connectionIds = [] } = input;
    // The read resolves the thread root the advisory lock below is keyed by.
    const [label] = await tx<{ repo: string | null; root_job_id: string }[]>`
            select repo, root_job_id from job where org_id = ${orgId} and id = ${parentId}
        `;
    if (!label) return 'missing';
    const replayed = await replayOf(tx, orgId, createdBy, idem);
    if (replayed) return replayedFor(tx, { orgId, parentId, createdBy }, replayed);
    // The same per-thread advisory lock the claim, remove, reopen and done take: the
    // eligibility check and the insert must be atomic with a racing done on ANY member —
    // not only on the parent row the CTE below locks — or a done could commit between the
    // check and the insert and leave queued work in a thread the user closed.
    // A follow-up naming connections binds under the root row, which the claim's acquire holds before the
    // advisory lock: lock them in that order (`lockThreadRootInTx`). Without connections: unchanged.
    if (connectionIds.length > 0) await lockThreadRootInTx(tx, orgId, label.root_job_id);
    await tx`select pg_advisory_xact_lock(hashtextextended(${label.root_job_id}::text, 0))`;
    // A busy thread is answered here, before the insert: the refusal read after it is a later snapshot, and a verdict
    // committing in between would turn not_finished into forbidden.
    if (await threadBusyInTx(tx, orgId, label.root_job_id)) return 'not_finished';
    const rows = await tx<{ id: string }[]>`
            with parent as (
                select id, repo, executor, executor_scope, session_id, root_job_id, workflow_name, mode
                from job
                where org_id = ${orgId} and id = ${parentId}
                  and status in ('succeeded','failed','dead','stopped')
                  and created_by is not distinct from ${createdBy}
                  -- A named-profile review is not a task: a follow-up of it would run as an
                  -- ordinary job with the author's full env and token (issue #549).
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
            insert into job (org_id, command, created_by, repo, executor, executor_scope, parent_job_id, session_id, root_job_id, workflow_name, mode)
            select ${orgId}, ${command}, ${createdBy}, parent.repo, parent.executor, parent.executor_scope, parent.id,
                   coalesce(primary_session.session_id, parent.session_id),
                   parent.root_job_id, parent.workflow_name, parent.mode
            from parent, root, primary_session
            -- Eligibility is the THREAD's, as a retry's is (#698): a finished parent whose thread
            -- still holds unfinished work, or carries a done on any member, refuses — so a repeat
            -- never queues a second follow-up, and a closed thread never gets queued work.
            where not exists (
                select 1 from job m
                where m.org_id = ${orgId} and m.root_job_id = parent.root_job_id
                  and m.status not in ${tx([...TERMINAL_STATUSES])}
            )
              and not exists (
                select 1 from job d
                where d.org_id = ${orgId} and d.root_job_id = parent.root_job_id
                  and d.done_at is not null
            )
            returning id
        `;
    if (rows[0]) {
        await addFollowUpBindings(tx, { orgId, rootJobId: label.root_job_id, createdBy, connectionIds });
        await stampKey(tx, orgId, rows[0].id, idem);
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
    source: { orgId: string; parentId: string; createdBy: string | null },
    id: string
): Promise<CreatedRef | 'forbidden'> {
    const { orgId, parentId, createdBy } = source;
    const [parent] = await tx<{ id: string }[]>`
        select id from job
        where org_id = ${orgId} and id = ${parentId} and created_by is not distinct from ${createdBy}
    `;
    return parent ? { id, replayed: true } : 'forbidden';
}

/**
 * Names the precondition a follow-up's or a retry's conditional insert failed on, for the thread
 * AS IT IS NOW — a thread that moved on between the CTE and this read can make the refusal name
 * the newer state, and the retry then succeeds. One read for both ops, so their refusals cannot
 * drift apart. The priority: a thread with ANY unfinished member owns the turn (`not_finished`)
 * even when a member carries done_at — retry later, or reopen the done first; a done on ANY member
 * is the thread closed (`task_done`); the author predicate is decided last, so a thread that is
 * over answers its over-ness to whoever asks before it answers `forbidden` — and forbidden is the
 * catch-all for a row that moved between the CTE and this read. A row that moved all the way to
 * deleted answers `missing` rather than dying on the read.
 */
async function threadRefusalOf(
    tx: TransactionSql,
    orgId: string,
    id: string
): Promise<'missing' | 'task_done' | 'not_finished' | 'forbidden'> {
    const [row] = await tx<{ busy: boolean; done: boolean }[]>`
        select exists (
            select 1 from job m
            where m.org_id = ${orgId} and m.root_job_id = named.root_job_id
              and m.status not in ${tx([...TERMINAL_STATUSES])}
        ) as busy,
        exists (
            select 1 from job d
            where d.org_id = ${orgId} and d.root_job_id = named.root_job_id
              and d.done_at is not null
        ) as done
        from job named
        where named.org_id = ${orgId} and named.id = ${id}
    `;
    if (!row) return 'missing';
    if (row.busy) return 'not_finished';
    if (row.done) return 'task_done';
    return 'forbidden';
}

/**
 * createRetry's body (issue #326): queue a fresh attempt of the thread head's command in the SAME
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
export async function createRetryRow(
    sql: Sql,
    input: { orgId: string; id: string; createdBy: string | null; idempotency?: IdempotencyInput | undefined }
): Promise<RetryRowResult> {
    return sql.begin((tx) => retryInTx(tx, input));
}

export type RetryRowResult = CreatedRef | 'missing' | 'not_finished' | 'task_done' | 'forbidden';

/** createRetryRow's body, for a caller that already holds a transaction (the batch scheduler). */
export async function retryInTx(
    tx: TransactionSql,
    input: { orgId: string; id: string; createdBy: string | null; idempotency?: IdempotencyInput | undefined }
): Promise<RetryRowResult> {
    const { orgId, id, createdBy, idempotency: idem } = input;
    // The read resolves the thread root the advisory lock below is keyed by.
    const [label] = await tx<{ repo: string | null; root_job_id: string }[]>`
            select repo, root_job_id from job where org_id = ${orgId} and id = ${id}
        `;
    if (!label) return 'missing';
    const replayed = await replayOf(tx, orgId, createdBy, idem);
    if (replayed) return replayedFor(tx, { orgId, parentId: id, createdBy }, replayed);
    // The same per-thread advisory lock the claim, remove, reopen and done take: the
    // eligibility check and the insert must be atomic with a racing done on ANY member and
    // with a claim of the head, or a done could commit between the check and the insert and
    // leave a fresh attempt queued into a closed thread.
    await tx`select pg_advisory_xact_lock(hashtextextended(${label.root_job_id}::text, 0))`;
    // The insert below skips when the named row or any member of its thread is not terminal, and the refusal read
    // after it is a later snapshot: a verdict committing in between would turn not_finished into forbidden. Answer
    // from this read instead. Under the thread lock no member leaves terminal or appears (follow-up, retry and
    // reopen take it too), so this and the insert's busy predicate agree.
    if (await threadBusyInTx(tx, orgId, label.root_job_id)) return 'not_finished';
    const rows = await tx<{ id: string }[]>`
            with named as (
                select id, root_job_id
                from job
                where org_id = ${orgId} and id = ${id}
                  and created_by is not distinct from ${createdBy}
                  -- A named-profile review is not a task: a retry of it would run as an ordinary
                  -- job with the author's full env and token, in the reviewer's worktree (#549).
                  and review_of is null
                  -- A running or queued member answers not_finished: locking it here would wait on a row
                  -- a claim or a verdict holds while that one waits on the lock above (BEL-157).
                  and status in ${tx([...TERMINAL_STATUSES])}
                for update
            ),
            head as (
                select command, repo, executor, executor_scope, root_job_id, workflow_name, mode
                from job
                where org_id = ${orgId} and root_job_id = (select root_job_id from named)
                order by created_at desc, id desc
                limit 1
            )
            insert into job (org_id, command, created_by, repo, executor, executor_scope, root_job_id, workflow_name, mode)
            select ${orgId}, head.command, ${createdBy}, head.repo, head.executor, head.executor_scope,
                   head.root_job_id, head.workflow_name, head.mode
            from named, head
            where not exists (
                  select 1
                  from job m
                  where m.org_id = ${orgId}
                    and m.root_job_id = head.root_job_id
                    and m.status not in ${tx([...TERMINAL_STATUSES])}
              )
              and not exists (
                  select 1
                  from job d
                  where d.org_id = ${orgId}
                    and d.root_job_id = head.root_job_id
                    and d.done_at is not null
              )
            returning id
        `;
    if (rows[0]) {
        await stampKey(tx, orgId, rows[0].id, idem);
        return { id: rows[0].id };
    }
    // Nothing inserted — one of the preconditions failed, and which one decides the answer
    // the route turns into a status code.
    return threadRefusalOf(tx, orgId, id);
}

/**
 * editCommand's body (issue #329). One conditional UPDATE carries every precondition — queued,
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
): Promise<{ status: JobStatus; doneAt: string } | 'missing' | 'conflict' | 'batch'> {
    const { sql, orgId } = ctx;
    // One transaction, because done is what frees the tree now (issue #47's second half):
    // stamping done_at and queueing the worktree reclaim must be decided together, on the
    // thread AS THE DONE LANDS — the terminality read below runs on the same connection,
    // where the just-stamped row is visible and a follow-up inserted after the commit is
    // not. A thread that is still moving keeps its tree: its last completing attempt will
    // find every member terminal AND this done_at in place, and reclaim at the verdict.
    return sql.begin(async (tx) => {
        // The thread root, straight off the named row (022) — the same pre-lock read remove and
        // reopen make. Nothing when the input never existed.
        const [named] = await tx<{ root_job_id: string }[]>`
            select root_job_id from job where org_id = ${orgId} and id = ${id}
        `;
        if (!named) return 'missing';
        // The same per-thread advisory lock the claim, remove, reopen and both insert paths take:
        // stamping done_at must be atomic with the follow-up and retry inserts — whose
        // thread-done eligibility checks read it — and with remove and reopen, or one of them
        // could decide against a thread whose done it could not see. It also serializes done
        // against remove and reopen, which row-locking alone never did.
        await tx`select pg_advisory_xact_lock(hashtextextended(${named.root_job_id}::text, 0))`;
        // A live batch task's thread is closed by the batch, never by a plain Done: Done would block
        // the task's retry and queue the reclaim of the tree that retry runs in. Once the batch ended
        // or a person force-closed the task, nothing retries it and Done closes it.
        if ((await batchThreadState(tx, orgId, named.root_job_id)) === 'live') return 'batch';
        // coalesce, not assignment: the second "done" answers the first one's instant,
        // which is what makes the route idempotent rather than silently rewriting history.
        // done_by rides the same rule: the first writer's actor survives a retried click.
        const rows = await tx<{ status: JobStatus; done_at: Date; root_job_id: string }[]>`
            update job set done_at = coalesce(done_at, now()), done_by = coalesce(done_by, ${doneBy})
            where org_id = ${orgId} and id = ${id}
              and status in ${tx([...TERMINAL_STATUSES])}
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

export type StopJobResult = Awaited<ReturnType<JobStore['stop']>>;

export async function stopJob(ctx: JobStoreContext, id: string, stoppedBy: string | null): Promise<StopJobResult> {
    const { sql, orgId, wallTick, prs } = ctx;
    // One statement decides the outcome by the status it sees. A QUEUED row never started,
    // so it is settled `stopped` here: the turn is over, and the session it keeps is what
    // the follow-up continues. A RUNNING
    // row whose lease is still live is stamped `cancel_requested_at` and left running:
    // the request travels on the heartbeat the worker already sends, and the settle that
    // honours it (suspend under the stamp) clears it. A RUNNING row whose lease has
    // ALREADY expired is settled `stopped` here instead (issue #152): nobody holds the
    // lease, so a stamp would wait for a heartbeat nobody will send — and a previous
    // holder that is still beating loses the row on its next beat (`lost`, the kill
    // order) exactly as a reclaim delivers it. The settle lands like the suspend park
    // does: finished_at stamped, the last segment banked, the attempt handed back — a
    // stop is a park, not a failed try — and the session kept for the follow-up.
    // coalesce keeps the FIRST request, which is what makes /stop idempotent rather than
    // a rewrite of when it was asked. stopped_by coalesces beside it unconditionally —
    // every status this UPDATE touches is a stoppable one, so this caller acted, and the
    // first asker is the actor that survives. Under the row's lock, an expired attempt that staged its
    // conclusion (issue #821) is committed first, its Stop stamped with it: the verdict stands, and
    // the row the statement then finds terminal answers the conflict below with the committed status.
    const rows = await sql.begin(async (tx) => {
        await tx`select id from job where org_id = ${orgId} and id = ${id} for update`;
        await commitStagedForStop(ctx, tx, { id, stoppedBy });
        return stopRows(tx, { orgId, wallTick, stoppedBy, where: tx`id = ${id}` });
    });
    const row = rows[0];
    if (!row) {
        // Nothing settled or moving — a task that already ended has no turn to stop, and
        // the status rides the refusal so the route can say which.
        const [other] = await sql<{ status: JobStatus }[]>`
            select status from job where org_id = ${orgId} and id = ${id}
        `;
        return other ? { result: 'conflict', status: other.status } : 'missing';
    }
    // The caller's reviews go with it (issue #549): a Stop reaches every separate run it started.
    await stopReviewsOf(sql, { orgId, wallTick, stoppedBy }, [id]);
    if (row.cancel_requested_at === null) {
        // A settled stop ends the thread's turn: its PR waits have nothing left to
        // fold for — the session a follow-up continues from starts its own wait cycle.
        if (prs) {
            await prs.cancelWaitsForRoot(row.root_job_id, 'task stopped');
        }
        // A merge-marked thread whose last moving member just stopped is closed by that stop
        // (issue #390): done stamp, reclaim — the shared conditional settle, a no-op on any
        // thread the closure never marked.
        await settleIfMergeClosed(ctx, row.root_job_id);
    }
    return row.cancel_requested_at !== null
        ? { result: 'requested', cancelRequestedAt: row.cancel_requested_at.toISOString() }
        : { result: 'stopped' };
}

export async function suspendJob(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string
): ReturnType<JobStore['suspend']> {
    const { sql, orgId, wallTick } = ctx;
    // One update: the parking IS the user's stop landing (the stamp the heartbeat
    // delivered). The row settles `stopped` — terminal, `finished_at` stamped, the session
    // kept for the follow-up that continues the turn. The lease expires, exactly as insert
    // does it: the row is not claimable, so this changes nothing while it sits — and then
    // it is the difference between the next poll acting on the row and it waiting out the
    // lease the dying worker held. The command is in the transcript now
    // (command_delivered_at), the stamp clears — the stop has happened — and the attempt is
    // handed back: a park is not a failed try, so it must never exhaust max_attempts. The park and
    // its settle receipt (issue #821) commit together, so a replay after a lost answer gets it.
    const key: SettleKey = { orgId, jobId: id, leaseToken, operation: 'suspend', fingerprint: fingerprintOf(null) };
    return sql.begin(async (tx) => {
        if ((await stagedFingerprint(tx, key)) !== null) return { result: 'conflict' };
        const rows = await tx<{ id: string; status: JobStatus; root_job_id: string }[]>`
            update job set
                status           = 'stopped',
                finished_at      = now(),
                -- The park ends the segment the attempt was running: the container was doing
                -- real work up to now, and the time after this statement banks nothing.
                wall_clock_ms    = ${wallTick},
                lease_token      = null,
                -- Expired on the way in, exactly as insert does it.
                lease_expires_at = now(),
                -- The command is in the transcript now, and this is the moment that becomes
                -- true: the claim reads this column to keep a resumed follow-up from
                -- re-delivering it (see claim). coalesce, so parking twice stamps once.
                command_delivered_at = coalesce(command_delivered_at, now()),
                -- Parking IS the deferred stop landing (the flag was set by the user's /stop
                -- and delivered by the heartbeat): cleared now, or the settled row would keep
                -- answering a request that already happened.
                cancel_requested_at = null,
                -- Hands back the attempt the claim took.
                attempts         = greatest(attempts - 1, 0)
            where org_id = ${orgId} and id = ${id}
              and status = 'running' and lease_token = ${leaseToken}
            returning id, status, root_job_id
        `;
        if (rows[0]) {
            // The park settles a moving row; a merge-marked thread whose last moving member just
            // parked is closed by it (issue #390) — the shared conditional settle.
            await settleIfMergeClosed(ctx, rows[0].root_job_id, tx);
            const answer = { result: 'ok', status: rows[0].status } as const;
            await recordReceipt(tx, key, answer);
            return answer;
        }
        return missedSettle<SuspendResult>(tx, key);
    });
}

/**
 * How many attempts the infrastructure may interrupt before an interruption is refused (issue
 * #792): an interrupted attempt is refunded, so this — not `max_attempts` — bounds a job the
 * platform keeps taking away.
 */
export const INTERRUPTION_BUDGET = 5;

/**
 * How long a blocked hand-back defers the next claim (BEL-160): the claim could not start because a
 * leftover of an earlier claim is still terminating, so an immediate re-claim would only meet it again.
 */
export const BLOCKED_RETRY_SECONDS = 60;

/**
 * Whether the row's interruption budget is spent. A blocked hand-back waits on a leftover rather than
 * losing an attempt to the infrastructure, so it is outside the count (BEL-160).
 */
export const interruptionsSpent = (q: Sql | TransactionSql): Fragment => q`(
    select count(*) from jsonb_array_elements(interruptions) as spent
    where spent ->> 'blocked' is distinct from 'true'
) >= ${INTERRUPTION_BUDGET}`;

/** The interruption the next claim records for an attempt whose lease expired (issue #822). */
export const LEASE_EXPIRED_REASON = 'the lease expired: its driver went silent';

export async function interruptJob(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    { reason, release, claimSeq = null, refused = false, blocked = false }: Parameters<JobStore['interrupt']>[2]
): ReturnType<JobStore['interrupt']> {
    const { sql, orgId, wallTick } = ctx;
    // One lease-guarded update, an agent ran: the segment banks to the
    // wall clock and `started_at` clears, so the next claim banks nothing twice. `release` false is
    // an adoption: an attempt this claim superseded was the one interrupted (`claimSeq` names it),
    // and this one keeps its lease. A Stop already stamped wins over a release, as over a suspend.
    // An attempt already recorded (handed over, or expired and recorded by the claim that took it
    // over, then adopted) is one disruption: refunded once.
    const entry = sql.json({ reason, at: new Date().toISOString(), ...(blocked ? { blocked: true } : {}) });
    const recorded = sql`interruptions @> jsonb_build_array(
        jsonb_build_object('claimSeq', coalesce(${claimSeq}::bigint, claim_seq))
    )`;
    // A release concludes the attempt, so it records a settle receipt in the same transaction (issue
    // #821); an adoption keeps the lease, and the `recorded` check above is its idempotence.
    const key: SettleKey = {
        orgId,
        jobId: id,
        leaseToken,
        operation: 'interrupt',
        fingerprint: fingerprintOf({ reason, release, claimSeq, blocked }),
    };
    return sql.begin(async (tx) => {
        // A staged conclusion is the attempt's outcome (issue #821): nothing hands it back instead.
        if (release && (await stagedFingerprint(tx, key)) !== null) return { result: 'conflict' };
        await recordInterruptLaunch(tx, { orgId, id, leaseToken }, { release, refused, claimSeq, blocked }, recorded);
        const rows = await tx<{ status: JobStatus; root_job_id: string }[]>`
            update job set
                status           = case when not ${release} then status
                                        when cancel_requested_at is null then 'queued' else 'stopped' end,
                finished_at      = case when ${release} and cancel_requested_at is not null then now() else finished_at end,
                wall_clock_ms    = case when ${release} then ${wallTick} else wall_clock_ms end,
                started_at       = case when ${release} then null else started_at end,
                lease_token      = case when ${release} then null else lease_token end,
                lease_expires_at = case when ${release} then now() else lease_expires_at end,
                claim_deferred_until = case when ${release && blocked}
                    then now() + make_interval(secs => ${BLOCKED_RETRY_SECONDS}::int) else claim_deferred_until end,
                cancel_requested_at = case when ${release} then null else cancel_requested_at end,
                attempts         = greatest(attempts - 1, 0),
                interruptions    = interruptions || jsonb_build_array(
                    ${entry}::jsonb || jsonb_build_object('claimSeq', coalesce(${claimSeq}::bigint, claim_seq))
                )
            where org_id = ${orgId} and id = ${id}
              and status = 'running' and lease_token = ${leaseToken}
              and (${blocked && release} or not ${interruptionsSpent(tx)})
              and not ${recorded}
            returning status, root_job_id
        `;
        const row = rows[0];
        if (row) {
            if (row.status === 'stopped') await settleIfMergeClosed(ctx, row.root_job_id, tx);
            const answer = { result: 'ok', status: row.status } as const;
            if (release) await recordReceipt(tx, key, answer);
            return answer;
        }
        return missedInterrupt(tx, key, recorded);
    });
}

/**
 * The launch outcome an interruption proves (issue #845), decided on the row the interruption's
 * update changes, locked here. A release is recorded only under the update's own conditions (a
 * spent budget or a replay records nothing); an adoption link is a fact of the adopting claim
 * whether or not the expiry already recorded the interruption, and set once.
 */
async function recordInterruptLaunch(
    tx: TransactionSql,
    at: { orgId: string; id: string; leaseToken: string },
    {
        release,
        refused,
        claimSeq,
        blocked,
    }: { release: boolean; refused: boolean; claimSeq: number | null; blocked: boolean },
    recorded: Fragment
): Promise<void> {
    if (!refused && release) return;
    const { orgId, id, leaseToken } = at;
    const open = release ? tx`and (${blocked} or not ${interruptionsSpent(tx)}) and not ${recorded}` : tx``;
    const [held] = await tx<{ claim_seq: string }[]>`
        select claim_seq from job
        where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken} ${open}
        for update
    `;
    if (!held) return;
    const claim = { orgId, jobId: id, claimSeq: held.claim_seq };
    if (release) await recordLaunchOutcome(tx, claim, { refused: true });
    else if (claimSeq !== null) await recordLaunchOutcome(tx, claim, { adopts: claimSeq });
}

/**
 * An interrupt whose update missed: a released one replayed answers its receipt (issue #821); an
 * adoption already recorded answers ok again, without a second refund; otherwise the lease is
 * lost, the job gone, or the budget spent.
 */
async function missedInterrupt(
    tx: TransactionSql,
    key: SettleKey,
    recorded: Fragment
): ReturnType<JobStore['interrupt']> {
    const replayed = await settleReplayOf<SuspendResult>(tx, key);
    if (replayed) return replayed;
    const [held] = await tx<{ held: boolean; recorded: boolean; status: JobStatus }[]>`
        select status = 'running' and lease_token = ${key.leaseToken} as held, ${recorded} as recorded, status
        from job where org_id = ${key.orgId} and id = ${key.jobId}
    `;
    if (!held) return { result: 'missing' };
    if (!held.held) return { result: 'lost' };
    return held.recorded ? { result: 'ok', status: held.status } : { result: 'exhausted' };
}

export async function removeJobThread(
    ctx: JobStoreContext,
    id: string,
    removedBy: string | null
): ReturnType<JobStore['removeThread']> {
    const { sql, orgId, prs } = ctx;
    // Same per-thread advisory lock the claim takes, for the same serialization reason: the
    // refusal check and the delete must see every earlier claim of this thread commit, or a
    // claim could walk out with a row after the check passed and before the delete ran — a
    // removed task with a member running again afterwards. The lock queues removals against
    // claims of the same thread and nothing else.
    return sql.begin(async (tx) => {
        // The thread root, straight off the named row (022). Nothing when the input never
        // existed — the row read below then answers nothing and the route says missing.
        const [named] = await tx<{ id: string; root_job_id: string }[]>`
            select id, root_job_id from job
            where org_id = ${orgId} and id = ${id}
        `;
        if (!named) return 'missing';
        const rootJobId = named.root_job_id;
        await tx`select pg_advisory_xact_lock(hashtextextended(${rootJobId}::text, 0))`;

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
        // running member's verdict holds those rows and waits on this root lock (issue #821).
        if (hasRunningMember(members)) return 'conflict';
        // The thread's named-profile reviews (issue #549) are threads of their own, so they are
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
        // Any parked or already-woken block-wait round (issue #231) is this thread's audit data
        // too — cancelWaitsForRoot above already makes it permanently unwakeable, this is just not
        // leaving it behind forever.
        await tx`delete from workflow_round where org_id = ${orgId} and root_job_id = ${rootJobId}`;
        // The merge-closure marker (issue #390) is the thread's audit data the same way: the rows
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
 * The shared preamble of both wait-control verbs (issue #328): resolve the named id to its
 * thread root and check the caller may act on the thread. `id` may be any member — the wait
 * belongs to the root, exactly as `removeThread` resolves. Author-scoped like the follow-up (the
 * woken continuation runs in the author's worktree): only the account that queued the thread —
 * or an anonymous caller on a thread with no author — gets past here.
 */
type ControlledRoot = { ok: true; root: string } | { ok: false; refusal: 'missing' | 'forbidden' };

async function resolveControlledRoot(
    sql: Sql,
    orgId: string,
    id: string,
    caller: string | null
): Promise<ControlledRoot> {
    const [named] = await sql<{ root_job_id: string; created_by: string | null }[]>`
        select root_job_id, created_by from job
        where org_id = ${orgId} and id = ${id}
    `;
    if (!named) return { ok: false, refusal: 'missing' };
    if (named.created_by !== caller) return { ok: false, refusal: 'forbidden' };
    return { ok: true, root: named.root_job_id };
}

/**
 * The user's wait-cancel (issue #328): `cancelWaitsForRoot` with the user reason and the acting
 * caller, decided atomically enough — the update's `cancelled_at is null` predicate IS the
 * no-open-wait answer, so a cancel racing itself answers `ok` exactly once and `no_wait` after.
 * No advisory lock, exactly like `cancelForRepoPr`/`cancelWaitsForRoot` today: a cancel can land
 * at any time, including between a wake committing and the continuation being claimed, and the
 * claim-time cancellation fence is what makes cancellation win that race.
 */
export async function cancelThreadWait(
    ctx: JobStoreContext,
    id: string,
    cancelledBy: string | null
): ReturnType<JobStore['cancelWait']> {
    const { sql, orgId, prs } = ctx;
    const resolved = await resolveControlledRoot(sql, orgId, id, cancelledBy);
    if (!resolved.ok) return resolved.refusal;
    if (!prs) return 'no_wait';
    const cancelled = await prs.cancelWaitsForRoot(resolved.root, 'cancelled by user', undefined, cancelledBy);
    return cancelled > 0 ? { result: 'ok' } : 'no_wait';
}

/**
 * The user's poke (issue #328): re-evaluate the parked PR now. The board's only GitHub input is
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
    pokedBy: string | null
): ReturnType<JobStore['pokeWait']> {
    const { sql, orgId, prs } = ctx;
    const resolved = await resolveControlledRoot(sql, orgId, id, pokedBy);
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
        const jobId = await wakeOneRound({ sql, orgId, prs }, root, round.workflow_node, false);
        woken = woken || jobId !== null;
    }
    return { result: 'ok', woken };
}

/**
 * Done's inverse (issue #327): clear the done stamp on every member of the thread and withdraw a
 * task_reclaim row that has not run yet, so a task closed by mistake can be followed up again —
 * createFollowUpRow's thread-wide done predicate is exactly what this reverses. The whole decision
 * is one transaction under the SAME per-thread advisory lock the claim, remove and reclaim ack
 * take: the refusal checks, the withdraw and the clear must see every earlier claim and ack of this
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
        // The thread root, straight off the named row (022) — the same pre-lock read
        // removeJobThread makes. Nothing when the input never existed.
        const [named] = await tx<{ id: string; root_job_id: string }[]>`
            select id, root_job_id from job
            where org_id = ${orgId} and id = ${id}
        `;
        if (!named) return 'missing';
        const rootJobId = named.root_job_id;
        await tx`select pg_advisory_xact_lock(hashtextextended(${rootJobId}::text, 0))`;

        // A removed tree is unrecoverable: a follow-up resumes a session in the tree it ran in,
        // and there is no tree. The marker (045) is stamped only at the ack (a threadDone verdict
        // queues its reclaim claimed, issue #821) — the queue row alone could not carry this,
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
            where org_id = ${orgId} and root_job_id = ${rootJobId} and done_at is not null
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
            where org_id = ${orgId} and root_job_id = ${rootJobId} and done_at is not null
        `;
        // A merge closure's marker (issue #390) is the discriminator complete's transition reads:
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
