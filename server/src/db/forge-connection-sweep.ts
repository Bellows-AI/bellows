import { startIntervalLoop } from '../interval-loop.js';
import { logger } from '../log.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { sweepRemovedConnections } from './forge-connections.js';
import type { Sql } from 'postgres';

export const FORGE_CONNECTION_SWEEP_INTERVAL_MS = 60_000;

/**
 * Finishes, on every replica and on the cross-org pool, each GitLab connection removal a lost process or an
 * unavailable secret store left tombstoned. Returns the stop.
 */
export function startForgeConnectionSweep({
    sql,
    secrets,
    intervalMs = FORGE_CONNECTION_SWEEP_INTERVAL_MS,
}: {
    sql: Sql;
    secrets: SecretStore;
    intervalMs?: number;
}): () => Promise<void> {
    const log = logger('forge-connections');
    return startIntervalLoop(
        'forge-connections',
        () =>
            sweepRemovedConnections({ sql, secrets, secretLog: (d) => log.warn({ diagnostic: d }, 'secret cleanup') }),
        intervalMs,
        { onError: (e) => log.error({ err: e }, 'sweep failed') }
    );
}
