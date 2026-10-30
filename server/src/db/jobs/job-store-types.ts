/**
 * Every shape the job board speaks: the job and claim records, `JobStore` (the intersection of the
 * per-concern interfaces that live beside their implementations) with its result types, the task read model, and the factory's dependencies (`CreateJobStoreDeps`) plus the
 * context every method function receives (`JobStoreContext`). Types only, bar nothing — the
 * behavior is in the sibling `job-store-*.ts` files, which job-store.ts's header maps.
 */

import type { GateRunStore } from './job-store-gate-runs.js';
import type { PrOperationStore } from './job-store-pr-operations.js';
import type { TranscriptToolStore } from './job-store-transcript-tools.js';
import type { PhaseCheckpointStore } from './job-store-phase-checkpoints.js';
import type { JobActionStore } from './job-store-actions.js';
import type { JobMergeStore } from './job-store-merge.js';
import type { JobQuestionStore } from './job-store-questions.js';
import type { JobReviewStore } from './job-store-reviews.js';
import type { JobClaimStore } from './job-store-claim.js';
import type { JobReclaimStore } from './job-store-reclaims.js';
import type { JobReadStore } from './job-store-reads.js';
import type { JobWorkerStore } from './job-store-worker.js';
import type { JobConclusionStore } from './job-store-conclusions.js';
import type { UserRef, ExecutorScope, ExecutorType, JobMode } from '@factory-ai/core';
import type { AdmissionBudgets, ClaimObserver, JobAdmissionStore } from './job-store-admission.js';
import type { Sql, TransactionSql, Fragment } from 'postgres';
import type { PublicationState, WaitState } from '../pr-lifecycle-store.js';
import type { BellowsConfig } from '../../workspace/bellows.js';
import type { ServiceSpec } from '../../workspace/bellows-services.js';
import type { EvidencePolicy, ReviewEvidence } from '../evidence-policy.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'stopped';

/**
 * Why a settle long-poll returned: the thread's chain head is `terminal`, an open workflow wait
 * has it `parked` (nothing the poller does moves it), or the hold's deadline passed with the
 * thread still moving (`timeout`). The wire value, copied by `cli/src/board.ts`.
 */
export type SettleResult = 'terminal' | 'parked' | 'timeout';

/** The settle long-poll's answer: the result, and the thread identity it was judged on. */
export interface SettleOutcome {
    result: SettleResult;
    rootJobId: string;
    headJobId: string;
    headStatus: JobStatus;
    /** The open wait's reason when `parked`, else null. */
    waitReason: string | null;
}

/** What a worker may report. 'dead' is the board's verdict, never a worker's. */
export type JobOutcome = 'succeeded' | 'failed';

/**
 * The structured terminal reason of a run (issue #339), stored as `job.failure_kind` and served on
 * every job read: why a failed run failed — the timeout kill, a prompt-cache loss, an agent
 * reporting itself blocked, a failed gate, an unlanded publish, a failed block-helper, a dead
 * declared service, or the runner erroring. Null is "not a failure": a success, or a row older
 * than the column (044). Copied here rather than imported because the driver depends on nothing;
 * the spellings are a wire contract kept in step by the route's validation.
 */
export type FailureKind =
    | 'timeout'
    | 'cache_lost'
    | 'blocked'
    | 'gate'
    | 'publish'
    | 'helper'
    | 'services'
    | 'config'
    | 'policy'
    | 'checkpoint_unrestorable'
    | 'runner_error';

/**
 * What lies under a `gate`, `publish` or `helper` failure (issue #581), stored as
 * `job.failure_cause` and read only by the batch scheduler's recovery: a conflict or failed check is
 * repaired, a transport loss or an environment fault retried, a refusal or bad configuration left to
 * a person. Null on every other kind. Copied from the driver's `board.ts`, which depends on nothing.
 */
export type FailureCause = 'verification' | 'conflict' | 'denied' | 'config' | 'transport' | 'environment' | 'unknown';

/** Where one declared gate is, right now. 'running' is the worker's claim, the others its verdict. */
export interface GateReport {
    name: string;
    status: 'running' | 'passed' | 'failed';
    exitCode: number | null;
    /** The gate's tail. Bounded by the driver's window; truncated again at the route. */
    output: string | null;
    /** The recorded execution this entry is (issue #983); absent for a gate no record covers. */
    executionId?: string;
    /** Set when the gate was not launched but served from an earlier verified pass (issue #983). */
    reused?: { executionId: string; finishedAt: string | null; reason: string };
}

/**
 * One declared service of the attempt's `.bellows.yaml`, as the driver's platform reports it:
 * the declared name (the DNS name inside the job), the image, and a lowercase state word —
 * docker's container State, or the pod phase under kubernetes.
 */
export interface ServiceStatus {
    name: string;
    image: string;
    state: string;
    /** Why a dead service died (issue #487): present only once the driver read its ending. */
    exitCode?: number | null;
    reason?: string | null;
    logTail?: string;
    hint?: string;
}

/**
 * The running attempt's vitals, sampled by the driver off its runner container and reported beside
 * the output tail: whether the container is actually doing work (CPU, memory) and what the agent
 * says it is doing right now (the stream's last line, its tool call most often). Current/last
 * state only — this is the "is it stuck or working" answer, not a sampling history. Null on every
 * job with no sample yet (a fresh attempt, or a kubernetes runner, which reports none).
 */
export interface RuntimeVitals {
    /** Whole-container CPU, percent of one host core; null when it could not be read this round. */
    cpuPercent: number | null;
    /** Resident memory, in MiB; null when it could not be read this round. */
    memUsedMb: number | null;
    /** Resident memory against the container's limit, percent; null when the daemon reports none. */
    memPercent: number | null;
    /** The agent's newest output line, ANSI-stripped and capped — the current tool call, usually. */
    activity: string | null;
    /** When the driver took the sample. A reader can see staleness from this alone. */
    sampledAt: string;
    /**
     * The attempt's declared `.bellows.yaml` services and their current states — present only
     * when the attempt declared any and the driver could read them. Cleared with the numbers on
     * the next claim: the fleet describes the attempt that took the lease.
     */
    services?: ServiceStatus[];
    /**
     * How far behind the continuous transcript export is: the bytes the board has not yet
     * acknowledged and the age of the oldest of them. Present only on a run that exports its
     * transcript; like the fleet, a missing key leaves the last report standing.
     */
    transcriptExport?: TranscriptExportVitals;
}

/** The transcript exporter's backlog, as the driver reports it with the vitals. */
export interface TranscriptExportVitals {
    pendingBytes: number;
    oldestUnackedMs: number;
}

/** One attempt the infrastructure interrupted (071, issue #792). */
export interface JobInterruption {
    at: string;
    reason: string;
    claimSeq: number;
    /** A hand-back that waited on a leftover still terminating: outside the interruption budget (BEL-160). */
    blocked?: true;
    /** A hand-back that waited on a connection the task asked for: outside the interruption budget. */
    requirement?: true;
}

export interface Job {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    maxAttempts: number;
    claimedBy: string | null;
    /**
     * The account that queued this job, or null for one queued before accounts existed.
     *
     * This is the audit trail on a route that runs shell commands, and it is also the seam the
     * per-user Claude credential and per-user workspace work reads: a claim reports it so the driver
     * can resolve them without ever touching the database.
     */
    createdBy: string | null;
    /**
     * Who `createdBy` resolves to — the account labels, joined at read time and never stored on
     * the row: logins and display names go stale, joins do not. Null for a pre-accounts row, and
     * for a job whose author's account has since been deleted (`on delete set null`) — rendered
     * as "unknown" rather than papered over with a synthetic author.
     */
    author: UserRef | null;
    /**
     * Who asked to stop the task — the person's verdict, stamped at REQUEST time (a running row
     * settles later through suspend; the asker is the actor, not the parking that delivered the
     * ask). First asker wins, so a retried click cannot rewrite history. Null on every task
     * nobody has asked to stop.
     */
    stoppedBy: UserRef | null;
    /**
     * Who marked the task done. First writer wins beside `doneAt`, the same idempotence rule.
     * Null on every task closed before attribution existed.
     */
    doneBy: UserRef | null;
    /** The agent session this attempt runs as, once its driver has reported it. */
    sessionId: string | null;
    exitCode: number | null;
    output: string | null;
    /**
     * What the run did, in the agent's own last words — lifted from the session records the
     * executor's close-time read already walks, and reported with the verdict. Null is
     * UNMEASURED (no read, a run cut off before any final text, a row predating the column) —
     * the command above records what was ASKED; this records what was done.
     */
    summary: string | null;
    /**
     * The structured terminal reason (issue #339) — why a FAILED run failed: the timeout kill, a
     * prompt-cache loss, an agent reporting itself blocked, a failed gate, an unlanded publish, a
     * failed block-helper, or the runner erroring. Null on every success, and on every row that predates the column (044) — "not a
     * failure", never "unknown failure".
     */
    failureKind: FailureKind | null;
    /**
     * What caused a `gate`, `publish` or `helper` failure (#581) — the half a batch's recovery
     * decides on. Null beside any other kind, on success, and when the worker reported none.
     */
    failureCause: FailureCause | null;
    /**
     * The verification gates this run has run or is running — the checks the job's checkout
     * declares in `.bellows.yaml` and the driver executes in the declared environment image.
     * Current/last state only, replaced on every worker report: the UI deliberately shows no
     * history. Null on every job that predates gates and on any job whose repository declares
     * none.
     */
    gates: GateReport[] | null;
    /**
     * The attempt's last sampled vitals — CPU, memory and the agent's current activity line — as
     * the driver reports them beside the output tail. Null until the first sample lands; left on
     * the row when the run ends, where "was it doing anything when it died" reads off `sampledAt`.
     */
    runtime: RuntimeVitals | null;
    /**
     * The repository (`owner/name`) the task was queued against, and the member's executor name it
     * was stamped with. Both remain audit labels; executor is additionally resolved against the
     * stamped scope's profile at claim time (issue 391), and the resolved type chooses what the
     * worker runs. See docs/jobs.md.
     */
    repo: string | null;
    executor: string | null;
    /**
     * The scope the executor label names (issue 391): `user` resolves against the author's own
     * profiles, `org` against the organization's. Normalized to `user` on every read — rows
     * stamped before the column existed carry null, which IS the pre-391 meaning. Copied by
     * follow-ups, retries and workflow successors wherever the label is.
     */
    executorScope: ExecutorScope;
    /**
     * The finished task this job asks for adjustments on, when it is a follow-up. The tasks chat's
     * conversation thread; null on every job queued before the mechanic and on every first task.
     * A follow-up carries a copy of the parent's session ids from insert, which is what makes the
     * run a continuation of that conversation rather than a fresh start.
     */
    followUpTo: string | null;
    /**
     * The id of the thread's ROOT job — the job itself, unless it is a follow-up, and then the
     * chain's first job. Stored on every row (022): the composite is served, never re-derived by
     * the reader. The worktree (issue #35) is keyed by it, and every member of one conversation
     * carries the same value from insert.
     */
    rootJobId: string;
    /**
     * The workflow node this run walks, when the task runs a workflow (027). Null on every other
     * row — workflow-less tasks, user follow-ups, and every job that predates workflows. This is
     * the graph position: the loop counts and the task view's node labels read it.
     */
    workflowNode: string | null;
    /**
     * The NAME of the workflow the task's thread was launched under, frozen at create (033): the
     * route stamps the resolved record's name onto the root row, and every successor and user
     * follow-up inherits it. This is the reusable process the member chose — `workflowNode` is
     * only a position in its graph. A later rename or delete of the source workflow never
     * rewrites it (no foreign key, no read-time join — `workflow_id`'s audit doctrine), and null
     * is honest on workflow-less tasks and on rows whose definition was already gone.
     */
    workflowName: string | null;
    /**
     * The task's execution mode (051, issue #543): 'objective' for a task created without a
     * workflow, 'workflow' for one that walks a named workflow's graph. Fixed on the root at
     * create and inherited by every follow-up, retry and successor.
     */
    mode: JobMode;
    /**
     * When the user declared the task done — the verdict no run can make. Null until they say so,
     * and only settable on a finished task; it never replaces the run's own outcome.
     */
    doneAt: string | null;
    /**
     * When a stop was requested on this ROW while it was running — the user's `/stop` landed on a
     * moving run and the worker has not parked it yet. The request is delivered through the
     * heartbeat the worker already sends (`cancelRequested`), and the flag is cleared when the
     * stop happens — parking (suspend) or finishing (complete) — never by the request itself. A
     * run whose worker died mid-stop never waits out a reclaim: the claim settles the stamped row
     * `stopped` (issue #152), the stop's own landing, and `/stop` on a row whose lease already
     * expired settles it in place. Null on every job nobody asked to stop.
     */
    cancelRequestedAt: string | null;
    /**
     * Where the author's checkouts are, RELATIVE to the workspace root: `<orgId>/<userId>` — the
     * same field the claim carries, derived here for the reads the dashboard polls so the task
     * view can show it. Null when the job has no author or this deployment has no workspace root,
     * exactly as on the claim: naming a directory that was never created would be worse than
     * saying nothing.
     */
    workspacePath: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    /**
     * The wall clock THIS row's own attempts banked (024) — the executed segments accumulated
     * at the settle points, never the time a queued row sat waiting nor the time a run waited
     * for an answer to its questions (`wallTickFragment`). The thread's total is
     * `taskWallClockMs` below; this is the run's own figure — the row's own on the per-run
     * reads, the chain head's own on the grouped terminal list. Null where nothing was ever
     * banked for the row — never zero, which would claim a measurement that was never made.
     */
    wallClockMs: number | null;
    /**
     * The assistant response cycles in THIS run's root conversation, as the executor counted them
     * at close (026). Null is unmeasured — the read failed, the run is still going, or the row
     * predates the column — never zero; a genuine zero-response run stores 0.
     */
    agentTurns: number | null;
    /**
     * How long this run's `environment.setup` ran before the agent started (069, issue #733), as the
     * driver reported it on the verdict — part of `wallClockMs`, shown apart from the agent's time.
     * Null when no setup ran or the read does not select it (the per-run lists).
     */
    setupMs: number | null;
    /**
     * The attempts the infrastructure interrupted (071, issue #792), oldest first: when, why, and
     * the claim sequence each ran under. Empty when none was; the per-run lists serve it empty too.
     */
    interruptions: JobInterruption[];
    /**
     * The wall clock the task's WHOLE thread has banked — every executed segment of every run,
     * accumulated by the board at the settle points (claim, the dead retirement, the verdict,
     * the suspend park) into `wall_clock_ms` and summed over the thread by the read. Served by
     * `thread()` and by the grouped terminal list, whose rows ARE tasks (#124) — the figure the
     * task view's head clock and the recently-completed panel both render. Null where nothing
     * has accumulated — never zero, which would claim a measurement that was never made.
     */
    taskWallClockMs: number | null;
    /**
     * The thread's PR-review wait (036), when it has one — the open wait first, else the most
     * recently active terminal one, the same rule the task-summary read model follows. Carried on
     * every member of the thread alike, since the wait belongs to the ROOT, not the run: the task
     * view renders it beside whichever member it is looking at. Served by `get()` and `thread()`
     * (#324) — the per-run lists answer null, exactly as they do for a thread that never waited.
     */
    waitReason: string | null;
    waitingSince: string | null;
    waitTerminalReason: string | null;
    /**
     * The thread's recorded publication (036, #324) — the PR identity the publishing verdict
     * landed: repo, PR number and URL, the head branch the task pushed and the base it branched
     * from. Belongs to the ROOT, so every member of the thread carries the same one. Null on a
     * thread that never published — a no-op or a failed publish writes no `job_pr` row. Served by
     * `get()` and `thread()`; the per-run lists answer null, the same rule the wait fields above
     * follow.
     */
    publication: PublicationState | null;
    /**
     * The questions the agent asked during THIS run (050, issue #531), oldest first. Served by
     * `get()` and `thread()`; the per-run lists answer an empty array.
     */
    questions: JobQuestion[];
    /**
     * The thread root's connection bindings (094), oldest first, including ones whose connection was since
     * disconnected (`live: false`). Served by `get()` and `thread()`; the per-run lists answer an empty array.
     */
    connections: JobConnection[];
    /** The thread root's `binding_revision`: what `POST /api/jobs/:id/connections` must echo. `get()`/`thread()` only, else 0. */
    bindingRevision: number;
    /** The open requirements holding the thread: a skill's provider with no live binding, or one a run asked for. `get()`/`thread()` only. */
    integrationRequirements: JobIntegrationRequirement[];
    /** The thread root's frozen execution user: who a connection requirement waits on. `get()`/`thread()` only, else null. */
    executionUser: UserRef | null;
}

/** One open requirement as the job view shows it. */
export interface JobIntegrationRequirement {
    provider: string;
    /** What a person calls the provider. */
    label: string;
    reason: 'missing' | 'ambiguous' | 'reconnect';
    /** `create`: never started; `runtime`: it ran, asked, and was handed back. */
    source: 'create' | 'runtime';
    /** The bound connection a `reconnect` is about; null otherwise. */
    connectionId: string | null;
    /** What the asking helper needs of the provider (for Jira the site); null when it named none. */
    target: string | null;
    createdAt: string;
}

/** One bound connection as the job view shows it: ids and labels only, never a credential. */
export interface JobConnection {
    connectionId: string | null;
    provider: string;
    account: string | null;
    site: string | null;
    revision: number;
    source: string;
    live: boolean;
}

/** One question the agent asked, as validated at the door (`POST /api/jobs/:id/question`). */
export interface AskedQuestion {
    question: string;
    header: string;
    multiSelect: boolean;
    options: { label: string; description?: string }[];
}

/**
 * One AskUserQuestion call of one attempt (050). `closed` is never stored: it is a `pending` row
 * whose attempt no longer holds the job's running lease, or whose job has a stop requested.
 * `answerable` is exactly the condition the answer UPDATE enforces.
 */
export interface JobQuestion {
    /** The agent's `tool_use_id`. */
    id: string;
    attempt: number;
    questions: AskedQuestion[];
    status: 'pending' | 'answered' | 'expired' | 'closed';
    answerable: boolean;
    /** Question text → the answer; null until answered. Member content — never logged. */
    answers: Record<string, string> | null;
    answeredBy: UserRef | null;
    askedAt: string;
    answeredAt: string | null;
}

/** What a worker's question report did: a new row (`created`) or the stored one (`existing`). */
export type AskQuestionResult =
    | { result: 'created' | 'existing'; question: JobQuestion }
    | { result: 'lost' | 'missing' | 'limit' };

/** A reviewer profile as frozen on a review row: its instructions, env grant and budget (issue #549). */
export interface ReviewerSpec {
    name: string;
    instructions: string;
    timeoutMinutes: number;
    connections: readonly string[];
}

/** What the caller asks for: the driver measured `revision` and snapshotted it under `ref`. */
export type ReviewRequest = { key: string; profile: string; revision: string; ref: string };

/**
 * One review as the caller reads it. `status` is the review row's own; `verdict` is read from its
 * output's final marker and is `none` until a succeeded run ends on one; `findings` is the output.
 * `revision` is the tree the verdict is bound to. `evidence` is the THREAD's review evidence as the
 * policy validator sees it right now — the driver adopts it, never computes its own.
 */
export interface ReviewView {
    id: string;
    key: string;
    profile: string;
    status: JobStatus;
    verdict: 'clean' | 'blockers' | 'none';
    revision: string;
    findings: string | null;
    failureKind: FailureKind | null;
    evidence: ReviewEvidence;
}

/**
 * What a request did: a new review (`created`), the stored one (`existing`), or why none. A review
 * live under the caller's claim carries its `claim` (issue #774): leased in the request's own
 * transaction, handed back to a retried request, re-leased to a newer caller claim. A finished one
 * is answered from its row, with no claim. `running` refuses a second key: its `review` is the one
 * in flight.
 */
export type RequestReviewResult =
    | { result: 'created' | 'existing' | 'running'; review: ReviewView; claim?: Claim }
    | { result: 'lost' | 'missing' | 'unsupported' | 'unknown_profile' | 'invalid_ref' };

/** A review still running carries its `claim`, re-leased to the reading caller claim as a request would. */
export type ReadReviewResult =
    | { result: 'ok'; review: ReviewView; claim?: Claim }
    | { result: 'lost' | 'missing' | 'unknown' };

/**
 * What a member's answer did. `invalid` is a key set that does not match the stored question
 * texts; `refused` carries the stored question for `answered` (its answer and answerer ride the
 * 409), and nothing for `expired` or `closed`.
 */
export type AnswerQuestionResult =
    | { result: 'ok'; question: JobQuestion }
    | { result: 'refused'; reason: 'answered'; question: JobQuestion }
    | { result: 'refused'; reason: 'expired' | 'closed' }
    | { result: 'invalid'; message: string }
    | { result: 'unknown' };

/**
 * One declared block-helper step, resolved onto a claim (issue #207's transport, #122's first
 * producer): the driver's `HelperPlan` shape by wire convention — this package does not import
 * driver's types, and never needs to; the field names alone are the contract. `input` is resolved
 * here, generically for every helperId alike — today just the thread's recorded PR publication,
 * when it has one.
 */
export interface ClaimHelperPlan {
    helperId: string;
    phase: 'pre' | 'post';
    githubWriting: boolean;
    input: unknown;
}

/** What a worker gets back from a successful claim. The lease token is its proof for later. */
export interface Claim {
    id: string;
    command: string;
    attempts: number;
    maxAttempts: number;
    /**
     * Whether a loss of this attempt ends the job (issue #822): its attempts and its interruption
     * budget are both spent, so the board retires it `dead` when this lease expires. Until then a
     * lost attempt is an interruption, and a driver that cannot run it leaves it to the lease.
     */
    lastAttempt: boolean;
    /** The row's claim sequence (057): bumped by every claim, never refunded like `attempts`. */
    claimSeq: number;
    leaseToken: string;
    leaseExpiresAt: string;
    /**
     * The executor profile type selected by the task's stamped executor label. Null when the
     * profile no longer exists; the driver reports that as a task failure instead of choosing a
     * deployment-wide CLI.
     */
    executorType: ExecutorType | null;
    /**
     * Why the stamped profile may not launch (issue 440) — set when it is suspended, with
     * `executorType` null and its config withheld. The driver fails the task with this sentence
     * before any runner starts; a removed profile stays the plain null `executorType`.
     */
    executorRefusal: string | null;
    /**
     * Why the task's selected skills cannot run (issue #545) — a skill the catalog lacks, or a
     * connection whose env names the task's environment does not hold. Names only, never a value.
     * The driver fails the task `config` with this sentence before any runner starts; null when
     * nothing was selected or every requirement is met.
     */
    skillRefusal: string | null;
    /**
     * Why the task's execution plan cannot launch: its `.bellows.yaml` at the claimed revision does
     * not parse, declares an image the pod cannot run, or declares services whose ports collide in
     * the task pod's shared network namespace — or the installation cannot read the revision at
     * all. An actionable sentence. The driver fails the task `config` with it before any runner
     * starts; null when the plan is schedulable (or the repository declares none).
     */
    planRefusal: string | null;
    /**
     * Who queued the job, so a worker can run it as them. Null for an unattributed job.
     *
     * It was shipped ahead of any consumer so that the per-user work would be a change to the
     * driver alone. `workspacePath` below is the first half of that arriving; the per-user Claude
     * credential is still to come, and this field is what it will read.
     */
    userId: string | null;
    /**
     * The board-owned Factory execution context (issue #244), rendered by `master-prompt.ts` from
     * trusted claim metadata alone — never from `job.command`, a node's own prompt text, or any
     * other author-supplied content. Delivered through the executor's native system-instruction
     * channel, never concatenated into the command. Null only when the trusted metadata could not
     * produce a valid, bounded prompt (a workflow node claim whose snapshot is missing or does not
     * contain it) — the driver refuses the launch explicitly rather than running with no contract.
     * Thread-invariant: this claim's node and capabilities ride `turnContext` instead (issue #509).
     */
    masterPrompt: string | null;
    /**
     * This claim's node and Factory-managed capabilities, rendered by `master-prompt.ts` like
     * `masterPrompt` and null exactly when it is. The driver delivers it per turn (a hook's env for
     * claude, a prompt prefix for opencode), never into `command` itself, which also names the commit.
     */
    turnContext: string | null;
    /**
     * Where that person's checkouts are, RELATIVE to the workspace root: `<orgId>/<userId>`.
     *
     * Ready-made rather than a raw id, because each side owns what it knows. The server owns the
     * layout — it is the thing that created the directory — and the driver owns where the volume is
     * mounted, which need not be the same path the server sees. Handing over a uuid would make the
     * driver reimplement a layout it cannot verify.
     *
     * Relative for the same reason: an absolute server-side path is meaningless inside a container
     * that mounts the volume somewhere else.
     *
     * Null when the job has no author, or when this deployment has no workspace root. The driver
     * FAILS such a job rather than falling back — see driver/src/loop/loop.ts.
     */
    workspacePath: string | null;
    /**
     * The id of the thread's ROOT job — the job itself, unless it is a follow-up, and then the
     * chain's first job. Read straight off the row's `root_job_id` column (022). The task worktree
     * (issue #35) is keyed by it, so every attempt of a task and every follow-up resuming its
     * session lands in the same tree, branched off the remote default. The driver cannot walk the
     * chain — the board owns the rows — so the claim is where the root travels.
     */
    rootJobId: string;
    /**
     * The branch the run bases its checkout and its PR on: the frozen target branch of the batch
     * task the thread works. Absent outside a batch, where the remote default (`origin/HEAD`) is the base.
     */
    baseBranch?: string;
    /**
     * The ROOT job's command — `command` itself unless this is a follow-up. The driver's publisher
     * closes the issue it names: the run that publishes is often a follow-up whose own command
     * ("both OK") names none.
     */
    rootCommand: string;
    /**
     * The session this claim resumes, which the worker restores instead of starting a new one: a
     * follow-up's copy of its parent's, or the one an interrupted attempt of this row reported — a
     * lease-expiry takeover or a handover (issue #822). Null when the claim starts a new
     * conversation: a first run, or a reclaim that spends an attempt.
     */
    resumeSessionId: string | null;
    /**
     * True when this claim should still deliver a follow-up's command — its first (or crashed)
     * attempt: into the parent conversation when `resumeSessionId` is set, behind a recap of the
     * thread when it is not (`follow-up-recap.ts`). Absent on a board that predates
     * follow-ups, so it is read as `?? false` on the driver side.
     */
    followUp: boolean;
    /**
     * Whether `resumeSessionId` was minted by an attempt of THIS row — a root's, a fresh workflow
     * node's, a sessionless follow-up's — rather than inherited from an earlier row of the thread
     * (issue #822). Only such a session can be lost unwritten, with a driver gone before the CLI's
     * first write, so only its resume may start that id anew (`BELLOWS_RESUME_MAY_BE_UNWRITTEN`).
     * False when there is no session.
     */
    ownSession: boolean;
    /**
     * Whether this claim continues, in its session, the interrupted attempt it supersedes — a
     * lease-expiry takeover or a handover (issue #822). `command` stays what that attempt's first
     * claim was delivered, the text its runner is marked with for adoption; the driver frames the
     * prompt as a continuation (`driver/src/continuation.ts`).
     */
    continuesInterrupted: boolean;
    /**
     * What became of the connections this job asked for while it ran, told once to the claim that
     * continues it (and again to a takeover of that claim). Absent when there is nothing to tell.
     */
    connectionOutcomes?: { provider: string; label: string; outcome: 'bound' | 'dismissed' }[];
    /**
     * The environment the runner starts with, resolved at claim time for THIS job's author and
     * repo label: org < workspace < repo, the more specific scope winning. Optional — absent on a
     * board built without an env store, which the driver reads as "no environment".
     *
     * It never carries `GITHUB_TOKEN` or `GH_TOKEN` (`withoutGithubToken`): the runner obtains the
     * App's installation token from the board's credential endpoint (docs/connections.md).
     *
     * Deliberately NOT persisted on the job row: `GET /api/jobs/:id` serves output and metadata to
     * every member, and storing the merged values there would publish the very secrets this
     * feature exists to hold.
     */
    env?: Record<string, string>;
    /**
     * The job's `owner/name` label, repeated on the claim so the driver can key the gate
     * environment container and resolve per-repo env without a second lookup. Absent on a board
     * that predates gates, which the driver reads as "no repo".
     */
    repo?: string | null;
    /**
     * The gates the repository's `.bellows.yaml` declares at `planRevision` — the environment image
     * they run in and the named commands they run — resolved by the board through the GitHub API.
     * Null when none is declared (the ordinary case); absent when the board resolved no plan.
     */
    gates?: BellowsConfig | null;
    /** The services that file declares, validated as a whole with the gates; absent when there are none. */
    services?: readonly ServiceSpec[];
    /** The commit the plan was read at: the tip of the base branch (the default branch when none) at claim time. */
    planRevision?: string;
    /**
     * The evidence the repository requires before this work publishes or completes, read from the
     * `.bellows.yaml` at `planRevision`. ABSENT means none is required. `review` is the thread's review
     * evidence as of this claim; the driver refuses a publish the pair does not authorise.
     */
    policy?: EvidencePolicy;
    review?: ReviewEvidence;
    /**
     * The names of the reviewer profiles the repository declares (issue #774), present when there
     * are any: what the driver provisions one dormant reviewer for. Absent on a reviewer's own claim.
     */
    reviewerProfiles?: readonly string[];
    /**
     * Present only on a named-profile review's claim (issue #549) (issue #549): the git ref its worktree starts
     * from, and the wall-clock budget its profile grants. Such a claim gets no GitHub credential and
     * no member env beyond the profile's `connections`, never publishes, runs no gates and opens
     * no publish or question relay — the board decides all of that, never the caller.
     */
    reviewRun?: { profile: string; ref: string; timeoutMinutes: number };
    /**
     * Whether the driver may publish after this run's succeeded gated run. ABSENT on a
     * workflow-less claim — the driver reads its absence as "publish", the exact behavior before
     * workflows existed, which is what keeps the no-workflow claim byte-identical. On a workflow
     * row the board decides from the graph: true only for a publish node's run, so a mid-loop
     * review success never pushes (docs/workflows.md).
     */
    publish?: boolean;
    /**
     * False when the claimed workflow node launches no agent turn: the driver runs the node's
     * helpers, gates and publish and never starts a runner session. ABSENT means an agent node.
     */
    agent?: false;
    /**
     * Declared pre/post block-helper steps for this node's claim (issue #207/#122), resolved from
     * the snapshot node's own `helperPlans` — absent on every claim outside a block's expansion,
     * which is the ordinary case for every workflow-less and plain `agent`-node task today.
     */
    helperPlans?: ClaimHelperPlan[];
}

/**
 * Why a write was refused.
 *
 * - `lost`    the job is no longer running under this token — the lease expired and someone else
 *             has it, or the board gave up on it. The caller must stop working.
 * - `missing` no such job in this organization.
 */
export type LeaseResult = 'ok' | 'lost' | 'missing';

/**
 * What a suspend (park) did.
 *
 * - `ok`      the run left `running`, and `status` says where it landed: `stopped`, the
 *             user's stop landing (the stamp the heartbeat delivered).
 * - `lost`    the job is no longer running under this token — the lease expired and someone else
 *             has it, or the board gave up on it. The caller must stop working.
 * - `missing` no such job in this organization.
 * - `conflict` the attempt staged a conclusion under this token (issue #821): that is its outcome.
 */
export type SuspendResult = { result: 'ok'; status: JobStatus } | SettleRefusal;
export type SettleRefusal = { result: 'lost' } | { result: 'missing' } | { result: 'conflict' };

/**
 * Why a follow-up was refused.
 *
 * - `missing`      no such job in this organization.
 * - `not_finished` the parent, or any other member of its thread, is still queued or running —
 *                  the thread's turn is not over, as a retry's refusal says (#698).
 * - `task_done`    the user has declared the task done; the conversation is closed.
 * - `forbidden`    the parent was queued by a different account. The child would inherit the
 *                  parent's session, and a session resumes only in the checkout tree it ran in —
 *                  the author's; a member's command may only ever run in their own tree.
 */
export type FollowUpRefusal = 'missing' | 'not_finished' | 'task_done' | 'forbidden';

/**
 * Why a retry was refused (issue #326). The follow-up set — a session is never a precondition of
 * either.
 *
 * - `missing`      no such job in this organization.
 * - `not_finished` the task is still queued or running — its run is not over.
 * - `task_done`    the user has declared the task done; the conversation is closed.
 * - `forbidden`    the task was queued by a different account. A retry runs in the thread's
 *                  worktree, which lives in the author's checkout tree — the author-scoped rule
 *                  follow-up takes.
 */
export type RetryRefusal = 'missing' | 'not_finished' | 'task_done' | 'forbidden';

/**
 * What a stop request did.
 *
 * - `stopped`   the row was settled `stopped` in place — it was queued (never started), or it
 *               was running under a lease that has already expired (nobody holds it, so there
 *               is nobody left to deliver to — issue #152); the turn
 *               is over.
 * - `requested` the row is running under a live lease; the worker has been told and will settle
 *               it. The timestamp is the FIRST request, kept on later stops so the answer is
 *               idempotent.
 * - `missing`   no such job in this organization.
 * - `conflict`  the row already ended — there is no turn left to stop.
 */
export type StopResult =
    | { result: 'stopped' }
    | { result: 'requested'; cancelRequestedAt: string }
    | 'missing'
    | { result: 'conflict'; status: JobStatus };

/**
 * What a queued-command edit (issue #329) did.
 *
 * - `ok`         the command was replaced. The new command rides the answer so the route can
 *                echo it without a second read.
 * - `missing`    no such job in this organization.
 * - `not_queued` the row has been claimed — or already ended — and the command is the run's
 *                input now. The status the store answered with rides along so the route can
 *                name it.
 * - `workflow`   the row's command was built by interpolating a workflow node's prompt — the
 *                raw chat line was never stored, so there is nothing to edit from.
 * - `forbidden`  the task was queued by a different account (author-scoped like the follow-up:
 *                the command runs in the author's checkout tree).
 */
export type EditCommandResult =
    | { result: 'ok'; command: string }
    | 'missing'
    | { result: 'not_queued'; status: JobStatus }
    | 'workflow'
    | 'forbidden';

/**
 * What a task removal did.
 *
 * - `ok`        the whole thread is gone and a worktree reclaim is queued. The root the driver
 *               must reclaim — the id, the repo label and the relative workspace path — rides the
 *               answer and the queue row, so the worker never has to touch the job table.
 * - `missing`   no such job in this organization.
 * - `conflict`  a member of the thread is still running. The user stops it first; the worktree a
 *               live runner is editing must not be torn out from under it.
 */
export type RemoveResult =
    | { result: 'ok'; rootJobId: string; repo: string | null; workspacePath: string | null }
    | 'missing'
    | 'conflict'
    /** The thread backs a batch task: removing it would rewrite the batch's history. */
    | 'batch';

/**
 * What a user wait-cancel (issue #328) did.
 *
 * - `ok`        the thread's open wait was cancelled — reason `cancelled by user`, the acting
 *               caller stamped beside it; a parked round is permanently unwakeable and a woken
 *               continuation is settled by the claim's cancellation fence.
 * - `missing`   no such job in this organization.
 * - `no_wait`   the thread has no OPEN wait — it never parked, or the wait already ended. The
 *               route says 409: a cancel that changed nothing has no wait to name.
 * - `forbidden` the thread was queued by a different account (author-scoped like the follow-up:
 *               the woken continuation runs in the author's worktree).
 */
export type CancelWaitResult = { result: 'ok' } | 'missing' | 'no_wait' | 'forbidden';

/**
 * What a user poke (issue #328) did: the parked round's wake transaction, run now.
 *
 * - `ok`        the poke ran; `woken` says whether a round was actually woken — false is an
 *               honest answer for nothing parked, a round already woken, or an active member,
 *               and inserts nothing (a replay costs nothing and wakes nothing).
 * - `missing`   no such job in this organization.
 * - `no_wait`   the thread has no OPEN wait — nothing to evaluate, the route says 409.
 * - `forbidden` the thread was queued by a different account.
 */
export type PokeWaitResult = { result: 'ok'; woken: boolean } | 'missing' | 'no_wait' | 'forbidden';

/**
 * What a reopen did.
 *
 * - `ok`          the thread's done stamp is cleared and any queued worktree reclaim withdrawn —
 *                 the task can be followed up again.
 * - `missing`     no such job in this organization.
 * - `not_done`    no member of the thread carries the done stamp — nothing to reopen. Reopen is
 *                 deliberately NOT idempotent: the second call answers this, the state the first
 *                 left behind.
 * - `reclaimed`   the worktree was already removed (the reclaim row acked) — a follow-up would have
 *                 nothing to resume in.
 * - `reclaiming`  a driver holds a LIVE claim on the reclaim — the tree is being removed right
 *                 now. Retry once the claim settles: an ack stamps the marker (`reclaimed`), an
 *                 expired lease reverts the row to withdrawable (`ok`).
 */
export type ReopenResult = { result: 'ok' } | 'missing' | 'not_done' | 'reclaimed' | 'reclaiming' | 'batch';

/** A worktree reclaim a driver just leased. Acking by id removes the row. `leaseExpiresAt` is the
 * expiry the claim granted, read back from the row it was persisted on — the holder keeps the row
 * to it whatever later pollers ask for. */
export interface ReclaimClaim {
    id: string;
    /** This acquisition's own ownership token (075): the ack and the renew are fenced by it. */
    token: string;
    rootJobId: string;
    repo: string | null;
    workspacePath: string | null;
    leaseExpiresAt: string;
}

/** A reclaim renew's answer: extended, held by another acquisition, or gone (acked or never queued). */
export type ReclaimRenewal = { result: 'ok'; leaseExpiresAt: string } | { result: 'lost' } | { result: 'missing' };

/** `JobStore.artifactScope`: where a job's artifacts are filed and how far its claim sequence has advanced. */
export interface JobArtifactScope {
    /** The author, or null for an unattributed job. */
    member: string | null;
    root: string;
    /** The row's newest claim sequence; a claim above it has not happened. */
    claimSeq: number;
}

/** Every board and worker operation: one interface per concern, each beside the file that implements it. */
export type JobStore = JobActionStore &
    JobAdmissionStore &
    JobClaimStore &
    JobConclusionStore &
    JobMergeStore &
    JobQuestionStore &
    JobReadStore &
    JobReclaimStore &
    JobReviewStore &
    JobWorkerStore &
    PhaseCheckpointStore &
    GateRunStore &
    PrOperationStore &
    TranscriptToolStore;

/** The page states the task list serves. `attention` is the inbox view: running and review. */
export type TaskState = 'attention' | 'running' | 'review' | 'past';

/**
 * One task: a thread root with the conversation's present tense. Every field is bounded — the
 * command, one activity line, one close-time summary — and nothing here is a run detail: no
 * output tail, no gate state, no runtime object, no session ids. The run's own page is
 * `GET /api/jobs/:id`; this row is what a list of many tasks renders.
 */
export interface TaskSummary {
    /** The root job id — the route target, the same id `GET /api/jobs/:id` answers for. */
    id: string;
    /** The newest run's id — the run `status` and `activity` describe; every other run of the thread is history. */
    headRunId: string;
    /** The root command; the UI derives the first-line title from it. */
    command: string;
    /** The newest run's status — the thread's present tense, the sidenav's chainHead rule. */
    status: JobStatus;
    /** The head run's stop-request stamp, when a stop has landed but not yet parked. */
    cancelRequestedAt: string | null;
    /** The head run's done stamp — null until the user declares the task done. */
    doneAt: string | null;
    /** The grouping labels the task was queued with, inherited by every follow-up. */
    repo: string | null;
    executor: string | null;
    /** The scope `executor` names (issue 391), inherited with it; null rows read as 'user'. */
    executorScope: ExecutorScope;
    /** The ROOT's creator, resolved at read time — the person the conversation belongs to. */
    author: UserRef | null;
    /** The head run's live activity line, as last sampled — not gated on still running here. */
    activity: string | null;
    /** The head run's close-time summary — what the newest run did, in the agent's last words. */
    summary: string | null;
    /**
     * The thread's PR wait, when it has one (036): the block's reason ("review", ...), when the
     * wait started, and — when the wait is terminal — why it ended. The open wait is preferred
     * over a terminal one, so a thread waiting for review reads waiting; a finished wait reads
     * what exhausted it. All null for a thread that never entered a wait.
     */
    waitReason: string | null;
    waitingSince: string | null;
    waitTerminalReason: string | null;
    /** True when any run of the thread has an `answerable` question (050): a member is wanted. */
    needsAnswer: boolean;
    /** The root's creation: when the conversation started. */
    createdAt: string;
    /** The head run's newest of created/started/finished/done — the task's sort key. */
    activityAt: string;
}

/** The org-wide figures a task poll renders beside the list, immune to the page's filters. */
export interface TaskNavigation {
    counts: { running: number; review: number; past: number };
    /** At most three running tasks, newest first — the live work. */
    running: TaskSummary[];
    /** At most five finished-but-undeclared tasks, newest first — the reader's queue. */
    review: TaskSummary[];
}

/** Everything `GET /api/tasks` accepts; `q`, `repo`, `author` arrive normalized from the route. */
export interface TaskListFilters {
    state: TaskState;
    q?: string | undefined;
    repo?: string | undefined;
    /** Compared case-insensitively against the root author's login. */
    author?: string | undefined;
    sort: 'newest' | 'oldest';
    limit: number;
    /** A cursor this list issued; validated against every other filter before use. */
    cursor?: string | undefined;
}

export interface TaskListResponse {
    navigation: TaskNavigation;
    page: { items: TaskSummary[]; nextCursor: string | null };
}

/**
 * The organization is bound at construction: it is a constant for the life of the process, and a
 * per-call parameter is one more thing a write path can forget.
 */
export interface CreateJobStoreDeps {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
    /**
     * The env-var store's resolver, when the deployment stores runner environment. Present in
     * main.ts, absent in the tests that predate it — a claim then simply carries no `env`. The
     * second parameter is the executor the resolver MUST run on: the claim's own transaction, so
     * a claim holds one connection rather than two (a resolver on the pool would let enough
     * concurrent claims wedge the pool against itself).
     */
    env?: {
        resolveFor(
            target: { userId: string | null; repo: string | null },
            exec: Sql | TransactionSql
        ): Promise<Record<string, string>>;
    };
    /**
     * Whether the org holds a GitHub App installation — the `github` skill connection, which the
     * runner spends through the board's credential endpoint (docs/connections.md). Absent offline
     * and in the tests that predate it: a skill needing GitHub is then refused at claim.
     */
    githubApp?: boolean;
    /**
     * The execution-plan reader, when the deployment has a GitHub App installation to read through.
     * Declared inline like `env`, because `db/` imports nothing from `workspace/` at runtime — a
     * claim hands it the repo label and the thread's base branch and gets the plan at that
     * branch's tip, or the reason it cannot be honoured. A GitHub outage rejects, so the claim is
     * retried. Present in main.ts, absent in the tests that predate it — a claim then carries none.
     */
    plan?: {
        readFor(
            repo: string,
            baseBranch: string | null
        ): Promise<{
            config: BellowsConfig | null;
            services: readonly ServiceSpec[];
            revision: string | null;
            error: string | null;
            policy?: EvidencePolicy;
            reviewers?: readonly ReviewerSpec[];
        }>;
    };
    /**
     * The member executor store's claim-time reader. Declared inline like `env`, because `db/`
     * must not import from `db/user-executor-store.ts`'s surface — the claim needs exactly one
     * question answered: the row the task's executor LABEL names in the STAMPED scope (issue 391;
     * absent scope reads as 'user'). Its type selects the task's runner and its config travels
     * under that runner's config env name. A reader failure throws, and the same rollback that
     * guards the env resolver leaves the job queued with its attempt unburned.
     */
    executorConfig?: {
        configFor(
            userId: string,
            name: string,
            scope: ExecutorScope,
            exec: Sql | TransactionSql
        ): Promise<{ type: string; config: Record<string, unknown>; suspended: boolean } | null>;
    };
    /**
     * The PR lifecycle store, when the deployment records publications and PR waits (036).
     * Declared inline like `env`, because only the completion surface (the publication upsert),
     * the stop/remove sweep (wait cancellation) and the read model (the thread's wait) touch it —
     * the rest of the job store has no opinion of it. Present in main.ts under `withStores`,
     * absent in the tests that predate it: a verdict then simply records no publication.
     */
    prs?: JobStorePrs;
    /** The shared admission budgets every claim enforces (issue #831); absent is unlimited. */
    admission?: AdmissionBudgets;
    /** What the claim reports about itself (issue #831); absent in the tests that predate it. */
    metrics?: ClaimObserver;
}

/** The PR lifecycle store's claim-time surface — named once so a helper can take it explicitly. */
export interface JobStorePrs {
    recordPublication(
        input: {
            root: string;
            repo: string;
            prNumber: number;
            prUrl: string;
            headBranch: string;
            baseBranch: string;
        },
        exec?: Sql | TransactionSql
    ): Promise<void>;
    /**
     * The thread's recorded publication, when it has one (036) — the structured PR identity a
     * block-helper claim injects generically (see `resolveClaimHelperPlans`), issue #122's
     * merge-conflict-autofix block being the first consumer. Null on a thread that never
     * published.
     */
    publicationOf(root: string, exec?: Sql | TransactionSql): Promise<PublicationState | null>;
    /**
     * Ends a durable wait as completed (issue #133's `runtime-settle.ts`, the counterpart to
     * `enterWait` below): idempotent, like every other terminal wait call — an already-terminal or
     * missing wait is left alone.
     */
    finishWait(root: string, reason: string, terminalReason?: string, exec?: Sql | TransactionSql): Promise<boolean>;
    cancelWaitsForRoot(
        root: string,
        terminalReason?: string,
        exec?: Sql | TransactionSql,
        cancelledBy?: string | null
    ): Promise<number>;
    /**
     * Cancels every open wait addressed to one repository's PR (036) — the webhook's close sweep,
     * and issue #390's merge closure (reason `pr merged`) rides the same call inside the closure
     * transaction. Returns the count.
     */
    cancelForRepoPr(
        repo: string,
        prNumber: number,
        terminalReason?: string,
        exec?: Sql | TransactionSql
    ): Promise<number>;
    /**
     * Enters (or re-enters) a durable wait for a workflow-block runtime boundary (issue #231) —
     * the transition's park, in the same transaction as the verdict that triggered it.
     */
    enterWait(
        input: { root: string; reason: string; repo: string; prNumber: number },
        exec?: Sql | TransactionSql
    ): Promise<WaitState>;
    /**
     * Atomically claims a wait's folded deliveries for the wake sweep (issue #231): the pending
     * count returns and resets to zero in the same lock, coalescing whatever folded since the last
     * claim.
     */
    claimReview(
        root: string,
        reason: string,
        exec?: Sql | TransactionSql
    ): Promise<{ pending: number; lastDeliveryId: string | null }>;
}

/**
 * What every `JobStore` method function closes over: the connection, the bound org, the
 * precompiled SQL fragments, and the optional collaborators. `createJobStore` builds one and each
 * method is a thin delegation to its function in the sibling `job-store-*.ts` files.
 */
/** `admission` is the deps' budgets, defaulted to none (unlimited). */
export interface JobStoreContext extends Required<Pick<CreateJobStoreDeps, 'admission'>> {
    sql: Sql;
    orgId: string;
    env: CreateJobStoreDeps['env'];
    githubApp: boolean;
    planReader: CreateJobStoreDeps['plan'];
    executorConfig: CreateJobStoreDeps['executorConfig'];
    prs: JobStorePrs | undefined;
    metrics: ClaimObserver | undefined;
    wallTick: Fragment;
    authorJoin: Fragment;
    authorColumns: Fragment;
    taskPreviewColumns: Fragment;
    /** The thread's wait (036), joined by the detail reads (`get`, `thread`) — one definition. */
    waitLateral: Fragment;
    /** The thread's publication join (`job_pr`, 036, #324), the same two reads only. */
    publicationJoin: Fragment;
    /** The publication columns that ride beside it, comma-leading like `authorColumns`. */
    publicationColumns: Fragment;
}
