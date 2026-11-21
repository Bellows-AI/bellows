import { randomUUID } from 'node:crypto';
import type { FinishPassWrite } from '../board/board-gate-runs.js';
import type { FinishAnswer } from '../control-channel.js';
import { DaemonLost } from '../dockerd-loss.js';
import { describeError } from '../log.js';
import { tailBytes } from '../runner.js';
import { stepLost } from '../step-control.js';
import { GATE_RUNS_READ_MS } from './gate-reuse.js';
import { down, raceStep, settling, updateRunDeadline } from './loop-attempt.js';
import { type GateFailure, type GateSession, probeTreeNow } from './loop-gates.js';
import { type GatesPhase, runGatePass } from './loop-gate-pass.js';
import { servicesLost } from './loop-services.js';
import type { AttemptCtx } from './loop-types.js';

/** The failed gate's output the agent is shown: its tail, bounded. */
export const FINISH_OUTPUT_TAIL_BYTES = 8192;

/** The run's round count and its cap, as read for one ask. */
interface Rounds {
    failed: number;
    limit: number;
}

const skip = (reason: string): FinishAnswer => ({ verdict: 'skip', reason });
const unavailable = (reason: string): FinishAnswer => ({ verdict: 'unavailable', reason });

/**
 * Opens the agent's finish pass (`POST /gate/finish`) on the attempt's control token, once its gate session is
 * registered — on every claim, so a takeover's re-ask reaches the new holder. Asks are served one at a time: a
 * second ask waits for the pass in flight, and is then answered on its own reads.
 */
export function attachFinishPass(ctx: AttemptCtx): void {
    const { rt, state } = ctx;
    if (!rt.gates || state.control === null) return;
    let inFlight: Promise<unknown> = Promise.resolve();
    rt.gates.server.attachFinish(state.control, () => {
        const answer = inFlight.then(() => finishPass(ctx));
        inFlight = answer.catch(() => undefined);
        return answer;
    });
}

/**
 * One finish pass: nothing runs under a stop, without a declared gate, without a cap the claim carried, or without a
 * failed-round count the board confirmed — those let the agent stop and leave the run to the close-time verifier.
 * Under the cap the declared gates run through the close-time pass's own body (`runGatePass`, source `finish`).
 */
async function finishPass(ctx: AttemptCtx): Promise<FinishAnswer> {
    const { job, state } = ctx;
    if (down(state) || settling(state)) return skip('the agent is being stopped');
    // Read at ask time, never captured at attach: a session is the claim's own.
    const { gateSession } = ctx;
    if (!gateSession?.endPass) return skip('no declared gate runs at the finish');
    const limit = job.finishRounds;
    // An absent cap is unknown, never 0.
    if (limit === undefined) return unavailable('the claim carried no round cap');
    const failed = await readFailedRounds(ctx);
    if (failed === null) return unavailable('the failed finish rounds could not be read');
    if (failed >= limit) return { verdict: 'cap', rounds: failed, limit };
    return runFinish(ctx, gateSession, { failed, limit });
}

/** The job row's failed rounds, read fresh on every ask; null when unconfirmed or stood down. */
async function readFailedRounds(ctx: AttemptCtx): Promise<number | null> {
    const { rt, job, state } = ctx;
    const signal = AbortSignal.any([state.signal, AbortSignal.timeout(GATE_RUNS_READ_MS)]);
    const raced = await raceStep(
        state.signal,
        rt.board.finishRounds(job, signal).catch(() => null)
    );
    return raced?.value ?? null;
}

/**
 * The pass itself, with the runtime budget paused throughout. Every exit — an answer, a throw, a stand-down — reopens
 * the ad-hoc admission the tree probe closed (while the agent still runs), resumes the budget and sizes the gate
 * container back to idle.
 */
async function runFinish(ctx: AttemptCtx, gateSession: GateSession, rounds: Rounds): Promise<FinishAnswer> {
    const { rt, job, state } = ctx;
    state.finishPasses += 1;
    await settleBudget(ctx);
    try {
        const phase = await gatesOf(ctx, gateSession);
        if (phase === null) return unavailable('the gates infrastructure was lost');
        // Stood down, or stopped, while the gates ran: nothing is written, the agent is let go.
        if (down(state) || settling(state)) return skip('the agent is being stopped');
        return await answerOf(ctx, phase, rounds);
    } finally {
        if (state.running) rt.gates?.server.reopen(gateSession.token);
        state.finishPasses -= 1;
        await rt.runner.resizeGate(job, 'idle').catch(() => false);
        await settleBudget(ctx);
    }
}

/** The budget follows the pauses in flight; a failed pause or resume costs the budget's accuracy, never the pass. */
async function settleBudget(ctx: AttemptCtx): Promise<void> {
    const { rt, job, state } = ctx;
    await updateRunDeadline(rt, job, state).catch((error: Error) => {
        rt.log(`job ${job.id}: could not update the finish pass runtime budget: ${describeError(error)}`);
    });
}

/**
 * The shared gates pass over the tree as it stands now. Null when the infrastructure under it was lost — the
 * attempt's loss, recorded as the ad-hoc runs' is (`state.gateLoss`), never a verdict on the gates.
 */
async function gatesOf(ctx: AttemptCtx, gateSession: GateSession): Promise<GatesPhase | null> {
    const { rt, job, state } = ctx;
    try {
        const treeAfter = await probeTreeNow(ctx);
        return await runGatePass(ctx, gateSession, { source: 'finish', treeAfter });
    } catch (e) {
        if (!servicesLost(e) && !(e instanceof DaemonLost)) throw e;
        const message = (e as Error).message;
        state.gateLoss ??= stepLost(e) ? `the task supervisor running the finish pass was lost: ${message}` : message;
        rt.log(`job ${job.id}: the finish pass lost its infrastructure: ${describeError(e)}`);
        return null;
    }
}

/**
 * What a finished pass answers. No change: skip. Dead services the agent cannot fix: unavailable, nothing written.
 * Green: a passed round, `pass`. Red: a failed round, and `fail` only once the board took it — an unrecorded round is
 * not spent, so the agent is let go (`unavailable`) rather than sent back uncounted.
 */
async function answerOf(ctx: AttemptCtx, phase: GatesPhase, rounds: Rounds): Promise<FinishAnswer> {
    if (phase.noChange) return skip(phase.gatesSkipped ?? 'the task produced no change');
    if (phase.deadServices.length > 0) {
        return unavailable(`declared services are dead: ${phase.deadServices.map(({ name }) => name).join(', ')}`);
    }
    const { failure } = phase;
    if (!failure) {
        await writeRound(ctx, { verdict: 'passed', gate: null });
        return { verdict: 'pass' };
    }
    if ((await writeRound(ctx, { verdict: 'failed', gate: failure.name })) !== 'ok') {
        return unavailable('the failed round could not be recorded');
    }
    return failAnswer(failure, rounds.failed + 1, rounds.limit);
}

/** One answered round, under the lease and the claim the gate session gates. */
async function writeRound(
    ctx: AttemptCtx,
    round: Pick<FinishPassWrite, 'verdict' | 'gate'>
): Promise<'ok' | 'lost' | 'rejected'> {
    const { rt, job, state, gateSession } = ctx;
    if (!gateSession) return 'rejected';
    const write: FinishPassWrite = { passId: randomUUID(), runClaimSeq: gateSession.runClaimSeq, ...round };
    const signal = AbortSignal.any([state.signal, AbortSignal.timeout(GATE_RUNS_READ_MS)]);
    return rt.board.finishPass(job, write, signal).catch(() => 'rejected' as const);
}

/** The red answer: the gate, its output tail, the round it spent, and the text the agent is sent back with. */
export function failAnswer(failure: GateFailure, round: number, limit: number): FinishAnswer {
    const output = tailBytes(failure.output, FINISH_OUTPUT_TAIL_BYTES);
    const message =
        `The "${failure.name}" gate failed (round ${round} of ${limit}). Fix the cause so the gate passes, ` +
        `keeping the change as small as the fix allows, then finish again.\n\nGate output:\n${output}`;
    return { verdict: 'fail', gate: failure.name, exitCode: failure.exitCode, output, round, limit, message };
}
