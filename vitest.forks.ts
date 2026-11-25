import { availableParallelism } from 'node:os';

/** The most forks a run uses by default; why six is at `poolOptions.forks` in `vitest.config.ts`. */
const MAX_FORKS = 6;

/**
 * Forks for every run of the root config: vitest's own default (one per core minus one), never above
 * MAX_FORKS, unless `TEST_FORKS` names the count. The gates (`.bellows.yaml`) set it: in a microVM runner
 * six forks reporting to one vitest process starved that process, and every worker's RPC timed out
 * (`Timeout calling "onTaskUpdate"`) with every test passed.
 */
export function testForks(env: NodeJS.ProcessEnv = process.env, cpus = availableParallelism()): number {
    const raw = env.TEST_FORKS;
    if (raw === undefined || raw === '') return Math.max(1, Math.min(MAX_FORKS, cpus - 1));
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`TEST_FORKS must be a positive integer, got "${raw}"`);
    }
    return parsed;
}
