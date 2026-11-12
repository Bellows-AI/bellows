import { startIntervalLoop } from './interval-loop.js';
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
): () => Promise<void> {
    return startIntervalLoop('batches', () => orgs.reconcileBatches(), intervalMs, {
        onError: (e) => console.error(`[batches] reconcile failed: ${e.message}`),
    });
}
