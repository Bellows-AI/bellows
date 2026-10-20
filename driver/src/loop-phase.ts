/**
 * The one attempt phase and the one first-wins ending (issue #828). Every writer of either goes
 * through `transition` and `recordEnding`, and each change writes exactly one structured line, so an
 * attempt's phase path can be rebuilt from its log alone.
 */

export type AttemptPhase = 'setup' | 'launched' | 'concluding' | 'ended';

export type EndingKind = 'stop' | 'lost' | 'removed' | 'handover';

/** What ended the attempt where it stands, and when; the first one recorded is the one that counts. */
export interface Ending {
    kind: EndingKind;
    at: number;
}

/** One change of phase (`from` !== `to`) or one recorded ending (`from` === `to`). */
export interface AttemptTransition {
    from: AttemptPhase;
    to: AttemptPhase;
    ending: EndingKind | null;
    at: number;
}

/** What the setters read and write; `JobState` carries it. */
export interface PhaseState {
    phase: AttemptPhase;
    ending: Ending | null;
    trace: (transition: AttemptTransition) => void;
}

/** The one structured log line for a transition; every writer of the attempt path uses it. */
export const transitionLine = (job: { id: string; claimSeq: number }, t: AttemptTransition): string =>
    JSON.stringify({ event: 'attempt-transition', job: job.id, claimSeq: job.claimSeq, ...t });

/** Logs a claim refused before any attempt state exists, then its whole path: one setup>ended line. */
export function logRefusal(log: (line: string) => void, job: { id: string; claimSeq: number }, message: string): void {
    log(message);
    log(transitionLine(job, { from: 'setup', to: 'ended', ending: null, at: Date.now() }));
}

const ORDER: readonly AttemptPhase[] = ['setup', 'launched', 'concluding', 'ended'];

/** Records how the attempt ended; answers whether this call was the one that did (first wins). */
export function recordEnding(state: PhaseState, kind: EndingKind): boolean {
    if (state.ending !== null) return false;
    const at = Date.now();
    state.ending = { kind, at };
    state.trace({ from: state.phase, to: state.phase, ending: kind, at });
    return true;
}

/** Moves the attempt forward to `to`; answers whether it moved (a repeat or a step back is a no-op). */
export function transition(state: PhaseState, to: AttemptPhase): boolean {
    if (ORDER.indexOf(to) <= ORDER.indexOf(state.phase)) return false;
    const from = state.phase;
    state.phase = to;
    state.trace({ from, to, ending: state.ending?.kind ?? null, at: Date.now() });
    return true;
}

/** Whether the lease is no longer this attempt's: lost to the board, or handed back by a drain. */
export const lostOf = (state: PhaseState): boolean =>
    state.ending?.kind === 'lost' || state.ending?.kind === 'handover';
