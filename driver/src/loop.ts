import type { Board, BoardJob, LeaseState, Reclaim } from './board.js';
import type { DriverConfig } from './config.js';
import { repoCacheProblem, workspacePathOf } from './claim.js';
import type { Runner } from './runner.js';
import { worktreeRelDir } from './publish.js';
import type { GateStack, LiveAttempt, LoopRuntime } from './loop-types.js';
import { runJob } from './loop-run.js';
import { processReclaim, processVerdictReclaim } from './loop-reclaim.js';
import { CLAUDE_CODE } from './executors.js';
import { withBoardRetry } from './board-retry.js';
import { type SyncQueue, syncQueue } from './sync-queue.js';
import { down, type JobState } from './loop-attempt.js';
import { recordEnding } from './loop-phase.js';

export interface Loop {
    /**
     * Resolves once `stop()` has been called and every in-flight job has finished — or, after a
     * `handover`, at once: the runs it handed over are no longer this loop's to wait on.
     */
    start(): Promise<void>;
    stop(): void;
    /**
     * Hands every attempt still in flight back to the board as an interruption (issue #792): each
     * reads as lost from here — nothing parked, reported or killed — and its runner is left alive
     * for the next claim. What a draining driver does before its grace runs out.
     */
    handover(reason: string): Promise<void>;
}

export interface LoopDeps {
    board: Board;
    runner: Runner;
    config: DriverConfig;
    gates?: GateStack;
    log?: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
    /** Test seam for the draining grace (`STOP_GRACE_MS`); production never sets it. */
    stopGraceMs?: number;
    /** Orders startup syncs of one clone; the in-process `syncQueue()` when absent (issue #559). */
    syncs?: SyncQueue;
    /** Test seam for the sync-queue wait (`SYNC_QUEUE_WAIT_MS`); production never sets it. */
    syncWaitMs?: number;
}

/** The production sleep; `until` settling ends it early and clears its timer, so nothing outlives its caller. */
export const wait = (ms: number, until?: Promise<unknown>) =>
    new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        const stop = () => {
            clearTimeout(timer);
            resolve();
        };
        until?.then(stop, stop);
    });

/**
 * A claimed job this loop refuses to run as claimed — no workspace, no resolvable task worktree,
 * or a resume claim its selected executor cannot restore — answered as a failure report rather
 * than dropped, so the job reaches a terminal state somebody can see instead of being reclaimed
 * on every lease expiry forever. Null when the claim is runnable.
 */
function claimRefusal(job: BoardJob): { log: string; output: string; config?: true } | null {
    /*
     * A job whose author has no workspace is FAILED, never run in a fallback location.
     *
     * There is no safe fallback left. Checkouts are per member now, so both `<mount>`
     * and `<mount>/<org>` are the parent of everybody's tree — handing either to a
     * container that may be running --dangerously-skip-permissions would let one
     * member's job read and edit another's working copy.
     */
    if (!workspacePathOf(job)) {
        return {
            log: 'no workspace for its author, failing',
            output: 'This job has no workspace. It was queued by an account this board cannot resolve a checkout directory for, or the board has no workspace root configured.',
        };
    }

    /*
     * A repo job runs in its task worktree (issue #35), so the same rule the null
     * workspacePath above applies extends there: a board-shaped repo label this
     * driver cannot resolve a worktree path for is failed with a reason, never run
     * in a fallback location. The board's own shape validation is not this
     * process's to trust.
     */
    if (job.repo && !worktreeRelDir(job)) {
        return {
            log: 'no resolvable task worktree for its repo label, failing',
            output: `This job names repository ${job.repo}, but its workspace and thread do not resolve to a task worktree directory this driver can run it in.`,
        };
    }

    // Issue #734: a declared package cache the driver will not set, failed before any sync.
    const cacheProblem = repoCacheProblem(job);
    if (cacheProblem) {
        return { log: `${cacheProblem}, failing`, output: `This job cannot run: ${cacheProblem}.`, config: true };
    }

    return null;
}

const MS_PER_SECOND = 1_000;

// A non-409 failure (a board 5xx, a dropped connection) leaves the finished run without a verdict,
// and the lease expiry would run it again after its work already published. 409 is already an
// answer (`lost`), so only a throw is retried — for as long as the lease the verdict still holds
// (issue #820), since past it the board answers lost anyway; the last one propagates.
function completeWithRetry(
    deps: Pick<LoopRuntime, 'board' | 'config' | 'log' | 'sleep'>,
    job: BoardJob,
    result: Parameters<Board['complete']>[1]
) {
    return withBoardRetry(deps, `job ${job.id}: the verdict was not accepted`, () => deps.board.complete(job, result), {
        budgetMs: deps.config.leaseSeconds * MS_PER_SECOND,
    });
}

/**
 * One attempt handed over: the intent is recorded and the attempt told to stop; its own chain ends
 * it as an interruption (`end`, `loop-conclusion.ts`), the runner left for the next claim.
 */
function handOver(state: JobState, reason: string): void {
    if (!recordEnding(state, 'handover')) return;
    state.handoverReason = reason;
    state.abortNow();
    state.wake();
    state.signalHandover();
}

/**
 * The drain's handover (issue #792): the attempts in flight — registered on `rt.live`, where each
 * `runJob` reports its own — and the latch `start()` stops waiting at.
 */
export function handoverOf(rt: LoopRuntime) {
    const live = new Map<string, LiveAttempt>();
    rt.live = live;
    let landed: () => void = () => {};
    const done = new Promise<void>((resolve) => {
        landed = resolve;
    });
    return {
        done,
        async run(reason: string): Promise<void> {
            // An attempt whose `end` started — a verdict in flight (issue #821) or any other decision — is
            // not handed over: its own ending and teardown decide it.
            const handing = [...live.values()].filter(
                ({ state }) =>
                    state.phase !== 'ended' && state.phase !== 'concluding' && !state.endStarted && !down(state)
            );
            for (const { state } of handing) handOver(state, reason);
            // `start()` stops waiting only once every handed-over attempt's end has settled.
            await Promise.all(handing.map(({ over }) => over));
            landed();
        },
    };
}

/**
 * A done thread's verdict-time reclaim (`report` in `createLoop`): the removal, once the attempt's
 * group is torn down (`after`, issue #821), then its ack. Registered under the thread's root in the
 * reclaim barrier before it starts — the set and the start are one synchronous block, so no claimant
 * can observe the in-between — and dropped only while it is still the one registered: a replacement
 * reclaim for the same root is never undone by a predecessor settling late.
 */
function startVerdictReclaim(
    deps: Pick<LoopRuntime, 'board' | 'runner' | 'config' | 'log' | 'sleep' | 'reclaims'>,
    job: BoardJob,
    order: { reclaimId: string; after: Promise<void> | undefined }
): void {
    const { board, runner, config, log, sleep, reclaims } = deps;
    const root = job.rootJobId ?? job.id;
    const reclaim: Promise<void> = (async () => {
        // The tree outlives the attempt's last step.
        await order.after;
        await processVerdictReclaim({ board, runner, config, log, sleep }, job, order.reclaimId);
    })().finally(() => {
        if (reclaims.get(root) === reclaim) reclaims.delete(root);
    });
    reclaims.set(root, reclaim);
}

export function createLoop({
    board,
    runner,
    config,
    gates,
    log = () => {},
    sleep = wait,
    stopGraceMs,
    syncs = syncQueue(),
    syncWaitMs,
}: LoopDeps): Loop {
    let running = true;
    const active = new Set<Promise<void>>();

    /*
     * In-flight worktree reclaims, keyed by the thread's ROOT id (`rootJobId ?? id`, the same
     * reading worktreeRelDir uses — the key the task worktree itself is filed under). report()
     * registers the reclaim here before it starts and drops the entry when it settles; the
     * attempt waits on its root's entry before its startup sync (runJob, issue #126 moved the
     * wait in from the claim loop), so a follow-up claimed while the
     * thread's tree is being removed waits out the removal instead of syncing against it. This
     * closes the race for reclaims and claims that both leave THIS driver; it cannot close it
     * across drivers — docker's documented bound is one driver per daemon (docs/jobs.md), and
     * under kubernetes reclaimWorktree holds the checkout claim for the removal's duration,
     * which is what makes it mutually exclusive with a follow-up's claim-taking sync there.
     */
    const reclaims = new Map<string, Promise<void>>();

    /*
     * The last reclaim-failure line logged per thread root, keyed by root id (issue #344): a row
     * the reclaim cannot settle is re-offered every lease expiry, and an orphaned checkout claim
     * makes every one of those offers refuse identically — 109 identical lines in 24h in the wild.
     * The digest of WHAT refused (the reason plus the held claim's name; deliberately not the
     * claim's age, whose minute rollover is not a state change) is compared by `processReclaim`
     * (loop-reclaim.ts): the first failure logs, and only a change to the digest logs again. A
     * settled row clears its entry, so a later failure of the same thread logs fresh.
     * Process-lifetime like the `reclaims` barrier above — a driver restart re-logs once per
     * stuck root, which is the honest cost of forgetting.
     */
    const reclaimFailureLog = new Map<string, string>();

    /**
     * Everything a running attempt needs from this loop: the board and runner, the driver's own
     * config and gate machinery, its logger and sleeper, the reclaim barrier every attempt's
     * startup sync waits on (see `reclaims` above), and the verdict-reporting entry point below.
     * Built once and handed to every `runJob` (moved to loop-run.ts, issue #223's line-count
     * split): none of these change between attempts, only the job each call carries does.
     */
    const rt: LoopRuntime = {
        board,
        runner,
        config,
        log,
        sleep,
        reclaims,
        syncs,
        report,
        ...(gates ? { gates } : {}),
        ...(stopGraceMs === undefined ? {} : { stopGraceMs }),
        ...(syncWaitMs === undefined ? {} : { syncWaitMs }),
    };
    const handoff = handoverOf(rt);

    /**
     * The verdict is reported, then the task worktree is reclaimed — but only when the thread is
     * DONE, not merely terminal (issue #47, revised): the board answers the verdict AND whether
     * every member of the thread is terminal AND the user has declared it done, in one
     * lease-guarded round trip computed in the same transaction as the verdict. A thread that
     * finished without the user's done keeps its tree — a failed task's tree is exactly what its
     * next turn continues from, and the tree is the user's to free; `POST /api/jobs/:id/done`
     * queues the reclaim itself when the thread is already terminal, so the queue drain below is
     * the ordinary path and this verdict-time reclaim is the one that covers a done declared
     * while a follow-up was still moving. There is no separate thread read left to race a
     * follow-up's insertion: reclaim sits downstream of the verdict and runs only when the answer
     * says done-and-terminal, so a follow-up still queued keeps its tree.
     *
     * The order is a reclaim row owned by this attempt's lease token (issue #821), renewed under it
     * while the removal runs (and never removed unless the first renew holds), acked under it once
     * the removal lands — the ack marks the tree reclaimed, and a lost ack response is replayed for
     * the lease. A refusal, a throw or a refused ack skips the ack and the row returns to the queue
     * when its lease expires: delayed, never lost, and never the verdict's cost. A refused tree
     * stays on the disk (the script deletes only what the sync created).
     *
     * The removal is registered under the thread's ROOT id in the reclaim barrier BEFORE it
     * starts and the entry is dropped when it settles: a follow-up of the same thread claimed by
     * this driver while the removal is in flight then waits it out before its startup sync (see
     * `reclaims`), instead of syncing against a tree mid-deletion.
     */
    async function report(
        job: BoardJob,
        result: Parameters<Board['complete']>[1],
        { after }: { after?: Promise<void> } = {}
    ): Promise<LeaseState> {
        const verdict = await completeWithRetry({ board, config, log, sleep }, job, result);
        if (verdict.conflict) {
            log(
                `job ${job.id}: the board refused the verdict: this attempt staged a different conclusion, which stands`
            );
        }
        const { reclaimId } = verdict;
        if (verdict.state !== 'held' || reclaimId === null) return verdict.state;
        startVerdictReclaim({ board, runner, config, log, sleep, reclaims }, job, { reclaimId, after });
        return verdict.state;
    }

    // Contained here (issue #820): one attempt's throw is that attempt's, logged, never a rejected
    // `start()` or an unhandled rejection that takes every other claim down with the process.
    function track(job: BoardJob): void {
        const promise = runJob(rt, job)
            .catch((e: Error) => log(`job ${job.id}: the attempt threw, leaving it to the lease: ${e.message}`))
            .finally(() => active.delete(promise));
        active.add(promise);
    }

    /**
     * The loop's own view of one claimed reclaim row: the queue worker of `loop-reclaim.ts` fed
     * this loop's board, runner, config, logger, throttle state, and the in-flight barrier —
     * a root with a verdict-time reclaim running holds its claim, and the orphan arm must not
     * reap that one out from under it.
     */
    function handleReclaim(reclaim: Reclaim): Promise<void> {
        return processReclaim(
            {
                board,
                runner,
                config,
                log,
                sleep,
                failureLog: reclaimFailureLog,
                inFlightReclaim: (root) => reclaims.has(root),
            },
            reclaim
        );
    }

    /**
     * Drains the board's worktree-reclaim queue (issue #41), one row at a time: a Remove deleted
     * a thread, or a done landed on an already-terminal one, and this loop is the worker half of
     * taking the tree down. Claim a row and hand it to `handleReclaim`.
     */
    async function drainReclaims(): Promise<void> {
        while (running) {
            let reclaim: Reclaim | null;
            try {
                reclaim = await board.claimReclaim(config.worker);
            } catch (e) {
                log(`reclaim claim failed, retrying: ${(e as Error).message}`);
                await sleep(config.pollMs);
                continue;
            }
            if (!reclaim) {
                await sleep(config.pollMs);
                continue;
            }
            await handleReclaim(reclaim);
        }
    }

    /**
     * Claims one job (or waits out the poll interval when there is none, or the claim itself
     * failed), and either refuses it with a reason or hands it to `track`. The attempt then takes
     * it from here — the reclaim barrier, the checkout sync, the gates re-read and refusals, the
     * gate environment and the run are all runJob's (they moved in from this loop so the
     * attempt's heartbeat and abort signal cover the whole setup: a stop issued while the
     * dashboard says "Waiting for the executor…" now stands the attempt down within one
     * heartbeat poll, issue #126).
     */
    async function claimAndTrack(): Promise<void> {
        let job: BoardJob | null;
        try {
            job = await board.claim(config.worker);
        } catch (e) {
            log(`claim failed, retrying: ${(e as Error).message}`);
            await sleep(config.pollMs);
            return;
        }
        if (!job) {
            await sleep(config.pollMs);
            return;
        }

        // Reported with a reason rather than dropped, so a job this loop cannot run as claimed
        // reaches a terminal state somebody can see instead of being reclaimed on every lease
        // expiry forever.
        const refusal = claimRefusal(job);
        if (refusal) {
            log(`job ${job.id}: ${refusal.log}`);
            await report(job, {
                status: 'failed',
                exitCode: null,
                output: refusal.output,
                failureKind: refusal.config ? 'config' : 'runner_error',
            }).catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
            return;
        }
        track(job);
    }

    return {
        stop() {
            running = false;
        },

        handover: (reason) => handoff.run(reason),

        async start() {
            log(
                `polling ${config.boardUrl} every ${config.pollMs}ms as "${config.worker}", ` +
                    `${config.concurrency} at a time, executor images ` +
                    `claude-code=${config.executorImages[CLAUDE_CODE]}, opencode=${config.executorImages.opencode}`
            );

            // Drains the board's removed-thread queue in parallel with the claim loop. This loop
            // ends when running is set to false (via stop()) — no orphaning a removal mid-reclaim
            // — and its return is awaited after all in-flight jobs settle.
            const draining = drainReclaims();

            while (running) {
                if (active.size >= config.concurrency) {
                    await Promise.race(active);
                    continue;
                }
                await claimAndTrack();
            }

            // Claiming has stopped; let what is already running finish rather than orphaning
            // containers that are mid-edit in a checkout.
            if (active.size) log(`draining ${active.size} running job(s)`);
            await Promise.race([Promise.all(active), handoff.done]);
            await draining;
        },
    };
}
