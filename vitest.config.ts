import { readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

/** Component suites driven through Testing Library under jsdom (`web/test/dom.tsx`). */
const DOM_TESTS = 'web/test/**/*.dom.test.tsx';

/** One project per package; the keys are the names `--project` takes. */
const PACKAGE_TESTS: Record<string, string[]> = {
    core: ['core/test/**/*.test.ts'],
    server: ['server/test/**/*.test.ts'],
    // Renders panels with react-dom/server, so no DOM and no browser is needed. `.test.ts` too:
    // web/test holds non-component suites (executor config validation) a `.tsx`-only pattern dropped.
    web: ['web/test/**/*.test.tsx', 'web/test/**/*.test.ts'],
    // Every docker call and every board request is injected: offline, no daemon, no network.
    driver: ['driver/test/**/*.test.ts'],
    cli: ['cli/test/**/*.test.ts'],
};
const PACKAGES = Object.keys(PACKAGE_TESTS);

/** Spawning files, pinned against the tree by `core/test/vitest-projects.test.ts`. */
const SPAWN_TESTS: string[] = (
    JSON.parse(readFileSync(new URL('./vitest.spawn-tests.json', import.meta.url), 'utf8')) as { tests: string[] }
).tests;

export default defineConfig({
    test: {
        projects: [
            ...PACKAGES.map((name) => ({
                extends: true,
                test: {
                    name,
                    include: PACKAGE_TESTS[name],
                    exclude: [...configDefaults.exclude, DOM_TESTS, ...SPAWN_TESTS],
                },
            })),
            // Every file that spawns a real process (`vitest.spawn-tests.json`): git fixtures, shell
            // scripts, a tree-wide biome, the lane harnesses. Slow and CPU-bound, so a package's
            // in-process suites run without it; `npm test` runs it with the rest.
            {
                extends: true,
                test: {
                    name: 'spawn',
                    include: SPAWN_TESTS,
                },
            },
            {
                extends: true,
                test: {
                    name: 'dom',
                    include: [DOM_TESTS],
                    environment: 'jsdom',
                    // The threads pool, whose root options isolate every file: Testing Library binds
                    // `screen` to the document it was first imported under, so the forks pool's
                    // shared module graph would query a previous file's dead jsdom.
                    pool: 'threads',
                },
            },
        ],
        pool: 'forks',
        poolOptions: {
            forks: {
                // Default is one fork per core; watch idles hot without a cap.
                minWorkers: 1,
                maxWorkers: 2,
            },
            // The `dom` project's pool only; a project-level `isolate` does not reach the pool. One
            // thread: it runs beside the forks, and more starved their RPC under a full run.
            threads: {
                minThreads: 1,
                maxThreads: 1,
                isolate: true,
            },
        },
        // The suite is spawn-heavy — real git fixtures, node children, loopback listeners, a
        // tree-wide biome pass — and vitest's 5s default assumes a quiet box. Two runs sharing
        // one machine (an agent's suite beside the gate's) starve the workers enough to tip
        // tests that pass in isolation, and the failures rotated across files run to run.
        // 30s bounds a genuinely hung test while absorbing contention; hooks get the same
        // headroom, since the git fixture builders are the heaviest spawns of all.
        testTimeout: 30_000,
        hookTimeout: 30_000,
        // Suites inject their own state, so sharing one worker costs nothing.
        isolate: false,
        // A core watch build rewrites core/dist while vitest watches; re-running
        // on it invalidates the module graph for every server/web test.
        watchExclude: ['**/node_modules/**', '**/dist/**'],
        coverage: {
            provider: 'v8',
            // 'lcov' is what Sonar ingests; 'text' is for reading here. Both, or CI is silent.
            reporter: ['text', 'lcov'],
            include: ['core/src/**', 'server/src/**', 'web/src/**', 'driver/src/**', 'cli/src/**'],
            // Measured but never executed by this suite, so they only dilute the percentage.
            exclude: ['**/*.d.ts', 'web/src/main.tsx', 'server/src/index.ts', 'cli/src/index.ts'],
        },
    },
});
