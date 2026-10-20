/**
 * How one attempt ends (issues #821, #828): `end` is the ONE place an attempt is concluded and torn
 * down, whatever path decided it. Its order is the same for every decision — the durable board call
 * first, then the heartbeat is quiesced, then the destructive teardown with the run control still
 * open — so nothing is destroyed that the board was not told about first, and a driver lost between
 * the two leaves the next claim a runner to adopt rather than a task nobody can recover. The first
 * call decides; later calls await the same promise (issue #820).
 */

import { withBoardRetry } from './board-retry.js';
import type { BoardJob, LeaseState } from './board.js';
import type { JobState } from './loop-attempt.js';
import { closeRunControl, releaseGateSession } from './loop-gates.js';
import { handBackFence, leaveDecision, standDown } from './loop-fence.js';
import { transition } from './loop-phase.js';
import type { AttemptCtx, EndDecision, LoopRuntime, VerdictBody } from './loop-types.js';

const MS_PER_SECOND = 1_000;

/**
 * The longest reason the board records for an interruption: its `INTERRUPTION_REASON_MAX`
 * (server/src/routes/job-handlers-worker.ts), copied per this package's zero-dependency rule. A
 * longer one is refused, and would leave the attempt to the lease for its length alone.
 */
const INTERRUPTION_REASON_MAX = 500;

/** Ends the heartbeat and leaves the group standing: `end`'s middle step, once however often asked. */
export function attemptQuiesce(
    rt: LoopRuntime,
    job: BoardJob,
    state: JobState,
    beating: Promise<void>
): () => Promise<void> {
    let quiescing: Promise<void> | null = null;
    return () =>
        (quiescing ??= (async () => {
            transition(state, 'ended');
            // In flight for a drain's handover (`loop.ts`) until here.
            rt.live?.delete(job.id);
            if (state.graceTimer) clearTimeout(state.graceTimer);
            state.wake();
            await beating;
        })());
}

/**
 * Ends the attempt as `decision` says: the durable board call, the quiesce, the teardown. Answers
 * what a verdict's complete answered, or null. A board call that does not land leaves the runner
 * standing (`JobState.keepGroup`) for the next claim; one answered `lost` is final, never retried.
 */
export function end(ctx: AttemptCtx, decision: EndDecision): Promise<LeaseState | null> {
    ctx.ended ??= conclude(ctx, decision);
    return ctx.ended;
}

/** `end` when the attempt is down — the stand-down read acted on; answers whether it was. */
export async function endIfDown(ctx: AttemptCtx, phase: string, beforePark?: () => Promise<void>): Promise<boolean> {
    const decision = standDown(ctx, phase, beforePark);
    if (decision === null) return false;
    await end(ctx, decision);
    return true;
}

/**
 * The run's outcome, or null once a drain's handover abandoned it: the run is contained and its
 * outcome ignored, its runner being the next claim's.
 */
export function abandonOnHandover<T>(state: JobState, run: Promise<T>): Promise<T | null> {
    run.catch(() => undefined);
    return Promise.race([run, state.handedOver.then(() => null)]);
}

async function conclude(ctx: AttemptCtx, decision: EndDecision): Promise<LeaseState | null> {
    let tornDown: () => void = () => {};
    const after = new Promise<void>((resolve) => {
        tornDown = resolve;
    });
    try {
        return await land(ctx, decision, after);
    } finally {
        try {
            await ctx.quiesce();
            await teardown(ctx);
        } finally {
            tornDown();
        }
    }
}

/** The durable half: the board call the decision names, and what that call answered. */
async function land(ctx: AttemptCtx, decision: EndDecision, after: Promise<void>): Promise<LeaseState | null> {
    const { rt, job, state } = ctx;
    switch (decision.kind) {
        case 'verdict':
            if (decision.log) rt.log(`job ${job.id}: ${decision.log}`);
            return stageAndReport(ctx, decision.verdict, after);
        case 'park':
            await park(ctx, decision);
            return null;
        case 'interrupt':
            return interrupt(ctx, decision, after);
        case 'requeue':
            rt.log(`job ${job.id}: ${decision.log}`);
            await requeue(ctx);
            return null;
        case 'leave':
            rt.log(`job ${job.id}: ${decision.log}`);
            // Past its launch the runner is the next claim's to adopt, never to finish.
            if (state.launched) state.keepGroup = true;
            return null;
        case 'none':
            rt.log(decision.log);
            return null;
    }
}

/** The destructive half, once the board knows: the group, then the control channel it is served on, then the rest. */
async function teardown(ctx: AttemptCtx): Promise<void> {
    const { rt, job, state } = ctx;
    // The attempt's task group (issue #771) lives from its sync to here, not to the agent's exit: its
    // supervisor serves the probe, the helpers and the publish. It ends while the control channel its
    // order travels is still open — and never for an attempt handed over by a drain, nor one whose
    // outcome the board never took (`keepGroup`): either runner is left for the next claim to adopt.
    if (state.ending?.kind !== 'handover' && !state.keepGroup) await rt.runner.finish(job).catch(() => undefined);
    closeRunControl(rt, state);
    if (ctx.gateSession) releaseGateSession(rt, ctx.gateSession, job);
    // The services outlived run() for the declared gates' sake; they go now, on every exit path.
    if (ctx.servicesStarted || ctx.setupDone) {
        await rt.runner
            .releaseServices(job)
            .catch((e: Error) => rt.log(`job ${job.id}: could not tear down the services: ${e.message}`));
    }
    if (!state.keepGroup) await handBackFence(ctx);
}

/**
 * The verdict conclusion (issue #821): the final envelope is staged under the lease, then completed,
 * the heartbeat renewing the lease throughout (`phase` `concluding`), so the evidence the group holds
 * outlives every moment the verdict could still be lost. A stage the board answers as lost, removed
 * or another's settles at once with no verdict. A board that takes neither the stage nor the verdict
 * leaves the group and the claim standing (`keepGroup`) for the next claim to adopt. Each board call
 * is retried for the lease, like a verdict.
 */
async function stageAndReport(ctx: AttemptCtx, verdict: VerdictBody, after: Promise<void>): Promise<LeaseState | null> {
    const { rt, job, state } = ctx;
    transition(state, 'concluding');
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
    const answer = await rt.report(job, verdict, { after }).catch((e: Error) => {
        rt.log(
            `job ${job.id}: the ${verdict.status} verdict was not delivered, left to the lease unrewritten: ${e.message}`
        );
        return null;
    });
    state.keepGroup = staged !== 'held' && answer === null;
    if (state.keepGroup) {
        rt.log(
            `job ${job.id}: neither the stage nor the verdict was accepted; the group and checkout claim are left for the next claim to adopt`
        );
    }
    return answer;
}

/** A stage the board refused: the lease, the thread or the conclusion is no longer this verdict's. */
function unstaged(ctx: AttemptCtx, answer: 'lost' | 'conflict' | 'removed'): LeaseState | null {
    const { rt, job } = ctx;
    ctx.state.keepGroup = false;
    if (answer === 'lost') return 'lost';
    rt.log(
        answer === 'removed'
            ? `job ${job.id}: removed before its verdict was staged; the queue owns the tree`
            : `job ${job.id}: the board holds a different conclusion this attempt staged, and it stands`
    );
    return null;
}

/**
 * Parks a stopped attempt, retried like a verdict. A board that never takes it leaves the attempt to
 * the lease: the claim settles a requested stop whose lease expired (`job-store-claim.ts`) and offers
 * anything else again, so the row is recoverable and nothing here may throw — the process carries
 * every other claim (issue #820). The runner stays then, as the board was not told. An answer of
 * `lost` is final.
 */
async function park(ctx: AttemptCtx, decision: Extract<EndDecision, { kind: 'park' }>): Promise<void> {
    const { rt, job, state } = ctx;
    await decision
        .beforePark?.()
        .catch((e: Error) => rt.log(`job ${job.id}: the work before the park failed, parking anyway: ${e.message}`));
    // Every park waits out the output pump: a write the park overtook would be refused, its tail lost.
    await state.drainOutput();
    const verdict = await withBoardRetry(rt, `job ${job.id}: the stop was not accepted`, () =>
        rt.board.suspend(job)
    ).catch((e: Error) => {
        rt.log(`job ${job.id}: the board did not take the stop, left to the lease: ${e.message}`);
        return null;
    });
    if (verdict === null) {
        state.keepGroup = true;
        return;
    }
    rt.log(
        verdict === 'lost'
            ? `job ${job.id}: stopped during ${decision.phase}, but the board had already reclaimed it`
            : `job ${job.id}: stopped during ${decision.phase} — nothing more ran, the board has settled the turn`
    );
}

/**
 * Hands the attempt back as an interruption. One that does not land (the board unreachable, a refused
 * token) keeps the runner; that and a spent budget leave it to the lease, where the last attempt
 * reports it; a lost lease is the new holder's.
 */
async function interrupt(
    ctx: AttemptCtx,
    decision: Extract<EndDecision, { kind: 'interrupt' }>,
    after: Promise<void>
): Promise<LeaseState | null> {
    const { rt, job, state } = ctx;
    const { reason, exitCode } = decision;
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
        return null;
    }
    if (answer === 'lost') {
        rt.log(`job ${job.id}: ${reason}, and the lease was already lost`);
        return null;
    }
    if (state.ending?.kind === 'handover') {
        // A drain's handover that was not taken is left to the lease, whatever the budget says.
        rt.log(`job ${job.id}: not handed over (${answer ?? 'unanswered'}); left to the lease`);
        state.keepGroup = true;
        return null;
    }
    if (answer === null) state.keepGroup = true;
    const why = answer === 'exhausted' ? `${reason}, and the interruption budget is spent` : reason;
    return land(ctx, leaveDecision(job, why, exitCode), after);
}

/**
 * Hands the pre-run claim back. A refused requeue (a lost lease, a stop that won the race) leaves the
 * board's answer standing; retried like a verdict, and one that still fails leaves the job to its
 * lease with its runner standing.
 */
async function requeue(ctx: AttemptCtx): Promise<void> {
    const { rt, job, state } = ctx;
    await withBoardRetry(rt, `job ${job.id}: the requeue was not accepted`, () => rt.board.requeue(job)).catch(
        (e: Error) => {
            rt.log(`job ${job.id}: could not requeue: ${e.message}`);
            state.keepGroup = true;
        }
    );
}
