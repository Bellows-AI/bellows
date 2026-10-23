import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The planner behind `npm run test:changed`; fixtures stand in for git, so nothing here spawns. */
interface Step {
    label: string;
    run?: string[];
    vitest?: string[];
}
interface PlanInput {
    base: string;
    changed: string[];
    spawn: string[];
    namedBy: (names: string[]) => string[];
    importers: (files: string[]) => string[];
}
const SCRIPT = new URL('../../scripts/test-changed.mjs', import.meta.url).href;
const { plan, reverseImports, DIRECTORY_READERS } = (await import(/* @vite-ignore */ SCRIPT)) as {
    plan: (input: PlanInput) => Step[];
    reverseImports: (texts: Record<string, string>) => (files: string[]) => string[];
    DIRECTORY_READERS: [RegExp, string[]][];
};

const SPAWN = ['driver/test/scripts-gate-shell.test.ts', 'core/test/biome.test.ts'];
const NAMED: Record<string, string[]> = {
    'metrics.md': ['core/test/docs.terminology.test.ts', 'driver/test/k8s-docs.test.ts'],
    'gate-loop.sh': ['driver/test/scripts-gate-shell.test.ts'],
    'helper-reader.sql': ['server/test/fixtures/reader.ts', 'server/test/job-store.test.ts'],
    'job-limits.ts': ['driver/test/board.test.ts'],
    'sessions.json': ['core/test/task-usage.test.ts'],
};
const lookup = (names: string[]) => names.flatMap((name) => NAMED[name] ?? []);
const run = (changed: string[], namedBy = lookup, importers = (_files: string[]): string[] => []): Step[] =>
    plan({ base: 'abc123', changed, spawn: SPAWN, namedBy, importers });
const vitestArgs = (steps: Step[]) => steps.flatMap((step) => (step.vitest ? [step.vitest] : []));

describe('test:changed plan', () => {
    it('follows the import graph across every project and nothing else for a driver module', () => {
        const steps = run(['driver/src/loop.ts']);
        expect(steps.some((step) => step.run)).toBe(false);
        expect(vitestArgs(steps)[0]).toEqual([
            'run',
            '--changed',
            'abc123',
            '--passWithNoTests',
            ...['core', 'server', 'web', 'driver', 'cli', 'dom', 'spawn'].flatMap((name) => ['--project', name]),
        ]);
        // Beside the graph, only the suites that scan driver/src without importing from it.
        expect(vitestArgs(steps)[1]).toEqual([
            'run',
            'core/test/polling-authority.test.ts',
            'driver/test/k8s.test.ts',
            'driver/test/loop-fence.test.ts',
        ]);
        expect(steps).toHaveLength(2);
    });

    it('runs only the suites that name a changed doc, for a docs-only branch', () => {
        const steps = run(['docs/metrics.md']);
        expect(vitestArgs(steps).at(-1)).toEqual([
            'run',
            'core/test/docs.terminology.test.ts',
            'driver/test/k8s-docs.test.ts',
        ]);
        expect(steps).toHaveLength(2);
    });

    it('builds core and runs every server and web suite when core/src changed', () => {
        const steps = run(['core/src/metrics.ts']);
        expect(steps[0]?.run).toEqual(['npm', 'run', 'build', '-w', 'core']);
        expect(steps[1]?.vitest).toEqual(['run', '--project', 'server', '--project', 'web', '--project', 'dom']);
        const graph = steps[2]?.vitest ?? [];
        expect(graph).toContain('--changed');
        expect(graph).not.toContain('server');
        expect(graph).toContain('spawn');
    });

    it('does not rerun a server suite the core step already runs, but keeps a driver suite', () => {
        const steps = run(['core/src/metrics.ts', 'gate-loop.sh'], () => [
            'server/test/job-store.test.ts',
            'driver/test/scripts-gate-shell.test.ts',
        ]);
        expect(vitestArgs(steps).at(-1)).toEqual([
            'run',
            'core/test/core-index.test.ts',
            'core/test/polling-authority.test.ts',
            'driver/test/scripts-gate-shell.test.ts',
        ]);
    });

    it('routes a test helper that reads a changed file through vitest related', () => {
        const steps = run(['server/migrations/helper-reader.sql']);
        // The migration is not a graph file; only the unit test is run directly, the helper via related.
        expect(vitestArgs(steps).at(-2)).toEqual([
            'run',
            'core/test/migrations.sql.test.ts',
            'server/test/job-store.test.ts',
        ]);
        expect(vitestArgs(steps).at(-1)).toEqual(['related', '--run', 'server/test/fixtures/reader.ts']);
    });

    it('maps a changed script to the spawn suite that names it', () => {
        const steps = run(['driver/src/scripts/gate-loop.sh']);
        expect(vitestArgs(steps).at(-1)).toContain('driver/test/scripts-gate-shell.test.ts');
        expect(vitestArgs(steps).at(-1)).toContain('driver/test/scripts.test.ts');
    });

    it('finds a suite that reads a changed TypeScript source or a test fixture by path', () => {
        const steps = run(['server/src/routes/jobs/job-limits.ts', 'core/test/fixtures/sessions.json']);
        expect(vitestArgs(steps).at(-1)).toEqual([
            'run',
            'core/test/polling-authority.test.ts',
            'core/test/task-usage.test.ts',
            'driver/test/board.test.ts',
            'server/test/import-boundaries.test.ts',
        ]);
    });

    it('finds the suite that launches a changed test fixture by path', () => {
        const steps = run(['driver/test/fixtures/suspend-outage.ts'], (names) =>
            names.includes('suspend-outage.ts') ? ['driver/test/loop-containment.test.ts'] : []
        );
        expect(vitestArgs(steps).at(-1)).toContain('driver/test/loop-containment.test.ts');
    });

    it('follows a changed source, through any depth of imports, into a fixture the suites launch by path', () => {
        const importers = reverseImports({
            'driver/src/loop-run.ts': '',
            'driver/src/loop.ts': "import { run } from './loop-run.js';",
            'driver/test/fixtures/suspend-outage.ts': "import { loop } from '../../src/loop.js';",
            'driver/test/loop.test.ts': "import { loop } from '../src/loop.js';",
        });
        expect(importers(['driver/src/loop-run.ts']).sort()).toEqual([
            'driver/src/loop.ts',
            'driver/test/fixtures/suspend-outage.ts',
            'driver/test/loop.test.ts',
        ]);
        const byName: Record<string, string[]> = { 'suspend-outage.ts': ['driver/test/loop-containment.test.ts'] };
        const steps = run(
            ['driver/src/loop-run.ts'],
            (names) => names.flatMap((name) => byName[name] ?? []),
            importers
        );
        expect(vitestArgs(steps).at(-1)).toContain('driver/test/loop-containment.test.ts');
    });

    it('runs a suite that enumerates the changed directory though it never names the file', () => {
        const steps = run(['server/migrations/999_new.sql']);
        expect(vitestArgs(steps).at(-1)).toEqual(['run', 'core/test/migrations.sql.test.ts']);
    });

    it('runs the server and web spawn suites too when core changed', () => {
        const steps = plan({
            base: 'abc123',
            changed: ['core/src/metrics.ts'],
            spawn: [...SPAWN, 'server/test/local-origin-plan.test.ts'],
            namedBy: lookup,
            importers: () => [],
        });
        expect(vitestArgs(steps)).toContainEqual(['run', 'server/test/local-origin-plan.test.ts']);
    });

    it('keeps every directory reader on disk', () => {
        for (const [, tests] of DIRECTORY_READERS) {
            for (const test of tests) expect(existsSync(new URL(`../../${test}`, import.meta.url)), test).toBe(true);
        }
    });

    it('routes the paths whose scanners import nothing from them', () => {
        const scanners = (path: string) => {
            const steps = plan({
                base: 'abc123',
                changed: [path],
                spawn: SPAWN,
                namedBy: () => [],
                importers: () => [],
            });
            return vitestArgs(steps).at(-1)?.slice(1) ?? [];
        };
        expect(scanners('docs/design-system/composer.md')).toContain('web/test/styles.test.ts');
        expect(scanners('charts/factory-local-state/templates/postgres.yaml')).toContain(
            'core/test/docs.eks-storage.test.ts'
        );
        expect(scanners('server/src/routes/jobs/job-limits.ts')).toContain('core/test/polling-authority.test.ts');
        expect(scanners('server/test-db/job-store.fairness.test.ts')).toContain('server/test/test-db.harness.test.ts');
        expect(scanners('server/src/routes/jobs/job-limits.ts')).toContain('server/test/import-boundaries.test.ts');
        expect(scanners('scripts/stub-agent.sh')).toContain('server/test/test-jobs.harness.test.ts');
        expect(scanners('web/test/panels.render.test.tsx')).toContain('web/test/no-shared-module-spies.test.ts');
        expect(scanners('driver/test/fixtures/new-helper.ts')).toContain('core/test/vitest-projects.test.ts');
        expect(scanners('driver/test/brand-new.test.ts')).toContain('core/test/vitest-projects.test.ts');
    });

    it('plans only the graph step for an empty change', () => {
        expect(vitestArgs(run([]))).toHaveLength(1);
    });
});
