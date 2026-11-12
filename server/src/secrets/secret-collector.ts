import { startIntervalLoop } from '../interval-loop.js';

/** How often a replica sweeps unreferenced secret versions and prunes finished operations (docs/secrets.md). */
export const SECRET_COLLECT_INTERVAL_MS = 600_000;

/**
 * Collects once now — the startup pass — and then on an interval. A pass never overlaps the previous
 * one and never throws: every delete re-checks its own guard, so a missed pass only delays cleanup
 * and the next tick is the retry. Safe on every replica. Returns the stop.
 */
export function startSecretCollector(
    store: { collect(): Promise<unknown> },
    intervalMs = SECRET_COLLECT_INTERVAL_MS
): () => Promise<void> {
    return startIntervalLoop('secrets', () => store.collect(), intervalMs, {
        onError: (e) => console.error(`[secrets] collect failed: ${e.message}`),
    });
}
