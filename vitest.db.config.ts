import { defineConfig } from 'vitest/config';
import { testDbWorkers } from './server/test-db/workers.js';

/**
 * Deliberately separate from vitest.config.ts. `npm test` must stay offline and DB-free, so
 * the SQL and the migration runner have no coverage there — a real tradeoff, written down in
 * AGENTS.md rather than left to be discovered.
 *
 *     docker compose up -d postgres
 *     DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db
 *
 * Files run in parallel, each worker on its own clone of a once-migrated template
 * (server/test-db/global-setup.ts). `TEST_DB_WORKERS=1` runs them serially.
 */
export default defineConfig({
    test: {
        include: ['server/test-db/**/*.test.ts'],
        pool: 'forks',
        poolOptions: { forks: { minForks: 1, maxForks: testDbWorkers() } },
        fileParallelism: true,
        globalSetup: ['server/test-db/global-setup.ts'],
        setupFiles: ['server/test-db/setup-worker.ts'],
        testTimeout: 30_000,
    },
});
