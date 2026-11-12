import { startIntervalLoop } from '../interval-loop.js';
import type { OAuthStore } from './oauth-store.js';

const MS_PER_MINUTE = 60_000;
const OAUTH_SWEEP_INTERVAL_MS = 10 * MS_PER_MINUTE;

/**
 * Runs the OAuth store's expiry sweep now and then on every replica: expired codes, consent transactions and grant
 * families, then DCR clients unused for 30 days, then whatever `alsoPurge` adds. It never overlaps itself and never throws out of the loop; a pass that
 * fails leaves the rows for the next one. The returned stop clears the timer.
 */
export function startOAuthSweep(
    oauth: Pick<OAuthStore, 'purgeExpired' | 'deleteUnusedClients'>,
    timedPass: <T>(loop: string, fn: () => Promise<T>) => Promise<T>,
    intervalMs = OAUTH_SWEEP_INTERVAL_MS,
    /** More expiry work that rides the same pass (the upload capabilities, which only an MCP board mints). */
    alsoPurge: () => Promise<unknown> = async () => undefined
): () => Promise<void> {
    return startIntervalLoop(
        'oauth',
        () =>
            timedPass('oauth_purge', async () => {
                await oauth.purgeExpired();
                await oauth.deleteUnusedClients();
                await alsoPurge();
            }),
        intervalMs,
        { onError: (e) => console.error(`[oauth] purge failed: ${e.message}`) }
    );
}
