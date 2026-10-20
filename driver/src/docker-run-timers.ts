import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { tickCacheWatch } from './docker-close-read.js';
import type { ExecDocker } from './docker-runner-support.js';
import { OPENCODE } from './executors.js';
import type { KillLedger } from './kill-ledger.js';
import type { DeadlineRegistry } from './run-deadline.js';

/**
 * The in-process timers of one docker run, and the one call that ends them. Both kill the run's
 * group, so both end the moment the run does — and the moment it is abandoned to the next holder
 * (#829): a group this process no longer owns is never killed from here, nor a kill written for the
 * next holder to read.
 */
export function armRunTimers(
    deps: { deadlines: DeadlineRegistry; ledger: KillLedger },
    run: { execDocker: ExecDocker; config: DriverConfig; job: BoardJob; backstopMs: number },
    cacheState: { cacheLost: string | null },
    kills: { backstop: () => void; cacheLost: (job: BoardJob) => Promise<void> }
): () => void {
    const { execDocker, config, job } = run;
    // The BACKSTOP: the supervisor ends the agent at the run budget itself (its exit 124), so
    // this only fires for a group whose supervisor stopped doing that — the budget plus the
    // wind-down — and then kills all of it.
    const deadline = deps.deadlines.start(job.leaseToken, run.backstopMs, kills.backstop);

    /*
     * The cache watch polls on a period while the run is live. Each tick is one
     * throwaway probe container; a probe that fails once (the daemon is busy, the
     * session is not there yet) just waits for the next tick, and the trigger itself
     * needs three consecutive damning turns, so no single answer — or no single fluke —
     * kills anything. The kill is this attempt's own, label-scoped like every other;
     * the task-type check below keeps it on opencode, and config keeps it docker-only.
     */
    let cacheTimer: NodeJS.Timeout | null = null;
    if (config.cacheWatch && job.executorType === OPENCODE) {
        cacheTimer = setInterval(() => {
            void tickCacheWatch({ execDocker, config, job, kill: kills.cacheLost }, cacheState);
        }, config.cacheWatchPollMs);
    }

    const abandoned = deps.ledger.abandoned(job);
    const done = () => {
        abandoned.removeEventListener('abort', done);
        deadline.clear();
        if (cacheTimer) clearInterval(cacheTimer);
    };
    if (abandoned.aborted) done();
    else abandoned.addEventListener('abort', done, { once: true });
    return done;
}
