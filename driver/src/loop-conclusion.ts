/**
 * How one attempt settles (issue #821), in two halves a verdict lands between: `quiesce` ends the
 * heartbeat and leaves the group standing, `teardown` ends the group and closes the control channel.
 * Each runs once, however many conclusions ask (issue #820). Split out of `loop-run.ts` for that
 * file's line budget; `concludeAttempt` (`loop-fence.ts`) is what orders a verdict between them.
 */

import type { BoardJob } from './board.js';
import type { JobState } from './loop-attempt.js';
import { closeRunControl } from './loop-gates.js';
import { cancelReviews } from './loop-review.js';
import type { LoopRuntime } from './loop-types.js';

export function attemptSettlement(
    rt: LoopRuntime,
    job: BoardJob,
    state: JobState,
    beating: Promise<void>
): { quiesce: () => Promise<void>; settle: () => Promise<void> } {
    let quiescing: Promise<void> | null = null;
    let tearingDown: Promise<void> | null = null;
    const quiesce = () =>
        (quiescing ??= (async () => {
            state.finished = true;
            // In flight for a drain's handover (`loop.ts`) until here.
            rt.live?.delete(job.id);
            if (state.graceTimer) clearTimeout(state.graceTimer);
            state.wake();
            await beating;
            // A review still running ends with its caller: cancelled, its row settled, the reviewer released.
            await cancelReviews(state);
        })());
    const teardown = () =>
        (tearingDown ??= (async () => {
            // The attempt's task group (issue #771) lives from its sync to here, not to the agent's
            // exit: its supervisor serves the probe, the helpers and the publish. It ends while the
            // control channel its order travels is still open — and never for an attempt handed over
            // by a drain, nor one whose verdict the board never took (`keepGroup`): either runner is
            // left for the next claim to adopt.
            if (!state.handedOver && !state.keepGroup) await rt.runner.finish(job).catch(() => undefined);
            closeRunControl(rt, state);
        })());
    return {
        quiesce,
        settle: async () => {
            await quiesce();
            await teardown();
        },
    };
}
