/**
 * The attempt's fences and the decisions that end it. The kubernetes checkout claim the attempt
 * holds is handed back here and nowhere else; every ending is DATA (`EndDecision`) built here and
 * landed by `end` (`loop-conclusion.ts`), so no path can forget half of its own settlement (issue
 * #472, steps 3 and 4 of #433, #828).
 */

import { down } from './loop-attempt.js';
import { lostOf } from './loop-phase.js';
import type { BoardJob } from './board.js';
import type { RunOutcome } from './runner.js';
import { SYNC_FAILURE_KINDS, TRANSIENT_SYNC_REASON, withConflictContext, type SyncResult } from './publish.js';
import type { AttemptCtx, EndDecision, LoopRuntime, SetupHalt, VerdictBody } from './loop-types.js';
import { type StartupCause, StartupRefused, transientStartup } from './startup-cause.js';

/**
 * The ONE decision on a group start the platform refused for a proven cause (issue #824 D11) — on
 * the sync, the run and a container that never started alike: a transient cause is an interruption
 * the board refunds within its budget, a permanent one a configuration fault a person fixes.
 */
export function startupHaltOf(refused: StartupRefused): SetupHalt {
    return startupHalt(refused.startupCause, refused.message);
}

/** A failed setup step's halt: the attempt ends `failed` with `output`, `log` saying why in the driver's log. */
export function faultHalt(
    log: string,
    output: string,
    failureKind: NonNullable<VerdictBody['failureKind']>,
    exitCode: number | null = null
): Extract<SetupHalt, { halt: 'fault' }> {
    return { halt: 'fault', log, verdict: { status: 'failed', exitCode, output, failureKind } };
}

function startupHalt(cause: StartupCause, detail: string): SetupHalt {
    if (transientStartup(cause)) return { halt: 'interrupt', reason: `the runner could not start: ${detail}` };
    return faultHalt(
        `the runner could not start (${cause}): ${detail}`,
        `The runner could not start: ${detail}`,
        'config'
    );
}

/**
 * A checkout sync that threw: it took its own claim down inside the runner, so nothing is held here.
 * A group the platform refused to start for a proven cause is decided; anything else is left.
 */
export function syncThrewHalt(e: unknown): SetupHalt {
    if (e instanceof StartupRefused) return startupHaltOf(e);
    return { halt: 'leave', log: `checkout sync threw, leaving it to the lease: ${(e as Error).message}` };
}

/**
 * A run that threw, past its stand-down: a group the platform refused to start for a proven cause ran
 * nothing and is decided; any other throw is left to the lease — its runner may survive for the next
 * claim to adopt, and no runner ever launched would release the claim otherwise (issue #469).
 */
export function thrownRunDecision(job: BoardJob, e: unknown): EndDecision {
    if (e instanceof StartupRefused) return setupDecision(startupHaltOf(e));
    return leaveDecision(job, `could not run: ${(e as Error).message}`, null);
}

/**
 * Why the loop reports no verdict for this outcome, or null when it reports: a container that never
 * started. Handed back as an interruption (`interruptDecision`), like a runner the platform took away.
 */
export function neverStartedWhy(outcome: RunOutcome): string | null {
    if (outcome.started) return null;
    const said = outcome.output.trim();
    return `the runner reports the container never started${said ? `: ${said}` : ''}`;
}

/**
 * Hands the kubernetes checkout claim back — the ONE release in the loop. Only a successful sync
 * ever takes it (`ctx.fenced`) and the runner owns it from its launch onwards, so a refusal that
 * came before the sync releases nothing (the sync released its own) and nothing after the spawn
 * does either (the runner's group end, `finish`, owns that).
 */
export async function handBackFence(ctx: AttemptCtx): Promise<void> {
    if (!ctx.fenced) return;
    ctx.fenced = false;
    await ctx.rt.runner.releaseFence?.(ctx.job);
}

/**
 * A conflict the sync left in the tree reaches the agent through this attempt's turn context, which
 * the runner reads from the job at launch (master-prompt.ts); a sync with none changes nothing.
 */
export function handOverConflict(job: BoardJob, synced: SyncResult): void {
    if (synced.conflicts?.length) job.turnContext = withConflictContext(job.turnContext, synced.conflicts);
}

/**
 * The claim an ABANDONED sync still holds. The attempt walked away before the sync answered, so
 * `ctx.fenced` was never set and the stand-down fence has nothing to give back — yet an ok sync
 * takes the claim with no run coming to release it, and the next attempt's sync waits on it. So the
 * abandoned sync hands its own claim back the moment it lands, here where the release lives.
 */
export function releaseAbandonedSync(rt: LoopRuntime, job: BoardJob, syncing: Promise<SyncResult>): void {
    void syncing
        .then((result) => {
            if (result.ok) return rt.runner.releaseFence?.(job);
        })
        .catch(() => {});
}

/** `releaseAbandonedSync`'s twin for an abandoned adoption (issue #792): one that lands adopted holds the claim. */
export function releaseAbandonedAdoption(rt: LoopRuntime, job: BoardJob, adopting: Promise<unknown>): void {
    void adopting
        .then((run) => {
            if (run) return rt.runner.releaseFence?.(job);
        })
        .catch(() => {});
}

/**
 * The ONE stand-down read: what a Stop, a lost lease, a Remove or a handover recorded on the attempt
 * (`state.ending`) decides, or null while the attempt is up. A stopped attempt parks; one the board
 * already moved on from (lost, removed, handed over) ends with nothing to tell it. `phase` names where
 * it landed. `beforePark` runs once for a stopped attempt, before the park: the work that must land
 * while the lease still lets it (a stop after the run still reports the session and uploads the
 * artifacts, issues #152 and #325 — the park lands the row terminal, and a call refused after it is
 * lost). Pure: `end` (`loop-conclusion.ts`) acts, once, however often this is asked.
 */
export function standDown(ctx: AttemptCtx, phase: string, beforePark?: () => Promise<void>): EndDecision | null {
    const { job, state } = ctx;
    if (!down(state)) return null;
    // A drain's handover is an interruption: released to the next claim, whose runner is never finished.
    if (state.ending?.kind === 'handover') {
        return { kind: 'interrupt', reason: state.handoverReason ?? 'the driver was drained', exitCode: null };
    }
    if (lostOf(state)) {
        return {
            kind: 'none',
            log: `job ${job.id}: the lease was lost during ${phase}, leaving the job to its holder`,
        };
    }
    if (state.ending?.kind === 'removed') {
        return { kind: 'none', log: `job ${job.id}: removed during ${phase}; the queue owns the tree` };
    }
    return beforePark ? { kind: 'park', phase, beforePark } : { kind: 'park', phase };
}

/**
 * A setup conclusion as the ending it decides: a fault or a conclusion lands its verdict, a requeue
 * hands the pre-run claim back, an interrupt hands the attempt back as an interruption, a leave
 * leaves it to the lease (issue #469).
 */
export function setupDecision(halt: SetupHalt): EndDecision {
    switch (halt.halt) {
        case 'interrupt':
            return { kind: 'interrupt', reason: halt.reason, exitCode: null };
        case 'fault':
        case 'concluded':
            return { kind: 'verdict', verdict: halt.verdict, log: halt.log };
        default:
            return { kind: halt.halt, log: halt.log };
    }
}

/**
 * Leaves an attempt to the lease, saying why in the log: a run that threw, whose runner may still
 * be running for the next claim to adopt, and the fallback of an interrupt that never landed or a
 * spent interruption budget. The board recovers an expired lease as an interruption while it can,
 * and retires the job `dead` with no output once it cannot, so that LAST attempt (`lastAttempt` on
 * the claim) reports a failed verdict carrying `reason` instead: the reason is what `job
 * investigate`, the web and a batch report show.
 */
export function leaveDecision(job: BoardJob, reason: string, exitCode: number | null): EndDecision {
    return setupDecision(leaveConclusion(job, reason, exitCode));
}

/**
 * Hands an attempt that ended without a verdict back to the board as an interruption (issues #792,
 * #822): refunded and claimable at once, its reason recorded inside the interruption budget, no
 * verdict. The infrastructure took its runner away, or this driver refused it while alive with no
 * runner left behind — its container never started, its services could not start — and either way
 * the reason belongs on the row, never in a lease period the next claim records as a silent driver.
 * A run that threw is not handed back: its runner may have survived (`thrownRunDecision`). Only an
 * interrupt that does not land or a spent budget leaves it to the lease (`end`).
 */
export const interruptDecision = (reason: string, exitCode: number | null): EndDecision => ({
    kind: 'interrupt',
    reason,
    exitCode,
});

/**
 * How a run that has no verdict to report ends, or null when it reports: a runner the platform took
 * away, or one that never started, is an interruption — unless the platform's words prove a
 * permanent cause for the refused start, which is a configuration fault (`startupHalt`). That refusal
 * is decided first: it ran no agent, so no supervisor loss beside it outranks it.
 */
export function unreportedDecision(outcome: RunOutcome): EndDecision | null {
    const why = neverStartedWhy(outcome);
    if (why !== null && outcome.startupCause && !transientStartup(outcome.startupCause)) {
        return setupDecision(startupHalt(outcome.startupCause, outcome.output.trim()));
    }
    if (outcome.infraLoss) return interruptDecision(`infrastructure loss: ${outcome.infraLoss}`, outcome.exitCode);
    return why === null ? null : interruptDecision(why, outcome.exitCode);
}

/**
 * `leaveDecision`'s conclusion, as data: left to the lease, or reported failed on the last attempt —
 * never an `interrupt`, so a leave cannot be handed back to the interruption it fell from.
 */
function leaveConclusion(
    job: BoardJob,
    reason: string,
    exitCode: number | null
): Extract<SetupHalt, { halt: 'leave' | 'fault' }> {
    if (!job.lastAttempt) return { halt: 'leave', log: `${reason}, leaving it to the lease` };
    return faultHalt(
        `${reason}, and no attempts are left: reporting it`,
        `[driver] ${reason} (attempt ${job.attempts} of ${job.maxAttempts})`,
        'runner_error',
        exitCode
    );
}

/** The halt a failed checkout sync ends the attempt with: lock contention requeues, anything else is a fault. */
export function syncFailureHalt(synced: SyncResult): SetupHalt {
    if (synced.reason !== null && TRANSIENT_SYNC_REASON.test(synced.reason)) {
        /*
         * Lock contention on the shared checkout (issues #307, #559) is infrastructure, not a verdict: this
         * driver's own syncs of the clone are queued above, so the lock the script waited out is another
         * driver's (or, on docker, a stood-down sibling's sync container still finishing), or the fetch kept
         * losing ref locks to a concurrent git. The claim goes straight back to the board, which refunds the
         * attempt and defers the next claim. The kubernetes checkout claim was already released inside
         * `syncCheckout` before it answered, the same discipline the sync-failure refusal below relies on.
         */
        return { halt: 'requeue', log: `checkout sync was lock-blocked, requeueing: ${synced.reason}` };
    }
    // A kind the script named is a refusal no retry fixes: a person acts on it, so it is config.
    const deterministic = synced.kind !== undefined && SYNC_FAILURE_KINDS.includes(synced.kind);
    return faultHalt(
        `checkout sync failed: ${synced.reason}`,
        `The checkout could not be synced with the remote before the run: ${synced.reason}`,
        deterministic ? 'config' : 'runner_error'
    );
}
