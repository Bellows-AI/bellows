/**
 * The `Runner` contract the loop drives and both executors implement — docker in
 * `docker-runner.ts`, kubernetes in `k8s-runner.ts` — plus the executor-neutral output and vitals
 * helpers each one reports through. Nothing here knows which platform is underneath; a name that
 * only one executor needs belongs in that executor's files.
 */

import { createHash } from 'node:crypto';
import type { BoardJob, ReviewClaim, ServiceStatus } from './board.js';
import type { HelperCall, HelperPlan, HelperResult } from './helpers.js';
import type { PublishOptions, PublishResult, SyncResult, ReclaimResult } from './publish.js';
import type { SnapshotResult } from './review-snapshot.js';
import type { StartupCause } from './startup-cause.js';
import type { GateStepRequest, ReviewControl } from './supervised-steps.js';
import type { StepResult } from './supervisor-contract.js';
import type { KillRecord } from './termination.js';

/** What the board is told afterwards. `timedOut` is reported as a failure, with a reason. */
export interface RunOutcome {
    exitCode: number | null;
    output: string;
    timedOut: boolean;
    /**
     * False only when the runner knows the container never ran — the daemon refused to accept
     * it. The docker runner does not guess from the shared stderr stream, where the CLI's errors
     * and the command's own output are indistinguishable: on an exit 125 it asks the daemon
     * whether the container exists, and a container that exists ran, whatever it printed. A
     * kubernetes runner always reports started, because a resolved outcome there means the pod
     * was created, ran and exited. The shared loop interprets no exit codes: a run that started
     * and exited 125 is a verdict, reported like any other.
     */
    started: boolean;
    /**
     * True when the runner refused the job before the agent ran — a `.bellows.yaml` the parser
     * rejects. The verdict is final (`started: true`), but no work happened, so the loop runs no
     * gates against it: a gate over an untouched checkout reports noise (a `vitest: not found`
     * exit 127) under the refusal that actually explains the failure.
     */
    refused?: boolean;
    /**
     * Set when the platform took the runner away before it exited — its pod deleted, evicted or
     * its node removed, its container removed (issue #560) — and says how. No verdict of the
     * agent's exists, so the loop reports none: it leaves the job to the lease, which re-offers it.
     */
    infraLoss?: string;
    /** For a container that never started: the cause the platform's refusal proves (`startupCauseOf`), if any. */
    startupCause?: StartupCause;
    /**
     * The session the run actually used, when the runner could only know it after the fact —
     * opencode mints its own (`ses_…`) and the runner scrapes it out of the session database the
     * run left behind. Null for claude-code, whose session is minted up front and reported
     * before the container starts, and for every run whose scrape found nothing.
     */
    sessionId?: string | null;
    /**
     * The finish reason opencode recorded for the run's LAST root assistant message — `stop` for
     * a run that ended itself, `length` for one that hit the model's context limit mid-task.
     * Undefined when no scrape happened (claude-code, or an opencode run whose scrape never
     * ran); null when the scrape ran but read nothing. A zero exit code with a finish reason
     * that is not `stop` is a run that STOPPED TALKING, not one that finished — the loop
     * reports it failed rather than letting the exit code call a truncated run a success.
     */
    finishReason?: string | null;
    /**
     * The context the run reached, read from the same session database as `finishReason`: the
     * last root assistant message's token total — the model's window fill at the run's end — and
     * the sum of the per-message costs. Undefined when no scrape happened; null when the scrape
     * read nothing. Reported with the verdict and stored beside the attempt's vitals, where a
     * run that died at a full window tells its own story.
     */
    contextTokens?: number | null;
    costUsd?: number | null;
    /**
     * Why the post-run session scrape failed, when it failed: the readout's own error line, the
     * docker rejection, or null when it answered nothing at all. The loop logs it beside the
     * empty-scrape notice, because a lost session presents later as "this task cannot take a
     * follow-up" and the reason is the only way to tell a broken query from an empty database.
     * Undefined for claude-code, which never scrapes.
     */
    readoutError?: string | null;
    /**
     * The last provider error the scraped session recorded — the rejection the provider returned
     * as the run's dying word (an HTTP 429 rate limit, observed 2026-09-11, cutting a run off
     * mid-tool-call with exit 0). Lifted from the session database beside the finish reason; set
     * only when the scrape found the session, and absent for claude-code, which never scrapes.
     * The loop names it in the premature-stop note, because a finish reason of `tool-calls` says
     * the run stopped talking without saying what stopped it.
     */
    providerError?: string | null;
    /**
     * Why the cache watch killed the run, when it did — the observed turns, so the verdict the
     * author reads names what the provider stopped doing instead of just "failed". Undefined
     * when the watch is off or never fired; never set by claude-code, and the watch itself is
     * docker-only (config refuses it under EXECUTOR=kubernetes).
     */
    cacheLost?: string | null;
    /**
     * Set when the attempt was failed because the transcript exporter's spool hit its cap
     * (`artifact_spool_full`): the unacknowledged bytes it held. Undefined on every other run.
     */
    artifactSpoolFull?: string | null;
    /**
     * The run's agent turns — one assistant response cycle in the run's ROOT conversation,
     * counted from the session's own records at close (opencode: the session database the
     * readout walks; claude-code: the transcript on the task volume). Null when the read
     * ran and could not measure — the transcript was gone, or the container died first; absent
     * when no read was attempted. The board stores what arrives: absent
     * and null both land as null — unmeasured, never zero.
     */
    agentTurns?: number | null;
    /**
     * What the run did, in the agent's own last words — the run's final assistant text, read
     * from the same records as `agentTurns` (opencode: the session database's part rows;
     * claude-code: the transcript's text blocks), collapsed to one line by the script. Null
     * when the read ran and found none — a run cut off mid-tool-call has no final text; absent
     * when no read was attempted. Reported with the verdict and stored on the job row, where
     * the recently-completed view shows what a task did without opening its output.
     */
    summary?: string | null;
    /**
     * The agent's blocked report, read with `summary` but BEFORE its collapse: the text after
     * `FACTORY_BLOCKED:` when the final message's last line starts with it. Absent otherwise.
     */
    blockedLine?: string;
    /**
     * The run's full output, tail-kept at ARTIFACT_LIMIT bytes (issue #325) — the artifact the
     * loop uploads to the board at close, where the rolling tail the verdict carries is only the
     * end of the run. Absent when the runner captured none (a refused start, a kubernetes pod
     * whose log was already gone) — no artifact is uploaded, never an empty one.
     */
    fullLog?: string;
    /** True when the full-log accumulator cut bytes off the head to hold the cap. */
    logTruncated?: boolean;
    /**
     * The opencode session transcript of THIS run (the per-run delta, the same bound the turn
     * count keeps), exported from its database at close — the reshaped message view — tail-kept
     * at ARTIFACT_LIMIT bytes. Absent when no read ran or answered: no artifact, never an empty
     * one. Claude's transcript never rides here: its exporter streams it whole while the run lives.
     */
    transcript?: string;
    /** True when the transcript export dropped its head to hold the cap. */
    transcriptTruncated?: boolean;
    /**
     * opencode only: every row of the task's session, message and part tables, one JSON line per
     * row, read in the same consistent snapshot as `transcript` — the lossless source of truth the
     * normalized `transcript` is derived from. Absent when the readout exported none.
     */
    rawTranscript?: string;
    /** True when the raw export dropped its head to hold the cap. */
    rawTranscriptTruncated?: boolean;
}

/**
 * The session a run is to use. `resume` restores an existing one rather than starting it, which is
 * how a follow-up continues its parent's conversation — under the same id.
 *
 * Null for a runner that takes no session at all: opencode mints its own ids and cannot adopt one
 * (`run --session <id>` continues an existing session, it never creates one with a given id), so
 * there is nothing honest to pass it.
 */
export interface RunSession {
    id: string;
    resume: boolean;
}

/** One declared service found dead: its status, how it ended, and what it last printed. */
export interface DeadService extends ServiceStatus {
    exitCode: number | null;
    /** The platform's word for the ending — the kubelet's `reason`, docker's `OOMKilled` or error. */
    reason: string | null;
    logTail: string;
    /** Why the pre-gate restart (`Runner.restartServices`) could not bring the fleet back; absent when none ran. */
    restartFailure?: string;
}

/** How many of a dead service's last log lines the verdict quotes. */
export const SERVICE_LOG_TAIL_LINES = 20;

/**
 * How long a restarted fleet has to reach running (issue #560), in seconds: long enough for a
 * cluster autoscaler to bring a node up under the replacement pods.
 */
export const SERVICE_RESTART_TIMEOUT_S = 300;
const MS_PER_SECOND = 1000;
export const SERVICE_RESTART_TIMEOUT_MS = SERVICE_RESTART_TIMEOUT_S * MS_PER_SECOND;

/** How often a restarting fleet is re-listed while it comes up. */
export const SERVICE_READY_POLL_MS = 2000;

/** The states a platform reports for a declared service that is gone: docker's, then the pod phases. */
export const DEAD_SERVICE_STATES: ReadonlySet<string> = new Set(['exited', 'dead', 'failed', 'succeeded']);

/** What an entrypoint prints when it cannot drop to its own user under the runners' capability drop. */
const CAPABILITY_DROP_SIGNATURE = /failed switching to|(?:chown|gosu|su-exec)\b[^\n]*operation not permitted/i;

/**
 * The fix for a service that died on the capability-drop signature (issue #487), or null. Services
 * start with every capability dropped, so a stock image that chowns its data dir or switches user
 * as root cannot boot.
 */
export function serviceHint(logTail: string): string | null {
    if (!CAPABILITY_DROP_SIGNATURE.test(logTail)) return null;
    return (
        'the service starts with every capability dropped, so its entrypoint cannot chown or switch user — ' +
        'declare `user: "uid:gid"` (a non-root user the image runs as) on it in .bellows.yaml'
    );
}

/** How many hex digits of the command's sha256 `commandMark` keeps: a label-sized value. */
const COMMAND_MARK_HEX = 16;

/** The command a runner ran, as its adoption mark (`COMMAND_MARK`, issue #792). */
export const commandMark = (command: string): string =>
    createHash('sha256').update(command).digest('hex').slice(0, COMMAND_MARK_HEX);

/**
 * A finished runner of an earlier claim of the same job, read by the claim that superseded it
 * (issue #792): its driver died, the runner did not. `outcome` is what `run` would have answered
 * it; `claimSeq` the earlier claim it ran under.
 */
export interface AdoptedRun {
    outcome: RunOutcome;
    claimSeq: number;
}

/**
 * Thrown by `Runner.adopt` once a finished run was read but something of an earlier attempt could
 * not be confirmed gone (issue #821), or an earlier runner could not be read far enough to tell
 * whether it is a run to adopt (#824): the attempt is left to its lease, never run afresh over the
 * tree that run left — the next claim adopts it again.
 */
export class AdoptionBlocked extends Error {}

/**
 * A read that proves nothing — a transport failure past its retries, an answer that is neither the
 * thing nor its confirmed absence, a body that is not the shape asked for (#824). Never read as
 * empty or gone: whoever decides a delete or a negative verdict on it stands down instead.
 */
export class Inconclusive extends Error {}

/**
 * A typed read's answer (#869): the value, the object's confirmed absence, or a read that proves
 * nothing — never an empty value invented from an answer that was not one. Whoever decides a delete
 * or a negative verdict on it branches on all three.
 */
export type Read<T> = { kind: 'value'; value: T } | { kind: 'absent' } | { kind: 'inconclusive'; reason: string };

/** Thrown by `Runner.adopt` once the attempt stood down mid-adoption: nothing more of it is its to delete. */
export const adoptionAbandoned = (): Error => new Error('the adoption was abandoned: the attempt stood down');

export interface Runner {
    /**
     * Runs the job. `onOutput` is the live-output hook: the runner calls it with its newest output
     * tail whenever fresh output arrives, and the loop decides what reaches the board and how
     * often. Optional — a caller that does not stream simply never gets a call.
     */
    run(job: BoardJob, session: RunSession | null, onOutput?: (tail: string) => void): Promise<RunOutcome>;
    /**
     * The runner container's vitals right now — the liveness signal the dashboard renders — or
     * null when none can be taken. Sampling failures are the ordinary case (the container can be
     * gone between the ask and the read), so null is "no fresh sample", never an error.
     */
    sampleRuntime(job: BoardJob): Promise<Omit<RuntimeSample, 'sampledAt'> | null>;
    /**
     * The attempt's declared services that are no longer running — exited, whatever the code —
     * each with its exit, the platform's reason and its last log lines. The loop asks right
     * before the declared gates: a gate against a dead service fails on an environment the
     * agent cannot fix (issue #423). Empty when services are off or every one is alive; a read
     * that fails throws, and the loop runs the gates as if it had answered empty.
     */
    deadServices(job: BoardJob): Promise<DeadService[]>;
    /**
     * Starts the attempt's `.bellows.yaml` services. The loop's setup phase calls it for every
     * attempt, agent-less ones included, before the gate environment's `environment.setup` (which
     * may migrate or seed one) and before run(), which starts none. Answers a refused outcome for
     * an author's refusal (a bad `.bellows.yaml`), null once every service runs; throws
     * `ServicesNotRunning` for one that never does, and any other error for an infrastructure
     * refusal, its partial fleet torn down. `signal` (the stand-down) ends the readiness wait.
     * Torn down by `releaseServices`.
     */
    startServices(job: BoardJob, signal?: AbortSignal): Promise<RunOutcome | null>;
    /**
     * Recreates the attempt's declared fleet from the recorded specs and waits until every
     * service runs, up to SERVICE_RESTART_TIMEOUT_MS (issue #560). The loop calls it when a
     * service is found dead before the declared gates: services are stateless fixtures, so a
     * fleet the platform took away is put back rather than failing finished work. Throws when the
     * fleet cannot be brought back; the message is the verdict's. `signal` is the attempt's
     * stand-down: once it fires, nothing more is created or polled.
     */
    restartServices(job: BoardJob, signal: AbortSignal): Promise<void>;
    /** Stops a container mid-run. Used when the lease is lost, and on shutdown. */
    kill(job: BoardJob): Promise<void>;
    /**
     * Ends the agent under its task supervisor: the loop has already raised the kill order on the
     * attempt's control channel (`killAgent`), so the supervisor ends the agent, has the exporter
     * drain what it wrote and finalizes, and the run's group then ends by itself — `run` resolves
     * with the real outcome. This waits, bounded, for that and past the bound falls back to
     * `kill`, the hard kill. Never throws.
     */
    stopAgent(job: BoardJob): Promise<void>;
    /**
     * Records on the attempt why the driver is ending its run (`termination.ts`), where the claim
     * adopting the run after this driver's loss reads it back (`adopt`). Rejects when the platform
     * refuses; the caller never holds the kill back for it.
     */
    recordKill(job: BoardJob, kill: KillRecord): Promise<void>;
    /** Stops/resumes the runtime budget while questions are pending. */
    pauseDeadline(job: BoardJob, paused: boolean): Promise<void>;
    /**
     * Tears down the attempt's `.bellows.yaml` services. run() starts the fleet and deliberately
     * leaves it up: the declared gates run after it and are what test against those services, so
     * the loop calls this once the gates are done — and on every other way the attempt ends,
     * run() thrown included. Attempt-scoped and idempotent, like every teardown here.
     */
    releaseServices(job: BoardJob): Promise<void>;
    /**
     * Publishes the work the run produced: task branch (when the checkout sits on the default
     * one), commit, push, and a PR. The deterministic end of a task — a succeeded verdict may not
     * describe work that exists only in a local checkout. The loop decides WHEN this is called (a
     * succeeded run, gates passed, and nothing else); a publish that cannot happen answers the
     * refusal in the result. `githubToken` is the board's token minted for this push
     * (docs/connections.md); both transports lay it into the publish steps' env the same way
     * (`supervisedStepRunner`), so neither can drift. `draft` opens a NEW pull request as a draft
     * (the agent's mid-run publish); an existing PR is reused whatever its state.
     */
    publishGit(job: BoardJob, githubToken?: string, options?: PublishOptions): Promise<PublishResult>;
    /**
     * The task tree's fingerprint now (`probeTreeFingerprint`): the probe step over the same
     * transport `publishGit` uses, read only after a declared gate failed. Null is unknown.
     * `signal` is the attempt's stand-down: an aborted probe tears its container or aux Job down.
     */
    probeTree(job: BoardJob, signal?: AbortSignal): Promise<string | null>;
    /**
     * Reads and takes down a FINISHED runner an earlier claim of this job left behind (issue
     * #792), before this attempt's sync touches the tree that run left: its verdict, log and
     * session are this attempt's outcome instead of a second run. Null when there is none — no
     * earlier runner, one still running, or one the platform took away. The earlier attempt's
     * objects are swept only once read. Under kubernetes it takes the checkout claim, which the
     * attempt holds from here as the sync would have taken it. `signal` is the attempt's stand-down:
     * an adoption still waiting on a finalizing supervisor (#824) is abandoned and deletes nothing.
     */
    adopt(job: BoardJob, signal?: AbortSignal): Promise<AdoptedRun | null>;
    /**
     * Freezes the task tree's current state under a snapshot ref of the shared clone, for a named
     * reviewer to start from (issue #549) — over the same transport `probeTree` uses, so both
     * executors do it identically. Writes only a ref, never overwrites one (a repeated request
     * finds the first snapshot), and moves nothing the agent has.
     */
    snapshotTree(job: BoardJob, key: string, signal?: AbortSignal): Promise<SnapshotResult>;
    /**
     * Prepares the job's task worktree before the run. A STARTING claim syncs it with the
     * remote default: fetch, create the worktree branched off `origin/<default>` (first attempt
     * of the thread) or rebase it onto the new default, keeping its commits. A claim that
     * CONTINUES a session (a follow-up) RESTORES instead: no fetch, no
     * rebase — the tree is kept exactly as the run before it left it, or recreated from the
     * surviving thread branch (issue #58: git operations that touch the remote belong to the
     * task's beginning and end, never its middle). Called before the runner spawns, so a task
     * starts from the code it is meant to continue. Answers { ok: false, reason } rather than
     * throwing; the loop turns that into the verdict. An aborted `signal` (the attempt's stand-down) detaches the docker client only: a
     * sync writes the worktree, so it is never killed mid-write, and kubernetes does not take the signal
     * at all — the abandoned sync finishes and `releaseAbandonedSync` hands its claim back.
     * `githubToken` is the board's token minted for the starting claim's fetch; absent, the fetch
     * runs unauthenticated.
     */
    syncCheckout(
        job: BoardJob,
        signal?: AbortSignal,
        session?: RunSession | null,
        githubToken?: string
    ): Promise<SyncResult>;
    /**
     * Ends the attempt's task group (issue #771): the supervisor that ran the sync, serves the
     * probe, the helpers and the publish, and held the agent. The group exists from the attempt's
     * first step, not from the agent's start, and `run` leaves it alive — so the loop finishes it,
     * on every way the attempt ends, while the run-control channel its order travels is still open.
     * Idempotent, never throws, and a no-op for an attempt with no group.
     */
    finish(job: BoardJob): Promise<void>;
    /**
     * Reclaims the task worktree after the thread's LAST job is terminal: removes the per-thread
     * tree and prunes its admin entry, so a finished or deleted task does not leave its tree
     * squatting on the member volume forever (issue #47). Best-effort by contract: the loop calls
     * it after a verdict precisely because the verdict is already safe on the board — a reclaim
     * that refuses (a path that is not the sync's own worktree, a daemon that says no) must never
     * turn a done task back into a failed one, and the loop logs and moves on. Refusal keeps the
     * tree by design: the script it runs deletes only what the sync itself created, and the
     * surviving factory/<root> branch lets a later follow-up recreate the tree with a fresh sync.
     */
    reclaimWorktree(job: BoardJob): Promise<ReclaimResult>;
    /**
     * Hands back whatever the startup sync's fence took — the kubernetes checkout claim, which
     * syncCheckout acquires and HOLDS through the run. The loop calls this (`handBackFence`) on
     * every exit that never reaches runner.run — a terminal refusal, a stand-down, a throw — where
     * no run hands it on; an attempt that never runs must not hold the checkout. Ownership-checked
     * inside the runner: only the exact claim this attempt still holds is released, never one that
     * moved on, and never while the attempt's group lives or its end is unconfirmed — the group's
     * end (`finish`) gives it back then. Optional: docker's fence leaves nothing
     * behind to release, so its runner implements nothing and a loop facing it never calls.
     */
    releaseFence?(job: BoardJob): Promise<void>;
    /**
     * Runs one declared block-helper step (issue #207): an allowlisted, board-owned script an
     * expanded workflow `block` node names to run before or after its agent turn. `call.token` is a
     * fresh GitHub installation token, minted by the loop immediately before a github-writing
     * helper (`plan.githubWriting`); a read-only helper gets none and the transport runs it with
     * the claim env untouched. A job with no `helperPlans` never calls it. An aborted `call.signal` (the
     * attempt's stand-down) ends a kubernetes helper's poll and reaps its Job; on docker it
     * detaches the client and the container is removed by name, a github-writing one included.
     * `call.effectId` names the call's logical effect across claims (`helperEffectId`, issue #826). A
     * lost supervisor rejects (`stepLost`) rather than answering a helper failure.
     */
    runHelper(job: BoardJob, plan: HelperPlan, call?: HelperCall): Promise<HelperResult>;
    /**
     * Runs one declared gate (or the setup) in the attempt's task group (issue #773): a supervised
     * step the supervisor hands the group's gate container — the declared image, over the task
     * worktree. A group is made on demand for an attempt whose sync made none (an adopted run, an
     * agent-less node), as for every other step. An abort of `signal` cancels it through the step
     * channel. A lost supervisor rejects (`stepLost`): no verdict on the gate, the attempt's loss.
     */
    runGate(job: BoardJob, gate: GateStepRequest, signal?: AbortSignal): Promise<StepResult>;
    /**
     * Asks the platform to resize the gate container's requests in place (issue #773): low (`idle`)
     * while the agent runs, the configured gate requests (`verify`) for the setup and the declared
     * gates. Best-effort: false when the request was not made or refused — never awaited for the
     * kubelet to apply it, never a verdict. Docker has nothing to resize and answers false.
     */
    resizeGate(job: BoardJob, phase: GateSizing): Promise<boolean>;
    /**
     * The same for the reviewer container (issue #774): low (`idle`) between reviews, the runner's
     * own requests (`run`) while one runs. Best-effort, as `resizeGate`; docker answers false.
     */
    resizeReviewer(job: BoardJob, phase: ReviewerSizing): Promise<boolean>;
    /**
     * Runs one named reviewer's review in the CALLER's task group (issue #774): the reviewer's home,
     * its worktree restored at the snapshot ref, and the executor run in the group's reviewer
     * container, as supervised steps over the caller's control channel. `session` resumes the
     * review's own session (a re-leased review). The answer is the review step's result; a setup
     * that failed answers a failed result, a lost supervisor rejects (`stepLost`) — no verdict —
     * and an abort of `control.signal` cancels the review through the step channel. With `control.exporter` the review's
     * transcript is exported as one more step once it has ended (amendment B5), under the review row.
     */
    runReview(
        caller: BoardJob,
        review: ReviewClaim,
        session: RunSession | null,
        control?: ReviewControl
    ): Promise<StepResult>;
}

/** The two sizes a gate container is resized between: low while the agent runs, the gate requests for verify. */
export type GateSizing = 'idle' | 'verify';

/** The two sizes a reviewer container is resized between: low between reviews, the runner's requests for one. */
export type ReviewerSizing = 'idle' | 'run';

/**
 * The most of a runner's output this process will hold in memory — the board truncates too; this
 * is about not holding an unbounded string in the first place. Exported because the kubernetes
 * runner's transport uses it as its sliding-window bound.
 */
export const BYTES_PER_KIB = 1024;
const OUTPUT_LIMIT_KIB = 64;
export const OUTPUT_LIMIT = OUTPUT_LIMIT_KIB * BYTES_PER_KIB;

/**
 * The full-run log and transcript artifact cap (issue #325): how much of a run's output the
 * driver keeps for the board's artifact upload, tail-kept — a run that fails says why at the
 * end, and the head is banner. The server's route re-bounds the stored content to the same
 * figure; the value is copied there, per this package's zero-dependency rule.
 */
const ARTIFACT_LIMIT_KIB = 512;
export const ARTIFACT_LIMIT = ARTIFACT_LIMIT_KIB * BYTES_PER_KIB;

/**
 * Each of the opencode readout's two export streams (raw rows, normalized events) is tail-kept at
 * this many bytes, so both plus the summary line stay under the 1 MiB a docker exec buffers.
 */
export const OPENCODE_EXPORT_LIMIT = ARTIFACT_LIMIT / 2;

/**
 * The tail of a runner's output that is safe to put on a complete POST. The board refuses a body
 * over its 128 KiB limit, and JSON escaping can inflate text up to six bytes per byte of log — a
 * control character becomes `\u0001` — so the bound is 16 KiB of UTF-8: 96 KiB fully escaped, plus
 * the rest of the report, still fits. Capping by CHARACTERS instead — 64 KiB of them, the naive
 * reading of OUTPUT_LIMIT — could triple that with CJK text and sextuple it with control
 * characters, and the refused report would leave the job to its lease and re-run finished work:
 * the one outcome worse than a short log.
 */
const REPORT_LIMIT_KIB = 16;
const REPORT_BYTE_LIMIT = REPORT_LIMIT_KIB * BYTES_PER_KIB;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8');

/** A UTF-8 continuation byte is `10xxxxxx`: it never starts a character. */
const UTF8_LEAD_MASK = 0xc0;
const UTF8_CONTINUATION = 0x80;

/**
 * The last `limit` bytes of `bytes`, decoded from the first character boundary inside them: a
 * multibyte character the limit cuts is dropped whole, never decoded to a U+FFFD that re-encodes
 * past the limit (issue #825).
 */
function decodeTail(bytes: Uint8Array, limit: number): string {
    let start = bytes.length - limit;
    while (start < bytes.length && ((bytes[start] ?? 0) & UTF8_LEAD_MASK) === UTF8_CONTINUATION) start += 1;
    return DECODER.decode(bytes.subarray(start));
}

/**
 * The last `limit` UTF-8 bytes of `text`, as a string, cut at a character boundary — which is why
 * the bound is stated in bytes and not approximated by a character count.
 */
export function tailBytes(text: string, limit: number): string {
    const bytes = ENCODER.encode(text);
    if (bytes.length <= limit) return text;
    return decodeTail(bytes, limit);
}

/** The tail of a runner's log that fits a complete POST, whatever the log contained. */
export function reportTail(logText: string): string {
    return tailBytes(logText, REPORT_BYTE_LIMIT);
}

/**
 * Tail-keeps `text` to `limit` UTF-8 bytes, answering whether a cut happened — the accumulator
 * and artifact reads' shape (issue #325), where the truncated flag must be earned by an actual
 * cut, never guessed. The same byte-true rule as `tailBytes`, plus the flag.
 */
export function tailKept(text: string, limit: number): { content: string; truncated: boolean } {
    const bytes = ENCODER.encode(text);
    if (bytes.length <= limit) return { content: text, truncated: false };
    return { content: decodeTail(bytes, limit), truncated: true };
}

/** A streamed log tail-kept at ARTIFACT_LIMIT bytes as it grows; `truncated` once a cut was earned. */
export interface KeptLog {
    content: string;
    truncated: boolean;
}

/** `kept` grown by `text`, cut back to ARTIFACT_LIMIT bytes — the full-log accumulator's step. */
export function appendTailKept(kept: KeptLog, text: string): KeptLog {
    const grown = tailKept(kept.content + text, ARTIFACT_LIMIT);
    return { content: grown.content, truncated: kept.truncated || grown.truncated };
}

/**
 * The runner container's vitals at one sample: the "is it actually doing anything" answer the
 * dashboard renders beside the output tail. Taken with `docker stats --no-stream` — the same
 * daemon access every other per-attempt operation here uses.
 */
export interface RuntimeSample {
    /** Whole-container CPU, percent of one host core; can exceed 100 on multi-core hosts. */
    cpuPercent: number | null;
    /** Resident memory, in MiB. */
    memUsedMb: number | null;
    /** Resident memory against the container's limit, percent; null when the daemon reports none. */
    memPercent: number | null;
    /**
     * The attempt's declared services and their current states — present only when the attempt
     * declared any and their states could be read.
     */
    services?: ServiceStatus[];
    /** The transcript exporter's backlog, when the run has one: set by the loop, never by a runner. */
    transcriptExport?: { pendingBytes: number; oldestUnackedMs: number };
    /** When the sample was taken, stamped by the sampler. A reader sees staleness from this. */
    sampledAt: string;
}

/** How many characters of one output line the activity report may carry. */
const ACTIVITY_LIMIT = 200;

/** Strips ANSI/OSC escapes — the stream is a CLI's, and the board renders it as text. */
export function stripAnsi(text: string): string {
    // CSI sequences, OSC sequences (BEL- or ST-terminated), and any other lone escape.
    return text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g, '');
}

/**
 * The agent's current activity, read off the newest output tail: its last non-empty line, escapes
 * stripped and capped. That line is the tool call most of the time (`→ Read src/x.ts`,
 * `$ npm test`), which is exactly the "is it working, and on what" answer wanted here. A heuristic
 * by design — the stream is the CLI's to format, and parsing deeper would couple this process to
 * one renderer's redraws.
 */
export function currentActivity(tail: string | null): string | null {
    if (tail === null) return null;
    const lines = stripAnsi(tail).split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!.trim();
        if (line) return line.slice(0, ACTIVITY_LIMIT);
    }
    return null;
}

/**
 * Joins the two reads a vitals sample is made of — the runner's CPU/memory and the attempt's
 * service fleet — under the rule that a failed read costs its half, never the sample. An empty
 * or failed fleet is NO KEY at all, so a job whose attempt declared no services puts exactly the
 * pre-services wire shape out; unreadable vitals are null numbers beside real service states,
 * because the fleet must not depend on the metrics API (a kind cluster runs none). Both halves
 * gone → null, "no fresh sample", exactly the answer a failed read has always answered.
 */
export function composeRuntimeSample(
    vitals: Pick<RuntimeSample, 'cpuPercent' | 'memUsedMb' | 'memPercent'> | null,
    services: ServiceStatus[] | null | undefined
): Omit<RuntimeSample, 'sampledAt'> | null {
    const fleet = services && services.length > 0 ? services : undefined;
    if (!vitals && !fleet) return null;
    return {
        cpuPercent: vitals?.cpuPercent ?? null,
        memUsedMb: vitals?.memUsedMb ?? null,
        memPercent: vitals?.memPercent ?? null,
        ...(fleet ? { services: fleet } : {}),
    };
}
