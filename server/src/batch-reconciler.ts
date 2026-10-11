import type { OrgRegistry } from './orgs.js';

/** How often the board looks for a batch a missed callback could have stranded (docs/batches.md). */
export const BATCH_RECONCILE_INTERVAL_MS = 5000;

/**
 * Reconciles every org's open batches once now — the startup pass — and then on an interval. A pass
 * never overlaps the previous one, and never throws: the next tick is the retry. Returns the stop.
 */
export function startBatchReconciler(
    orgs: Pick<OrgRegistry, 'reconcileBatches'>,
    intervalMs = BATCH_RECONCILE_INTERVAL_MS
): () => void {
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await orgs.reconcileBatches();
        } catch (e) {
            console.error(`[batches] reconcile failed: ${(e as Error).message}`);
        } finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
