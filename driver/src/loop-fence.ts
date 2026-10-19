/**
 * The attempt's two fences, and the only two places either is acted on: the kubernetes checkout
 * claim the attempt holds, and the stand-down that ends it. Every setup step and every phase
 * answers with data (`SetupHalt`, `STOOD_DOWN`) instead of settling, releasing or reporting for
 * itself, so no path can forget half of its own settlement (issue #472, steps 3 and 4 of #433).
 */

import { down } from './loop-attempt.js';
import { withBoardRetry } from './board-retry.js';
import type { BoardJob, LeaseState } from './board.js';
import type { RunOutcome } from './runner.js';
import { withConflictContext, type SyncResult } from './publish.js';
import type { AttemptCtx, LoopRuntime, SetupHalt, VerdictBody } from './loop-types.js';
import { type StartupCause, StartupRefused, transientStartup } from './startup-cause.js';

const MS_PER_SECOND = 1_000;

/**
 * The ONE decision on a group start the platform refused for a proven cause (issue #824 D11) — on
 * the sync, the run and a container that never started alike: a transient cause is an interruption
 * the board refunds within its budget, a permanent one a configuration fault a person fixes.
 */
export function startupHaltOf(refused: StartupRefused): SetupHalt {
    return startupHalt(refused.startupCause, refused.message);
}

function startupHalt(cause: StartupCause, detail: string): SetupHalt {
    if (transientStartup(cause)) return { halt: 'interrupt', reason: `the runner could not start: ${detail}` };
    return {
        halt: 'fault',
        log: `the runner could not start (${cause}): ${detail}`,
        verdict: {
            status: 'failed',
            exitCode: null,
            output: `The runner could not start: ${detail}`,
            failureKind: 'config',
        },
    };
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
export async function concludeThrownRun(ctx: AttemptCtx, e: unknown): Promise<void> {
    if (e instanceof StartupRefused) return concludeSetup(ctx, startupHaltOf(e));
    await leaveToLease(ctx, `could not run: ${(e as Error).message}`, null);
}

/**
 * Why the loop reports no verdict for this outcome, or null when it reports: a container that never
 * started. Handed back as an interruption (`interruptAttempt`), like a runner the platform took away.
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
 * The ONE stand-down fence. Called the moment a phase answers, it gives the claim back, settles the
 * attempt and parks a stopped one exactly once, and answers whether the attempt stood down here —
 * so nothing below it settles, releases or parks for itself. `phase` names where it landed.
 * `beforePark` runs once for a stopped attempt, after the settle and before the park: the work
 * that must land while the lease still lets it (a stop after the run still reports the session
 * and uploads the artifacts, issues #152 and #325 — the park lands the row terminal, and a call
 * refused after it is lost).
 */
export async function standDown(ctx: AttemptCtx, phase: string, beforePark?: () => Promise<void>): Promise<boolean> {
    if (!down(ctx.state)) return false;
    // Once per attempt (issue #820): a stand-down that threw lands in runJob's catch, which asks
    // again — and a second park would only repeat the call that just failed. Marked after the
    // settle, so a release or settle that threw is finished by that second ask.
    if (ctx.stoodDown) return true;
    await handBackFence(ctx);
    await ctx.settle();
    ctx.stoodDown = true;
    const { rt, job, state } = ctx;
    if (state.lost) {
        rt.log(`job ${job.id}: the lease was lost during ${phase}, leaving the job to its holder`);
    } else if (state.removed) {
        rt.log(`job ${job.id}: removed during ${phase}; the queue owns the tree`);
    } else {
        await beforePark?.().catch((e: Error) =>
            rt.log(`job ${job.id}: the work before the park failed, parking anyway: ${e.message}`)
        );
        await park(ctx, phase);
    }
    return true;
}

/**
 * Parks a stopped attempt, retried like a verdict. A board that never takes it leaves the attempt to
 * the lease: the claim settles a requested stop whose lease expired (`job-store-claim.ts`) and offers
 * anything else again, so the row is recoverable and nothing here may throw — the process carries
 * every other claim (issue #820).
 */
async function park(ctx: AttemptCtx, phase: string): Promise<void> {
    const { rt, job } = ctx;
    const verdict = await withBoardRetry(rt, `job ${job.id}: the stop was not accepted`, () =>
        rt.board.suspend(job)
    ).catch((e: Error) => {
        rt.log(`job ${job.id}: the board did not take the stop, left to the lease: ${e.message}`);
        return null;
    });
    if (verdict === null) return;
    rt.log(
        verdict === 'lost'
            ? `job ${job.id}: stopped during ${phase}, but the board had already reclaimed it`
            : `job ${job.id}: stopped during ${phase} — nothing more ran, the board has settled the turn`
    );
}

/**
 * The ONE verdict conclusion (issue #821): the final envelope is staged under the lease, then
 * completed, and only then does the attempt give the checkout claim back and tear its group down —
 * the heartbeat renewing the lease throughout (`JobState.concluding`), so the evidence the group
 * holds outlives every moment the verdict could still be lost. A stage the board answers as lost,
 * removed or another's settles at once with no verdict. A board that takes neither the stage nor the
 * verdict leaves the group and the claim standing (`keepGroup`) for the next claim to adopt. Each
 * board call is retried for the lease, like a verdict. Answers what the complete answered, or null.
 */
export async function concludeAttempt(ctx: AttemptCtx, verdict: VerdictBody): Promise<LeaseState | null> {
    const { rt, job, state } = ctx;
    state.concluding = true;
    const staged = await withBoardRetry(
        rt,
        `job ${job.id}: the staged verdict was not accepted`,
        () => rt.board.stageConclusion(job, verdict),
        { budgetMs: rt.config.leaseSeconds * MS_PER_SECOND }
    ).catch((e: Error) => {
        rt.log(`job ${job.id}: the ${verdict.status} verdict could not be staged: ${e.message}`);
        return null;
    });
    if (staged !== null && staged !== 'held') return unstaged(ctx, staged);
    let tornDown: () => void = () => {};
    const after = new Promise<void>((resolve) => {
        tornDown = resolve;
    });
    try {
        const answer = await rt.report(job, verdict, { after }).catch((e: Error) => {
            rt.log(
                `job ${job.id}: the ${verdict.status} verdict was not delivered, left to the lease unrewritten: ${e.message}`
            );
            return null;
        });
        await ctx.quiesce();
        if (staged === 'held' || answer !== null) {
            await handBackFence(ctx);
        } else {
            state.keepGroup = true;
            rt.log(
                `job ${job.id}: neither the stage nor the verdict was accepted; the group and checkout claim are left for the next claim to adopt`
            );
        }
        await ctx.settle();
        return answer;
    } finally {
        tornDown();
    }
}

/** A stage the board refused: the lease, the thread or the conclusion is no longer this verdict's. */
async function unstaged(ctx: AttemptCtx, answer: 'lost' | 'conflict' | 'removed'): Promise<LeaseState | null> {
    const { rt, job } = ctx;
    await handBackFence(ctx);
    await ctx.settle();
    if (answer === 'lost') return 'lost';
    rt.log(
        answer === 'removed'
            ? `job ${job.id}: removed before its verdict was staged; the queue owns the tree`
            : `job ${job.id}: the board holds a different conclusion this attempt staged, and it stands`
    );
    return null;
}

/**
 * The ONE setup conclusion. A left, requeued or interrupted attempt gives the claim back, settles
 * and says why — in that order, because a replacement claimant may start the moment the job is
 * handed back (issue #469). A fault or a conclusion says why and lands its verdict through
 * `concludeAttempt`, which gives the claim back once the verdict is in (issue #821).
 */
export async function concludeSetup(ctx: AttemptCtx, halt: SetupHalt): Promise<void> {
    if (halt.halt === 'interrupt') return interruptAttempt(ctx, halt.reason, null);
    const { rt, job } = ctx;
    if (halt.halt === 'fault' || halt.halt === 'concluded') {
        rt.log(`job ${job.id}: ${halt.log}`);
        await concludeAttempt(ctx, halt.verdict);
        return;
    }
    await handBackFence(ctx);
    await ctx.settle();
    rt.log(`job ${job.id}: ${halt.log}`);
    if (halt.halt === 'leave') return;
    // A refused requeue (a lost lease, a stop that won the race) leaves the board's answer
    // standing; retried like a verdict, and one that still fails leaves the job to its lease,
    // exactly like `leave`.
    await withBoardRetry(rt, `job ${job.id}: the requeue was not accepted`, () => rt.board.requeue(job)).catch(
        (e: Error) => rt.log(`job ${job.id}: could not requeue: ${e.message}`)
    );
}

/**
 * Leaves an attempt to the lease, saying why in the log: a run that threw, whose runner may still
 * be running for the next claim to adopt, and the fallback of `interruptAttempt` for an interrupt
 * that never landed or a spent interruption budget. The board recovers an expired lease as an
 * interruption while it can, and retires the job `dead` with no output once it cannot, so that
 * LAST attempt (`lastAttempt` on the claim) reports a failed verdict carrying `reason` instead: the
 * reason is what `job investigate`, the web and a batch report show.
 */
export async function leaveToLease(ctx: AttemptCtx, reason: string, exitCode: number | null): Promise<void> {
    await concludeSetup(ctx, leaveConclusion(ctx.job, reason, exitCode));
}

/**
 * The longest reason the board records for an interruption: its `INTERRUPTION_REASON_MAX`
 * (server/src/routes/job-handlers-worker.ts), copied per this package's zero-dependency rule. A
 * longer one is refused, and would leave the attempt to the lease for its length alone.
 */
const INTERRUPTION_REASON_MAX = 500;

/**
 * Hands an attempt that ended without a verdict back to the board as an interruption (issues #792,
 * #822): refunded and claimable at once, its reason recorded inside the interruption budget, no
 * verdict. The infrastructure took its runner away, or this driver refused it while alive with no
 * runner left behind — its container never started, its services could not start — and either way
 * the reason belongs on the row, never in a lease period the next claim records as a silent driver.
 * A run that threw is not handed back: its runner may have survived (`leaveToLease`).
 * Only an interrupt that does not land (the board unreachable, a refused token) or a spent budget
 * leaves it to the lease (`leaveToLease`), where the last attempt reports it; a lost lease is the
 * new holder's.
 */
export async function interruptAttempt(ctx: AttemptCtx, reason: string, exitCode: number | null): Promise<void> {
    const { rt, job } = ctx;
    await handBackFence(ctx);
    await ctx.settle();
    const recorded =
        reason.length > INTERRUPTION_REASON_MAX ? `${reason.slice(0, INTERRUPTION_REASON_MAX - 1)}…` : reason;
    const answer = await withBoardRetry(rt, `job ${job.id}: the interruption was not accepted`, () =>
        rt.board.interrupt(job, { reason: recorded, release: true })
    ).catch((e: Error) => {
        rt.log(`job ${job.id}: could not report the interruption: ${e.message}`);
        return null;
    });
    if (answer === 'held') {
        rt.log(`job ${job.id}: ${reason}, handed back as an interruption`);
        return;
    }
    if (answer === 'lost') {
        rt.log(`job ${job.id}: ${reason}, and the lease was already lost`);
        return;
    }
    const why = answer === 'exhausted' ? `${reason}, and the interruption budget is spent` : reason;
    await leaveToLease(ctx, why, exitCode);
}

/**
 * Lands a run that has no verdict to report, answering whether it did: a runner the platform took
 * away, or one that never started, is an interruption (`interruptAttempt`) — unless the platform's
 * words prove a permanent cause for the refused start, which is a configuration fault (`startupHalt`).
 * That refusal is decided first: it ran no agent, so no supervisor loss beside it outranks it.
 */
export async function concludeUnreported(ctx: AttemptCtx, outcome: RunOutcome): Promise<boolean> {
    const why = neverStartedWhy(outcome);
    if (why !== null && outcome.startupCause && !transientStartup(outcome.startupCause)) {
        await concludeSetup(ctx, startupHalt(outcome.startupCause, outcome.output.trim()));
        return true;
    }
    if (outcome.infraLoss) {
        await interruptAttempt(ctx, `infrastructure loss: ${outcome.infraLoss}`, outcome.exitCode);
        return true;
    }
    if (why === null) return false;
    await interruptAttempt(ctx, why, outcome.exitCode);
    return true;
}

/**
 * `leaveToLease`'s conclusion, as data: left to the lease, or reported failed on the last attempt —
 * never an `interrupt`, so `concludeSetup` cannot hand it back to `interruptAttempt` again.
 */
function leaveConclusion(
    job: BoardJob,
    reason: string,
    exitCode: number | null
): Extract<SetupHalt, { halt: 'leave' | 'fault' }> {
    if (!job.lastAttempt) return { halt: 'leave', log: `${reason}, leaving it to the lease` };
    return {
        halt: 'fault',
        log: `${reason}, and no attempts are left: reporting it`,
        verdict: {
            status: 'failed',
            exitCode,
            output: `[driver] ${reason} (attempt ${job.attempts} of ${job.maxAttempts})`,
            failureKind: 'runner_error',
        },
    };
}
