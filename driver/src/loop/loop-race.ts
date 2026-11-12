/** The loser side of every setup race: the stand-down resolved, the step did not. */
const RACE_LOST = Symbol('raceStep: the stand-down won');

/**
 * Races one slow setup step against the attempt's stand-down, so a Stop (or a lost lease, or a
 * Remove) observed while the driver is "waiting for the executor" ends the wait within a
 * heartbeat's setup poll instead of the step's own unbounded duration. Answers null
 * when the stand-down won and the step is STILL RUNNING: the caller stands the attempt down and
 * the step is abandoned to its own cleanup — which is why a rejection is swallowed here, the
 * abandoned step's finally is the only cleanup it needs and its verdict is nobody's business
 * anymore. A step that finished first answers `{ value }` even when the stand-down landed in the
 * same instant — the caller's own flag check decides.
 */
export async function raceStep<T>(signal: AbortSignal, step: Promise<T>): Promise<{ value: T } | null> {
    // A side-band subscriber, so the loser of the race can never become an unhandled rejection:
    // subscribing neither consumes the step from the race nor changes its result. First, because
    // the check below abandons the step with nobody left to read it — and an abandoned step that
    // rejects must not take the driver with it.
    step.catch(() => {});
    // Already stood down: never even wait for the step, which is still running with nobody left
    // to read it.
    if (signal.aborted) return null;
    let onAbort: () => void = () => {};
    const lost = new Promise<typeof RACE_LOST>((resolve) => {
        onAbort = () => resolve(RACE_LOST);
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const outcome: T | typeof RACE_LOST = await Promise.race([step, lost] as const);
        return outcome === RACE_LOST ? null : { value: outcome };
    } finally {
        // The attempt has as many steps as it has phases, and each subscribes: without this the
        // signal would keep every step that finished first alive until the attempt ends.
        signal.removeEventListener('abort', onAbort);
    }
}
