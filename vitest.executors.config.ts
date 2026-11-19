import root from './vitest.config.ts';

/**
 * The coverage thresholds of the board/driver/telemetry control plane, over the root config's
 * projects, pool and fork cap: `npm run test:coverage:executors` passes `test:executors`' files.
 * Database lease semantics remain in `npm run test:db`; real Docker and cluster boundaries remain
 * in `npm run test:jobs` and `npm run test:k8s`. Its own pool (shared forks, an unread fork cap,
 * spawning files beside in-process ones) timed out a different spawn-heavy test in half its runs.
 */
export default {
    ...root,
    test: {
        ...root.test,
        // Replaced, not merged: the root's package-wide include would dilute the thresholds.
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            include: [
                'driver/src/**',
                'server/src/routes/jobs/jobs.ts',
                'server/src/routes/ingest.ts',
                'server/src/telemetry/**',
                'core/src/telemetry.ts',
            ],
            // Entrypoints and content-injected container scripts execute in other processes, so
            // V8 cannot attribute them here. Their behavior is exercised by scripts/image suites.
            exclude: [
                '**/*.d.ts',
                'driver/src/index.ts',
                'driver/src/scripts/**',
                // These stores require the real database suite rather than an offline fake.
                'server/src/telemetry/postgres-client.ts',
                'server/src/telemetry/store.ts',
            ],
            thresholds: {
                lines: 90,
                statements: 90,
                functions: 90,
                branches: 85,
            },
        },
    },
};
