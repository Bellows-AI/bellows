/**
 * The member-action half of the job store's interface: what `createJobStore` serves for create, follow up, retry,
 * edit, done, stop, suspend, interrupt, remove, the wait pair and reopen.
 */

import type { BindConnectionResult, DismissRequirementResult } from './job-store-connections.js';
import type { IdempotencyInput } from './job-store-idempotency.js';
import type {
    CancelWaitResult,
    EditCommandResult,
    BatchesDisabledRefusal,
    FollowUpRefusal,
    JobStatus,
    JobStore,
    PokeWaitResult,
    RemoveResult,
    ReopenResult,
    RetryRefusal,
    StopResult,
    SuspendResult,
} from './job-store-types.js';
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
             * The branch the task bases its checkout and PR on; null or absent is the remote default.
             * Stored on the ROOT row only: every later row of the thread reads it from there at claim.
             */
            baseBranch?: string | null;
            /** An explicit title, normalized by the route: stored on the root (origin `user`, revision 1) in the create transaction. */
            title?: string | null;
            /**
             * The connections (054, 094) the task names, bound on the ROOT in the create
             * transaction: each must be bindable by the author or the create is refused with
             * `ConnectionRefusedError`. A bindable provider the author has exactly one personal
             * connection for binds by default; a provider a selected skill requires with none
             * becomes an open requirement the claim waits on. Absent is none named.
             */
            connectionIds?: readonly string[];
            /**
             * Completed uploads (116) the task carries, bound to the new job in the create transaction in the order named:
             * each must be a ready file of the author or the create is refused with `AttachmentRefusedError`. Absent is none.
             */
            attachmentIds?: readonly string[];
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
        connectionIds?: readonly string[],
        /** The route's verdict that the caller is an org admin: it admits a thread whose owner is someone else. */
        admin?: boolean,
        /** Uploads to bind to the follow-up itself; `AttachmentRefusedError` when any is not the author's ready file. */
        attachmentIds?: readonly string[]
    ): Promise<{ id: string; replayed?: boolean } | FollowUpRefusal | BatchesDisabledRefusal>;

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
     * The owner declines `provider` for the thread: its open requirement closes as `dismissed` at the
     * current binding revision, the claim launches the task without it, and a later ask at that revision answers
     * `unavailable`. `missing` for an unknown job or anyone but the execution user; `none-open` when nothing is open.
     */
    dismissRequirement(id: string, provider: string, userId: string): Promise<DismissRequirementResult>;

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
        idempotency?: IdempotencyInput,
        /** The route's verdict that the caller is an org admin: it admits a thread whose owner is someone else. */
        admin?: boolean
    ): Promise<{ id: string; replayed?: boolean } | RetryRefusal | BatchesDisabledRefusal>;

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
    ): Promise<{ status: JobStatus; doneAt: string } | 'missing' | 'conflict' | 'batch' | BatchesDisabledRefusal>;

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
    cancelWait(id: string, cancelledBy: string | null, admin?: boolean): Promise<CancelWaitResult>;

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
    pokeWait(id: string, pokedBy: string | null, admin?: boolean): Promise<PokeWaitResult>;

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
     * claim. `refused` says the runner never started (issue #845). `blocked` (a release only) says the claim waits on a leftover still terminating: it spends no budget, is accepted past a spent one, and defers the next claim `BLOCKED_RETRY_SECONDS`. `requirement` (a release only) says the task waits on a connection it asked for: no budget, accepted past a spent one, no deferral (the open requirement holds the claim). `nodeLoss` (a release only, BEL-302) says the platform took the attempt away (a drained driver, an evicted runner): it spends no `INTERRUPTION_BUDGET`, is accepted past a spent one, and counts against `NODE_LOSS_BUDGET` per `NODE_LOSS_WINDOW_MS` instead. `exhausted` once `INTERRUPTION_BUDGET` (or, for a node loss, that bound) is spent: nothing
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
            requirement?: boolean;
            nodeLoss?: boolean;
        }
    ): Promise<SuspendResult | { result: 'exhausted' }>;
}

export type CreateTarget = Parameters<JobStore['create']>[2];

/** A created row's id; `replayed` when a repeated idempotent request found it already made. */
export type CreatedRef = { id: string; replayed?: boolean };
