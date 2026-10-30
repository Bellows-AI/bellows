import type { BoardJob, ReviewAnswer, ReviewClaim } from '../board/board.js';
import { withBoardRetry } from '../board/board-retry.js';
import { openReviewExport } from './loop-export.js';
import { applyHeartbeatVerdict, down, type JobState, newReviewStop, settling } from './loop-attempt.js';
import type { LoopRuntime } from './loop-types.js';
import type { ReviewRelay, ReviewVerdict } from '../review/review-control.js';
import { OUTPUT_LIMIT, tailBytes } from '../runner.js';
import { reviewBudgetMs } from '../review/review-step.js';
import { pickSession } from '../runner-plan.js';
import { heartbeatPeriodMs } from '../supervisor-plan.js';
import { stepLost } from '../step-control.js';
import type { ReviewExporter } from '../supervised-steps.js';
import type { StepResult } from '../supervisor-contract.js';

/**
 * The agent's named-reviewer invocation (issue #549): `POST /review` and `GET /review/<key>` on the
 * control endpoint, relayed to the board. The agent names a key and a profile. Everything that
 * makes the result trustworthy is the DRIVER's, never the agent's:
 *
 * - the revision is the tree fingerprint `runner.probeTree` measures right now, over the same
 *   transport the publish binding uses — the agent cannot name one;
 * - the snapshot is frozen by `runner.snapshotTree` BEFORE the board is asked, so a reviewer that
 *   is claimed the instant its row exists already finds its ref, and a repeated request finds the
 *   first snapshot (a stored review keeps the revision it was bound to);
 * - the board validates the profile against the ones the repository declared when this attempt was
 *   claimed, runs the review as a thread of its own with only that profile's grants, and answers
 *   the thread's review evidence — which this relay adopts as `job.review`, so the end-of-run
 *   publish and the draft publish judge the review that actually ran, not the claim-time state.
 *   A review the board just created or re-leased comes back with its CLAIM (issue #774), and this
 *   driver supervises it (`superviseReview`) in the caller's own task group — no queue, no slot.
 *
 * Fenced like the publish relay: a stood-down or finished attempt asks for nothing. A Stop that is
 * only draining refuses too — a review is new work, and the agent was told to finish.
 */
export function createReviewRelay(rt: LoopRuntime, job: BoardJob, state: JobState): ReviewRelay {
    const gone = (): boolean => state.phase === 'ended' || settling(state) || down(state);
    return {
        async request(key, profile) {
            if (gone()) return 'gone';
            const revision = await rt.runner.probeTree(job, state.signal).catch(() => null);
            if (revision === null)
                return { refused: 'the task tree could not be measured, so there is nothing to review' };
            const snapshot = await rt.runner.snapshotTree(job, key, state.signal);
            if (!snapshot.ok) return { refused: snapshot.reason };
            if (gone()) return 'gone';
            return verdictOf(rt, job, state, () =>
                rt.board.requestReview(job, { key, profile, revision, ref: snapshot.ref })
            );
        },
        async read(key) {
            if (gone()) return 'gone';
            return verdictOf(rt, job, state, () => rt.board.readReview(job, key));
        },
    };
}

/** One board round trip, read as a verdict; the lease verdicts stand the attempt down like a heartbeat's. */
async function verdictOf(
    rt: LoopRuntime,
    job: BoardJob,
    state: JobState,
    ask: () => Promise<ReviewAnswer>
): Promise<ReviewVerdict> {
    const answer = await withBoardRetry(rt, `job ${job.id}: the review call was not accepted`, ask).catch(
        (e: Error) => {
            rt.log(`job ${job.id}: the review call failed: ${e.message}`);
            return null;
        }
    );
    if (answer === null) return { refused: 'the board could not be reached; ask again' };
    if (answer.result === 'refused') return { refused: answer.reason };
    if (answer.result !== 'ok') {
        await applyHeartbeatVerdict(rt, job, state, answer.result);
        return 'gone';
    }
    if (answer.claim) superviseReview(rt, state, { caller: job, review: answer.claim, key: answer.review.key });
    // The thread's review evidence as the policy reads it now: what the publish decisions judge.
    job.review = answer.review.evidence;
    return { review: answer.review, created: answer.created };
}

const MIN_BEAT_MS = 1_000;
const BEAT_DIVISOR = 3;
const MS_PER_SECOND = 1_000;
const EXIT_TIMEOUT = 124;
/** What the supervisor answers a step the driver cancelled. */
const EXIT_CANCELLED = 130;
/** How many times a request the reviewer container lost is run (the first included) before the row is failed. */
const MAX_RUNS = 3;

/**
 * Why a review's supervision was told to stop. Only an EXPLICIT stop settles the row failed: the
 * board's cancel on the review row, or the caller's own stop. An infrastructure event (a
 * handover, a lost lease of the caller or of the review, a lost supervisor) leaves the row to be
 * re-leased by the caller that is claimed again and asks the same key.
 */
interface StopCause {
    /** The board raised `cancelRequested` on the review row. */
    boardCancel: boolean;
}

/**
 * Supervises one review the board leased to this driver, in the caller's task group (issue #774):
 * the reviewer container is sized up, the review runs as supervised steps (restore, then the
 * executor), the review row is heartbeat under its OWN lease, and the row is completed with the
 * step's output — a timeout fails the row (`timeout`), never the caller. Tracked in the caller's
 * `state` by key: a key already supervised starts nothing (a retried request whose answer was lost
 * gets the same claim back), and the caller's stop, stand-down or finish cancels it. Not awaited:
 * the caller's agent reads the verdict through the relay.
 */
export function superviseReview(
    rt: LoopRuntime,
    state: JobState,
    supervision: { caller: BoardJob; review: ReviewClaim; key: string }
): void {
    const { caller, review, key } = supervision;
    const lease = `${review.id}:${review.claimSeq}`;
    // A claim this attempt already ended arrived late (a delayed read or replayed request answer).
    if (state.reviews.has(key) || state.endedReviewLeases.has(lease)) return;
    const { stop, release } = newReviewStop(state);
    const cause: StopCause = { boardCancel: false };
    const settled = superviseOne(rt, state, { caller, review, stop, cause }).finally(() => {
        release();
        state.reviews.delete(key);
        state.endedReviewLeases.add(lease);
    });
    state.reviews.set(key, {
        cancel: () => stop.abort(),
        settled,
    });
}

/** Ends every review the attempt still supervises and waits for their rows to settle and their reviewers to be released. */
export async function cancelReviews(state: JobState): Promise<void> {
    const open = [...state.reviews.values()];
    for (const supervision of open) supervision.cancel();
    await Promise.all(open.map((supervision) => supervision.settled));
}

async function superviseOne(
    rt: LoopRuntime,
    state: JobState,
    supervision: { caller: BoardJob; review: ReviewClaim; stop: AbortController; cause: StopCause }
): Promise<void> {
    const { caller, review, stop, cause } = supervision;
    const { runner, log } = rt;
    let over = (): void => {};
    const ended = new Promise<void>((resolve) => {
        over = resolve;
    });
    const beating = beatReview(rt, supervision, ended);
    let result: StepResult | null = null;
    let lost = false;
    const exporting = openReviewExport(rt, caller, review);
    try {
        await runner.resizeReviewer(caller, 'run').catch(() => false);
        result = await runUntilAnswered(rt, supervision, exporting?.exporter);
    } catch (e) {
        // A lost supervisor is no verdict on the review; anything else that stopped it ends the row.
        lost = stepLost(e);
        if (!lost && !stop.signal.aborted) result = failedStep((e as Error).message);
        else log(`review ${review.id}: the review step ended without an answer: ${(e as Error).message}`);
    } finally {
        exporting?.close();
        over();
        await beating;
        await runner.resizeReviewer(caller, 'idle').catch(() => false);
    }
    // The row is settled by an explicit stop alone; a lost supervisor or an infrastructure stand-down
    // (a handover, a lost lease) leaves it to the lease, to be re-leased and resumed.
    await settleReview(rt, review, result, !lost && stoppedExplicitly(state, stop, cause));
}

/**
 * Whether the stop that aborted this review was an explicit one, never an infrastructure event. The
 * caller's finish is not one: it follows a verdict (the board stops the caller's reviews with it) or
 * an interruption (a lost pod), and either way the row is the lease's or the board's to settle.
 */
function stoppedExplicitly(state: JobState, stop: AbortController, cause: StopCause): boolean {
    if (!stop.signal.aborted) return false;
    return cause.boardCancel || state.ending?.kind === 'stop';
}

/**
 * Runs the review step until it answers. A request the reviewer container lost (an answer with no exit
 * code: it restarted mid-request) is run again as a new step, on a session valid for the run, within
 * the review's budget; the answer that stays is the last run's, and a request lost on every run is
 * failed with that said, so the caller is never left waiting on a review nothing supervises.
 */
async function runUntilAnswered(
    rt: LoopRuntime,
    supervision: { caller: BoardJob; review: ReviewClaim; stop: AbortController },
    exporter: ReviewExporter | undefined
): Promise<StepResult> {
    const { caller, review, stop } = supervision;
    const startedAt = Date.now();
    const budgetMs = reviewBudgetMs(rt.config, review);
    for (let round = 1; ; round += 1) {
        const session = pickSession(review, review.executorType);
        // A fresh session is recorded before it runs, so a re-leased review resumes it; a resumed
        // one is reported again so the board's claim-time inference becomes a report.
        if (session) {
            await rt.board.session(review, session.id).catch((e: Error) => {
                rt.log(`review ${review.id}: the session was not recorded: ${e.message}`);
            });
        }
        const final = round >= MAX_RUNS || Date.now() - startedAt >= budgetMs;
        const result = await rt.runner.runReview(caller, review, session, {
            signal: stop.signal,
            ...(exporter ? { exporter } : {}),
            round,
            final,
        });
        if (result.exitCode !== null || stop.signal.aborted) return result;
        rt.log(`review ${review.id}: the reviewer container lost the request (run ${round})`);
        if (final) return failedStep(`the reviewer container lost the review request ${round} times: ${result.stderr}`);
    }
}

const failedStep = (reason: string): StepResult => ({ exitCode: 1, stdout: '', stderr: reason, timedOut: false });

/** Heartbeats the review row under its own lease; a refused lease or a cancel request ends the review, only the cancel settles it. */
async function beatReview(
    rt: LoopRuntime,
    supervision: { review: ReviewClaim; stop: AbortController; cause: StopCause },
    ended: Promise<void>
): Promise<void> {
    const { review, stop, cause } = supervision;
    const every = Math.max(MIN_BEAT_MS, Math.floor((rt.config.leaseSeconds * MS_PER_SECOND) / BEAT_DIVISOR));
    let over = false;
    void ended.then(() => {
        over = true;
    });
    while (!over) {
        await Promise.race([rt.sleep(every), ended]);
        if (over) return;
        const verdict = await rt.board
            .heartbeat(review, AbortSignal.timeout(heartbeatPeriodMs(rt.config)))
            .catch((e: Error) => {
                // A beat that errors or times out is retried on the next one, within the lease.
                rt.log(`review ${review.id}: the heartbeat failed: ${e.message}`);
                return null;
            });
        if (verdict === null) continue;
        if (verdict === 'lost' || verdict === 'removed') stop.abort();
        else if (verdict.cancelRequested) {
            cause.boardCancel = true;
            stop.abort();
        }
    }
}

/**
 * Completes the review row with the step's answer, or nothing: a lost step (no exit code) is no
 * verdict, and a cancelled review settles the row failed so it does not wait out its lease.
 */
async function settleReview(
    rt: LoopRuntime,
    review: ReviewClaim,
    result: StepResult | null,
    cancelled: boolean
): Promise<void> {
    const body = completionOf(result, cancelled);
    if (body === null) return;
    await withBoardRetry(rt, `review ${review.id}: the review verdict was not accepted`, () =>
        rt.board.complete(review, body)
    ).catch((e: Error) => rt.log(`review ${review.id}: the review could not be settled: ${e.message}`));
}

function completionOf(
    result: StepResult | null,
    cancelled: boolean
): Parameters<LoopRuntime['board']['complete']>[1] | null {
    // An answer that landed before the cancel stands; a cancelled review, or one that answered the cancel, ends the row failed.
    const answered = result !== null && result.exitCode !== null && result.exitCode !== EXIT_CANCELLED;
    if (!answered) {
        return cancelled
            ? { status: 'failed', exitCode: null, output: 'the review was cancelled', failureKind: 'runner_error' }
            : null;
    }
    const output = tailBytes(`${result.stdout}${result.stderr}`.trim(), OUTPUT_LIMIT);
    if (result.timedOut || result.exitCode === EXIT_TIMEOUT) {
        return { status: 'failed', exitCode: EXIT_TIMEOUT, output, failureKind: 'timeout' };
    }
    if (result.exitCode !== 0)
        return { status: 'failed', exitCode: result.exitCode, output, failureKind: 'runner_error' };
    return { status: 'succeeded', exitCode: 0, output: tailBytes(result.stdout, OUTPUT_LIMIT) };
}
