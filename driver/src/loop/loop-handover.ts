/** A drain's hand-over of the attempts in flight: each is registered live, and handed over on the stop signal. */
import type { BoardJob } from '../board/board.js';
import type { JobState } from './loop-attempt.js';
import { recordEnding } from './loop-phase.js';
import type { LoopRuntime } from './loop-types.js';

/**
 * One attempt handed over: the intent is recorded and the attempt told to stop; its own chain ends
 * it as an interruption (`end`, `loop-conclusion.ts`), the runner left for the next claim.
 */
export function handOver(state: JobState, reason: string): void {
    if (!recordEnding(state, 'handover')) return;
    state.handoverReason = reason;
    state.abortNow();
    state.wake();
    state.signalHandover();
}

/** Registers the attempt as in flight for a drain's handover; answers what to call once `runJob` is over. */
export function registerLive(rt: LoopRuntime, job: BoardJob, state: JobState): () => void {
    let over: () => void = () => {};
    rt.live?.set(job.id, {
        job,
        state,
        over: new Promise<void>((resolve) => {
            over = resolve;
        }),
    });
    // A claim answered after the handover began missed its snapshot: it is handed over here, or it
    // would hold its lease until it lapsed.
    if (rt.handoverReason !== undefined) handOver(state, rt.handoverReason);
    return over;
}
