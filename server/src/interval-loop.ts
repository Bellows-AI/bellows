/**
 * Runs `pass` now and then on an interval, never overlapping itself; a throwing pass is logged (by default under
 * `label`, or by `onError`) and the next tick is the retry. Shared by every background loop on the board.
 *
 * The returned stop is the shutdown half (BEL-322): it clears the timer, aborts the `signal` the running pass was
 * handed so it ends between items, and resolves once that pass has settled, so the pool is never closed under it.
 * A stop called twice is the same promise. `immediate: false` skips the startup pass.
 */
export function startIntervalLoop(
    label: string,
    pass: (signal: AbortSignal) => Promise<unknown>,
    intervalMs: number,
    {
        onError = (e: Error) => console.error(`[${label}] pass failed: ${e.message}`),
        immediate = true,
    }: { onError?: (e: Error) => void; immediate?: boolean } = {}
): () => Promise<void> {
    const controller = new AbortController();
    let inFlight: Promise<void> | undefined;
    const tick = () => {
        if (inFlight || controller.signal.aborted) return;
        inFlight = (async () => {
            try {
                await pass(controller.signal);
            } catch (e) {
                onError(e as Error);
            } finally {
                inFlight = undefined;
            }
        })();
    };
    if (immediate) tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    let stopped: Promise<void> | undefined;
    return () => {
        stopped ??= (async () => {
            clearInterval(timer);
            controller.abort();
            await inFlight;
        })();
        return stopped;
    };
}
