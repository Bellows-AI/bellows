import { BASE_URL_ENV, workerUrl } from './database-names.js';

/**
 * Runs in every test file's process: points `DATABASE_URL` at this worker's own database copy, so
 * the harness and the suites that read the variable directly never share a database with another
 * worker. Derived from the base URL the global setup recorded, so it is idempotent.
 */
const base = process.env[BASE_URL_ENV];
if (base) {
    const poolId = Number(process.env.VITEST_POOL_ID);
    process.env.DATABASE_URL = workerUrl(base, poolId);
}
