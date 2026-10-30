/**
 * Runs `pass` now and then on an interval, never overlapping itself; a throwing pass is logged under `label`
 * and the next tick is the retry. Returns the stop, which clears the timer only. Shared by every outbox
 * delivery loop (commerce, notifications).
 */
export function startIntervalLoop(label: string, pass: () => Promise<void>, intervalMs: number): () => void {
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await pass();
        } catch (e) {
            console.error(`[${label}] pass failed: ${(e as Error).message}`);
        } finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
