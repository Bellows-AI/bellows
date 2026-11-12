import type { AttachmentMeta, JobMode, TaskTitleOrigin } from '@factory-ai/core';
import { usePoll } from './usePoll.js';

/**
 * The client's copy of the job board's row. List responses omit `output` (it is unbounded), so it
 * is null until a `useJob` detail poll fills it in. Copied rather than imported: `core` does not
 * know the job board exists, and the pattern `useWorkspace.ts` established is to own the shape the
 * page renders.
 *
 * On the grouped terminal rows (`GET /api/jobs?status=terminal`, the recently-completed view) one
 * row IS one task (issue 124): identity fields are the thread root's (id, command, author,
 * createdAt), present-tense fields the chain head's (status, summary, runtime, sessionId,
 * startedAt), and the wall clock and completion stamp are the thread's sum and max. The per-run
 * lists (tasks pages, sidenav) carry plain per-run rows and group on the client.
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'stopped';

/**
 * The structured terminal reason of a failed run (issue 339), copied from the board's
 * `failure_kind` column: why it failed — the timeout kill, a prompt-cache loss, an agent
 * reporting itself blocked, a failed gate, an unlanded publish, a failed block-helper, a dead
 * declared service, or the runner erroring. Null on a success and on every row that predates the
 * column — "not a failure", never "unknown".
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
    | 'attachment_unavailable'
    | 'skill_unavailable'
    | 'runner_error';

/** Where one declared verification gate stands. The board stores current/last only — no history. */
export interface GateCheck {
    name: string;
    status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
    exitCode: number | null;
    output: string | null;
    /** When a `running` gate started (ISO), so the strip can count its seconds. */
    startedAt?: string;
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
    /** Why a dead service died: present only once the driver read its ending. */
    exitCode?: number | null;
    reason?: string | null;
    logTail?: string;
    hint?: string;
}

/**
 * The running attempt's last sampled vitals, from the driver: whether the container is doing work
 * and what the agent says it is doing. The board keeps current/last only — `sampledAt` is how a
 * reader tells a live sample from a stopped run's. Null CPU/memory numbers mean the sample could
 * not read them this round (a cluster with no metrics-server, for one) — honest nulls beside a
 * service fleet that was read, never fabricated zeros.
 */
export interface RuntimeVitals {
    cpuPercent: number | null;
    memUsedMb: number | null;
    memPercent: number | null;
    activity: string | null;
    sampledAt: string;
    /**
     * The context the run reached, scraped from the session database at close — present only on
     * closed runs whose runner reads it, and stored beside the samples rather than inside them
     * (a context-only object with no CPU sample is legal).
     */
    contextTokens?: number | null;
    costUsd?: number | null;
    /**
     * The attempt's declared `.bellows.yaml` services and their current states — present only
     * when the attempt declared any and the driver could read them. Cleared with the numbers on
     * the next claim.
     */
    services?: ServiceStatus[] | null;
}

/**
 * A person, resolved server-side from the board's audit rows at read time. `name` and `avatarUrl`
 * are labels the account may not have; the login is the display fallback. Null means no author is
 * known — a pre-accounts row — and renders as "unknown", never a synthetic name.
 */
export interface AuthorRef {
    id: string;
    login: string;
    name: string | null;
    avatarUrl: string | null;
}

/** One question of an AskUserQuestion call, as the agent asked it. */
export interface AskedQuestion {
    question: string;
    header: string;
    multiSelect: boolean;
    options: { label: string; description?: string }[];
}

/**
 * One AskUserQuestion call of one attempt, copied from the board. `closed` is a `pending` row whose
 * run no longer waits; `answerable` is exactly what the answer route accepts.
 */
export interface JobQuestion {
    /** The agent's `tool_use_id`. */
    id: string;
    attempt: number;
    questions: AskedQuestion[];
    status: 'pending' | 'answered' | 'expired' | 'closed';
    answerable: boolean;
    /** Question text → the answer; null until answered. */
    answers: Record<string, string> | null;
    answeredBy: AuthorRef | null;
    askedAt: string;
    answeredAt: string | null;
}

/** One attempt the infrastructure interrupted — copied from the server's `JobInterruption`. */
export interface JobInterruption {
    at: string;
    reason: string;
    claimSeq: number;
    nodeLoss?: true;
}

export interface Job {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    /** Who queued the task, resolved to their account labels; null for a pre-accounts row. */
    author: AuthorRef | null;
    /** Who asked to stop the task — stamped at request time; null when nobody has. */
    stoppedBy: AuthorRef | null;
    /** Who marked the task done; null when nobody has. */
    doneBy: AuthorRef | null;
    exitCode: number | null;
    output: string | null;
    /** Why a FAILED run failed, structured (issue 339); null is "not a failure". */
    failureKind: FailureKind | null;
    /**
     * What the run did, in the agent's own last words — lifted from the session records at
     * close and reported with the verdict. Null is unmeasured, never empty; the command above
     * records what was asked, this records what was done.
     */
    summary: string | null;
    /**
     * The checks this run has run or is running, from the job's `.bellows.yaml`. Absent on list
     * responses (the list select omits it, like `output`) and null on any run whose repository
     * declares none.
     */
    gates?: GateCheck[] | null;
    /** The attempt's last container vitals, or null until the driver's first sample lands. */
    runtime?: RuntimeVitals | null;
    /** The thread root's stored title, or null while the title derived from `command` stands. */
    title: string | null;
    /** Who set `title`: null exactly when `title` is. */
    titleOrigin: TaskTitleOrigin | null;
    /** The root's compare-and-set token a rename sends back. */
    titleRevision: number;
    /** The repository tab the task was queued from, or null for one queued before the chat. */
    repo: string | null;
    /** The member's executor name the task was stamped with, or null. Display metadata. */
    executor: string | null;
    /** The branch the task was started from, on detail reads; null or absent is the default branch. */
    baseBranch?: string | null;
    /**
     * The workflow node this run walks, when the task runs a workflow — the graph position, and
     * what the task view labels the turn with. Null on every other row.
     */
    workflowNode: string | null;
    /**
     * The workflow the task's thread was launched under — the name frozen on the thread at create
     * time, inherited by every turn. Null on workflow-less tasks. Distinct from `workflowNode`
     * (this row's graph position); a rename or delete of the source workflow never changes it.
     */
    workflowName: string | null;
    /** The task's stored execution mode (issue 543): objective, or a named workflow's graph. */
    mode: JobMode;
    /** The finished task this one asks for adjustments on, when it is a follow-up. */
    followUpTo: string | null;
    /**
     * The id of the thread's ROOT task — the job itself, or the conversation's first run. Served
     * on every row, so any turn resolves to its whole task without climbing parents.
     */
    rootJobId: string;
    /** When the user declared the task done, or null while they have not. */
    doneAt: string | null;
    /**
     * When a stop was requested on this run while it was running — the user's `/stop` landed on a
     * moving run and the driver has not parked it yet. Null on every other job.
     */
    cancelRequestedAt: string | null;
    /**
     * Where the author's checkouts are, relative to the workspace root — board-derived, the same
     * field the claim carries. Null when the job has no author or the board has no workspace root;
     * the task view's status sidebar shows it, or a dash.
     */
    workspacePath: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    /**
     * The wall clock THIS run's own attempts banked — the executed segments the board
     * accumulated at its settle points. Null where nothing was ever banked for the row (a run
     * that never executed); the thread's total is `taskWallClockMs` below. On the grouped
     * terminal rows this is the chain head run's own clock.
     */
    wallClockMs: number | null;
    /**
     * The assistant response cycles in this run's root conversation, as the executor counted them
     * at close. Null is unmeasured (still running, the read failed, or an older row) — never zero.
     */
    agentTurns: number | null;
    /**
     * How long this run's `environment.setup` ran before the agent started (issue 733) — part of
     * `wallClockMs`, shown apart from it. Null when no setup ran, or on the per-run lists.
     */
    setupMs: number | null;
    /**
     * The attempts the infrastructure interrupted, oldest first — refunded, never a failed try.
     * Empty on the per-run lists and on a run nothing interrupted.
     */
    interruptions: JobInterruption[];
    /**
     * The wall clock the task's whole thread has banked — every executed segment of every run,
     * accumulated by the board and served on the thread read and on the grouped terminal rows
     * of the recently-completed view. Null where nothing has accumulated; the head's clock
     * renders a dash there, never a zero.
     */
    taskWallClockMs: number | null;
    sessionId: string | null;
    /**
     * The thread's durable PR-review wait, when it has one: the block's reason ("review", ...),
     * when the wait began, and — once the wait is terminal — why it ended. The open wait wins
     * over a terminal one, so a thread waiting for review reads waiting and a finished wait reads
     * what exhausted it. All null for a thread that never entered a wait. Carried the same on
     * every member of the thread, never derived from output text or a workflow node name.
     */
    waitReason: string | null;
    waitingSince: string | null;
    waitTerminalReason: string | null;
    /** The run's agent questions, oldest first; empty on list responses and runs that asked none. */
    questions: JobQuestion[];
    /** The thread root's connection bindings, oldest first; empty on list responses. */
    connections: JobConnection[];
    /** The files this request carried; thread reads only, empty elsewhere. */
    attachments: AttachmentMeta[];
    /** The thread root's `binding_revision`: what `POST /api/jobs/:id/connections` must echo. */
    bindingRevision: number;
    /** The open requirements holding the thread; empty on list responses. */
    integrationRequirements: JobIntegrationRequirement[];
    /** The thread root's frozen execution user, who a requirement waits on; null on list responses. */
    executionUser: AuthorRef | null;
    /** The thread owner this row was queued on behalf of: set when an admin acted on another member's task, else null. */
    actingFor: AuthorRef | null;
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

/** One open connection requirement: the provider's name comes from the server, so no panel names a provider. */
export interface JobIntegrationRequirement {
    provider: string;
    label: string;
    reason: 'missing' | 'ambiguous' | 'reconnect';
    /** `create`: the task never started; `runtime`: it ran, asked and was handed back. */
    source: 'create' | 'runtime';
    /** The bound connection a `reconnect` is about; null otherwise. */
    connectionId: string | null;
    /** What the asking helper needs of the provider (for Jira the site); null when it named none. */
    target: string | null;
    createdAt: string;
}

/**
 * Pure, and exported, so the offline suite can pin what stops the polls without fake timers: a
 * finished job is never going to grow an output, and polling it forever is a request nobody needs.
 */
export function isTerminal(status: JobStatus): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'dead' || status === 'stopped';
}

/** What a queueing call answers: the created task's id to navigate to, or why nothing was created. */
export interface QueueResult {
    id: string | null;
    error: string | null;
}

/**
 * This module used to own the 50-run `/api/jobs?limit=50` poll the sidenav grouped browser-side
 * (`taskSections`) and every task action. The task-summary read model (`GET /api/tasks`, via
 * `useTasks.ts`) replaced both: one row per thread root, org-wide counts and previews, server-side
 * filters — the browser never regroups runs again, and there is exactly one task-overview poll.
 * What remains here is the row shape the detail view renders and the thread poll below: the
 * detail page is a DIFFERENT question (one conversation's whole chain) with its own cadence.
 */

const VISIBLE_THREAD_POLL_MS = 2_000;
const HIDDEN_THREAD_POLL_MS = 15_000;

const threadPollDelay = (hidden: boolean) => (hidden ? HIDDEN_THREAD_POLL_MS : VISIBLE_THREAD_POLL_MS);

/**
 * One task's whole conversation — the root job and every follow-up after it, oldest first — from
 * `GET /api/jobs/:id/thread`. ANY member's id resolves to the same chain, which is what lets the
 * detail page keep one URL per task while follow-ups keep arriving as new rows underneath.
 *
 * A failed tick says so and keeps going: the last good answer stays on screen, an error line is
 * raised beside it, and the poll re-arms at its normal pace so a transient 503 (a deploy, a node
 * swap) heals by itself — the next good tick clears the error. What it must never do is go quiet
 * or give up: a transcript that silently stops growing reads as a finished run.
 *
 * The poll stops when EVERY member is terminal: a finished thread can still grow, but only by the
 * member's own follow-up, and `refresh` re-arms for exactly that.
 */
export function useThread(id: string | null): { jobs: Job[] | null; error: string | null; refresh: () => void } {
    // Every id change is a different question: `usePoll` keys the answer to the URL, so the previous
    // task's rows never render under the new one while its first fetch is in flight.
    const polled = usePoll<{ jobs: Job[] }>(id === null ? null : `/api/jobs/${id}/thread`, {
        refetchOnVisible: true,
        next: (outcome, hidden) =>
            outcome.kind === 'ok' && outcome.value.jobs.every((task) => isTerminal(task.status))
                ? null
                : threadPollDelay(hidden),
    });
    return { jobs: polled.data?.jobs ?? null, error: polled.error, refresh: polled.refresh };
}
