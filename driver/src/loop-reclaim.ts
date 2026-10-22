import type { Board, BoardJob, Reclaim, ReclaimAck, ReclaimRenewal } from './board.js';
import { withBoardRetry } from './board-retry.js';
import type { DriverConfig } from './config.js';
import type { Runner } from './runner.js';
import type { ReclaimResult } from './publish.js';
import { CLAUDE_CODE } from './executors.js';

const MS_PER_SECOND = 1_000;
/** The heartbeat's pace (`loop-attempt.ts`): a third of the lease, never under a second. */
const MIN_RENEW_PERIOD_MS = 1_000;
const RENEW_PERIOD_DIVISOR = 3;

/**
 * The worktree-reclaim queue's worker half (issue #41), split out of `loop.ts` for the same
 * line-count reason `runJob` was (#223): the drain loop stays in the loop, and everything one
 * claimed row does — the removal, the orphaned-claim proof and reap (issue #344), the throttled
 * failure logging, the ack — lives here.
 */

/**
 * A `BoardJob` synthesised from a claimed reclaim row, for the same runner call a terminal
 * thread's report() uses: the thread's identity — its root id, repo label and workspace path — is
 * all the tree is filed under. The acquisition's own token rides as the lease token (issue #821),
 * which is what makes the removal hold the checkout against a live attempt's startup sync under
 * kubernetes (the claim ConfigMap is keyed by the job id, and its holder data carries the lease
 * token) — and what fences a later acquisition of the same row from this one's claim. No agent
 * is ever spawned for a reclaim, so it carries no executor selection worth naming and no prompt.
 */
function reclaimJob(reclaim: Reclaim): BoardJob {
    return {
        id: reclaim.rootJobId,
        command: '',
        attempts: 1,
        maxAttempts: 1,
        lastAttempt: true,
        claimSeq: 1,
        leaseToken: reclaim.token,
        leaseExpiresAt: reclaim.leaseExpiresAt,
        resumeSessionId: null,
        followUp: false,
        ownSession: false,
        continuesInterrupted: false,
        userId: null,
        workspacePath: reclaim.workspacePath,
        rootJobId: reclaim.rootJobId,
        rootCommand: '',
        repo: reclaim.repo,
        executorType: CLAUDE_CODE,
        executorRefusal: null,
        skillRefusal: null,
        planRefusal: null,
        masterPrompt: null,
    };
}

/** What renewing a reclaim row needs: the board, the driver's lease, a logger and a sleeper. */
export interface RenewContext {
    board: Pick<Board, 'renewReclaim'>;
    config: Pick<DriverConfig, 'leaseSeconds'>;
    log: (message: string) => void;
    /** Ended by `until` — the renewed work settling — so a pending period never outlives it. */
    sleep: (ms: number, until?: Promise<unknown>) => Promise<void>;
}

/** The row and the acquisition token a removal is renewed under. */
export interface ReclaimOwnership {
    id: string;
    token: string;
}

/** A renewed removal's answer: its value, or that this acquisition no longer owned the row. */
export type Renewed<T> = { held: true; value: T } | { held: false };

/** One renew, bounded by `timeoutMs`; a throw is logged and answered as such, never a rejection. */
async function renewOnce(
    ctx: RenewContext,
    owned: ReclaimOwnership,
    timeoutMs: number
): Promise<ReclaimRenewal | 'threw'> {
    try {
        return await ctx.board.renewReclaim(owned.id, owned.token, AbortSignal.timeout(timeoutMs));
    } catch (e) {
        ctx.log(`reclaim ${owned.id}: the renew threw: ${(e as Error).message}`);
        return 'threw';
    }
}

/** The heartbeat's pace — and each renew's deadline: a third of the lease, never under a second. */
const renewPeriodMs = (ctx: RenewContext): number =>
    Math.max(MIN_RENEW_PERIOD_MS, Math.floor((ctx.config.leaseSeconds * MS_PER_SECOND) / RENEW_PERIOD_DIVISOR));

/** Whether this acquisition still owns the row, renewed now; anything else is logged. */
export async function reclaimStillOwned(ctx: RenewContext, owned: ReclaimOwnership): Promise<boolean> {
    const answer = await renewOnce(ctx, owned, renewPeriodMs(ctx));
    if (answer === 'held') return true;
    if (answer !== 'threw') ctx.log(`reclaim ${owned.id}: the renew answered ${answer}, so it is not this driver's`);
    return false;
}

/**
 * Runs `work` — a removal — under the row's renewed lease (issue #821): renewed once before it
 * starts, and the work never started unless that renew answers held, then at the heartbeat's pace
 * until it settles. Each renew is bounded by the period. A thrown renew is logged and tried again
 * next period; `lost` or `missing` is logged once and stops the renewing, but never aborts a
 * deletion already in flight — its ack is refused anyway, and nothing can reopen an acquired row.
 * Once the work settles nothing waits on a renew still in flight, and no further one starts.
 */
export async function whileReclaimRenewed<T>(
    ctx: RenewContext,
    owned: ReclaimOwnership,
    work: () => Promise<T>
): Promise<Renewed<T>> {
    if (!(await reclaimStillOwned(ctx, owned))) return { held: false };
    let settled = false;
    const running = work();
    const settle = running.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        }
    );
    const every = renewPeriodMs(ctx);
    // Never awaited: renewOnce never rejects, and every turn re-checks `settled` before it renews.
    void (async () => {
        for (;;) {
            await Promise.race([ctx.sleep(every, settle), settle]);
            if (settled) return;
            const answer = await renewOnce(ctx, owned, every);
            if (settled) return;
            if (answer === 'lost' || answer === 'missing') {
                ctx.log(`reclaim ${owned.id}: the renew answered ${answer}; the removal in flight is left to settle`);
                return;
            }
        }
    })();
    return { held: true, value: await running };
}

/** Everything one claimed reclaim row needs from the loop. `failureLog` is the loop's own throttle state. */
export interface ReclaimContext extends RenewContext {
    board: Pick<Board, 'ackReclaim' | 'renewReclaim'>;
    runner: Runner;
    config: DriverConfig;
    /** The last failure digest logged per thread root — see `loop.ts`'s `reclaimFailureLog`. */
    failureLog: Map<string, string>;
}

/** Logs a reclaim failure only when what refused has changed since the last logged line. */
function logReclaimFailure(ctx: ReclaimContext, reclaim: Reclaim, digest: string, message: string): void {
    if (ctx.failureLog.get(reclaim.rootJobId) === digest) return;
    ctx.failureLog.set(reclaim.rootJobId, digest);
    ctx.log(message);
}

/** What a verdict-time reclaim needs: the renewal's context, the ack and the runner's removal. */
export interface VerdictReclaimContext extends RenewContext {
    board: Pick<Board, 'renewReclaim' | 'ackReclaim'>;
    runner: Pick<Runner, 'reclaimWorktree'>;
}

/** An ack under the acquisition's token; a throw is retried for the lease, its replay answering ok. */
function ackOwned(ctx: VerdictReclaimContext, what: string, owned: ReclaimOwnership): Promise<ReclaimAck> {
    return withBoardRetry(
        ctx,
        `${what}: the reclaim ack was not accepted`,
        () => ctx.board.ackReclaim(owned.id, owned.token),
        { budgetMs: ctx.config.leaseSeconds * MS_PER_SECOND }
    );
}

/**
 * A threadDone verdict's reclaim (issue #821): the row is the completing attempt's, under its
 * lease token — the job's tree removed under the renewed lease and acked under that token. A
 * refusal, a throw or a refused ack is logged and leaves the row to its lease. Never throws.
 */
export async function processVerdictReclaim(
    ctx: VerdictReclaimContext,
    job: BoardJob,
    reclaimId: string
): Promise<void> {
    const owned = { id: reclaimId, token: job.leaseToken };
    try {
        const renewed = await whileReclaimRenewed(ctx, owned, () => ctx.runner.reclaimWorktree(job));
        if (!renewed.held) return;
        if (!renewed.value.ok) {
            ctx.log(`job ${job.id}: the task worktree could not be reclaimed: ${renewed.value.reason}`);
            return;
        }
        const ack = await ackOwned(ctx, `job ${job.id}`, owned);
        if (ack !== 'ok') ctx.log(`job ${job.id}: the reclaim ack answered ${ack}`);
    } catch (e) {
        ctx.log(`job ${job.id}: the task worktree could not be reclaimed: ${(e as Error).message}`);
    }
}

/** Acks a settled row under its acquisition token, logging the two refusal shapes the ack can answer. */
async function ackSettledReclaim(ctx: ReclaimContext, reclaim: Reclaim): Promise<void> {
    let ack: ReclaimAck;
    try {
        ack = await ackOwned(ctx, `reclaim ${reclaim.id}`, reclaim);
    } catch (e) {
        ctx.log(`reclaim ${reclaim.id}: the ack threw, leaving it to the lease: ${(e as Error).message}`);
        return;
    }
    if (ack === 'lost') {
        ctx.log(`reclaim ${reclaim.id}: ack refused, the row is re-leased to another worker`);
    } else if (ack === 'missing') {
        ctx.log(`reclaim ${reclaim.id}: already acked elsewhere`);
    }
}

/**
 * Removes one claimed reclaim row's tree and acks it, so the row stops being offered. The
 * tree is reclaimed with the same runner call a terminal thread's report() uses, fed the job
 * `reclaimJob` synthesises from the row.
 *
 * The removal runs under the row's renewed lease (`whileReclaimRenewed`), and does not start unless
 * a renew just answered that this acquisition still owns the row.
 * A removed thread has no follow-ups — every row was deleted — so there is no reclaim barrier
 * entry to take here: nothing can claim that root again, and this loop's owns each root it is
 * handed once. A refused tree or a throw — in the reclaim or its ack — simply skips the ack,
 * and the row is offered again when its lease expires; a refused tree also stays on the disk,
 * exactly as a refused terminal reclaim leaves it.
 */
export async function processReclaim(ctx: ReclaimContext, reclaim: Reclaim): Promise<void> {
    const removed = reclaimJob(reclaim);
    let outcome: ReclaimResult;
    try {
        const renewed = await whileReclaimRenewed(ctx, reclaim, () => ctx.runner.reclaimWorktree(removed));
        if (!renewed.held) return;
        outcome = renewed.value;
    } catch (e) {
        logReclaimFailure(
            ctx,
            reclaim,
            `throw: ${(e as Error).message}`,
            `reclaim ${reclaim.id}: the worktree reclaim threw, leaving it to the lease: ${(e as Error).message}`
        );
        return;
    }
    if (!outcome.ok) {
        logReclaimFailure(
            ctx,
            reclaim,
            outcome.reason ?? '',
            `reclaim ${reclaim.id}: the task worktree could not be reclaimed: ${outcome.reason}`
        );
        return;
    }
    ctx.failureLog.delete(reclaim.rootJobId);
    await ackSettledReclaim(ctx, reclaim);
}
