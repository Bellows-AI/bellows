/**
 * The driver's own lease clock. The board expires a lease the driver stopped renewing, so a
 * driver that cannot reach the board must stop acting on the run at the same moment: it departs and
 * leaves the group for the next claim to adopt. The clock is a timer of its own, never a check after a
 * failed beat — a beat that never returns must still depart at expiry.
 */

import { fenced } from '../board/board-retry.js';
import type { BoardJob } from '../board/board.js';
import type { JobState } from './loop-attempt.js';
import { recordEnding } from './loop-phase.js';
import type { LoopRuntime } from './loop-types.js';

/**
 * One beat on a lease clock: fenced on its signal, so a transport that ignores its timeout cannot hold the beat
 * past the lapse, and renewing the clock from the beat's SEND time once the board held it (a slow ack never
 * extends it).
 */
export async function leasedBeat<V>(clock: LeaseClock, send: () => Promise<V>): Promise<V> {
    const sentAt = Date.now();
    const verdict = await fenced(clock.signal, send);
    if (typeof verdict === 'object') clock.renewed(sentAt);
    return verdict;
}

/** A timer later than this share of the lease is a host stall, not a lapse. */
const STALL_DIVISOR = 10;
/** The beat period a stalled driver gets to answer, as a share of the lease (`heartbeatPeriodMs`). */
const STALL_BEATS = 3;

const MS_PER_SECOND = 1_000;

export interface LeaseClock {
    /** Aborted once, at the lapse or at `stop`; a lapse is final, a later ack never revives it. */
    readonly signal: AbortSignal;
    /** A beat sent at `sentAt` was answered held: the lease now runs one full lease from the SEND time. */
    renewed: (sentAt: number) => void;
    /** Clears the timer and aborts the signal, releasing every call fenced on it; called once the attempt is over. */
    stop: () => void;
}

/** Starts a clock that lapses `leaseMs` after `startedAt` unless `renewed` moves it on; `onLapse` runs once. */
export function leaseClock(leaseMs: number, startedAt: number, onLapse: () => void): LeaseClock {
    const lapsed = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const arm = (sentAt: number): void => {
        if (timer !== null) clearTimeout(timer);
        const dueAt = sentAt + leaseMs;
        timer = setTimeout(
            () => {
                timer = null;
                if (stopped || lapsed.signal.aborted) return;
                // A timer this late means the host stalled, and a stalled driver sent no beat and acted on
                // nothing: the lease is judged in loop time, so the next beat decides it (a lost one answers
                // `lost`). It gets one beat period (a lease third) from here to land, never a whole lease more.
                if (Date.now() - dueAt > leaseMs / STALL_DIVISOR)
                    return arm(Date.now() - leaseMs + leaseMs / STALL_BEATS);
                lapsed.abort();
                onLapse();
            },
            Math.max(0, dueAt - Date.now())
        );
        timer.unref?.();
    };
    arm(startedAt);
    return {
        signal: lapsed.signal,
        renewed: (sentAt) => {
            if (stopped || lapsed.signal.aborted) return;
            arm(sentAt);
        },
        stop: () => {
            stopped = true;
            if (timer !== null) clearTimeout(timer);
            timer = null;
            lapsed.abort();
        },
    };
}

/**
 * Starts the attempt's lease clock. At the lapse the board has expired this driver's lease: the attempt
 * stands down as lost WITHOUT a verdict (the next claim adopts what survived) and acts at once — it never
 * waits on a beat that may not return, and it never passes `beyondVerdicts`.
 */
export function armLeaseClock(rt: LoopRuntime, job: BoardJob, state: JobState): void {
    state.leaseExpiry = leaseClock(rt.config.leaseSeconds * MS_PER_SECOND, Date.now(), () =>
        lapseLease(rt, job, state)
    );
}

/** The lease clock lapsed: the lost-lease stand-down, taken by the driver itself. First-wins with a real verdict. */
function lapseLease(rt: LoopRuntime, job: BoardJob, state: JobState): void {
    if (state.phase === 'ended') return;
    // Concluding (or already down for another reason): the fence on the conclusion's board calls is the
    // whole effect; the ending recorded here makes the teardown leave the group for the next claim.
    if (state.phase === 'concluding') {
        if (recordEnding(state, 'lost')) {
            rt.log(`job ${job.id}: lease lapsed, board unreachable; the conclusion is left for the next claim`);
        }
        return;
    }
    if (!recordEnding(state, 'lost')) return;
    rt.log(`job ${job.id}: lease lapsed, board unreachable; the attempt stands down`);
    state.abortNow();
    if (state.launched) {
        // Past the launch the runner is the next claim's to adopt: nothing here kills it or closes its tokens.
        state.wake();
        state.signalHandover();
        return;
    }
    // Before the launch no agent runs. The stand-down ends the setup and the teardown finishes the group: the
    // lapse is measured from a beat's SEND time, so it can land a round trip before the board's own expiry, and
    // a kill then would end an attempt the board still holds (an unconfirmed read licenses no delete).
    state.wake();
}
