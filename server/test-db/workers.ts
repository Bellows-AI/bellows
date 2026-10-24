import { availableParallelism } from 'node:os';

/** Upper bound when `TEST_DB_WORKERS` is unset: each worker owns a full database copy. */
const DEFAULT_MAX_WORKERS = 4;

/**
 * How many db-suite files run at once, and so how many worker databases the global setup clones.
 * `TEST_DB_WORKERS=1` runs the files serially. Shared by `vitest.db.config.ts` (the fork cap) and
 * the global setup (the clone count) so the two cannot disagree.
 */
export function testDbWorkers(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.TEST_DB_WORKERS;
    if (raw === undefined || raw === '') return Math.min(DEFAULT_MAX_WORKERS, availableParallelism());
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`TEST_DB_WORKERS must be a positive integer, got "${raw}"`);
    }
    return parsed;
}
