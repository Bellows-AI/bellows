import { readFileSync } from 'node:fs';
import type { DriverConfig } from './config.js';

/** Every credential the board issues starts with this (the board's `DRIVER_CREDENTIAL_PREFIX`, copied). */
export const DRIVER_CREDENTIAL_PREFIX = 'drv_';

/** Whether a value is one the board could accept as a driver credential: `drv_` and no whitespace. */
export const isDriverCredential = (value: string): boolean =>
    value.startsWith(DRIVER_CREDENTIAL_PREFIX) && value.length > DRIVER_CREDENTIAL_PREFIX.length && !/\s/.test(value);

/**
 * The credential this driver presents on every board call (docs/auth.md). DRIVER_CREDENTIAL is a fixed value.
 * DRIVER_CREDENTIAL_FILE is read again for every call, so a rotation takes effect without a restart: the kubelet
 * swaps a mounted Secret's file in place, and the old credential works through the rotation's overlap window
 * meanwhile. A read that cannot answer (the file missing mid-swap, empty or malformed) keeps the last good value —
 * an unconfirmed read never drops a working credential. At start the file must hold one, or the driver refuses
 * to run rather than poll into 401s.
 */
export function boardCredentialOf(
    config: Pick<DriverConfig, 'boardCredential' | 'boardCredentialFile'>,
    read: (path: string) => string = (path) => readFileSync(path, 'utf8')
): () => string {
    const path = config.boardCredentialFile;
    if (path === null) return () => config.boardCredential;
    const fresh = (): string | null => {
        try {
            const value = read(path).trim();
            return isDriverCredential(value) ? value : null;
        } catch {
            return null;
        }
    };
    const first = fresh();
    if (first === null) {
        throw new Error(`DRIVER_CREDENTIAL_FILE ${path} holds no readable driver credential (drv_…)`);
    }
    let last = first;
    return () => {
        last = fresh() ?? last;
        return last;
    };
}
