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
    namedBy: (name: string) => string[];
}
const SCRIPT = new URL('../../scripts/test-changed.mjs', import.meta.url).href;
const { plan } = (await import(/* @vite-ignore */ SCRIPT)) as { plan: (input: PlanInput) => Step[] };

const SPAWN = ['driver/test/scripts-gate-shell.test.ts', 'core/test/biome.test.ts'];
const NAMED: Record<string, string[]> = {
    'metrics.md': ['core/test/docs.terminology.test.ts', 'driver/test/k8s-docs.test.ts'],
    'gate-loop.sh': ['driver/test/scripts-gate-shell.test.ts'],
    'helper-reader.sql': ['server/test/fixtures/reader.ts', 'server/test/job-store.test.ts'],
};
const run = (changed: string[], namedBy = (name: string) => NAMED[name] ?? []): Step[] =>
    plan({ base: 'abc123', changed, spawn: SPAWN, namedBy });
const vitestArgs = (steps: Step[]) => steps.flatMap((step) => (step.vitest ? [step.vitest] : []));

describe('test:changed plan', () => {
    it('follows the import graph across every project and nothing else for a driver module', () => {
        const steps = run(['driver/src/loop.ts']);
        expect(steps.some((step) => step.run)).toBe(false);
        expect(vitestArgs(steps)).toEqual([
            [
                'run',
                '--changed',
                'abc123',
                '--passWithNoTests',
                ...['core', 'server', 'web', 'driver', 'cli', 'dom', 'spawn'].flatMap((name) => ['--project', name]),
            ],
        ]);
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
        expect(vitestArgs(steps).at(-1)).toEqual(['run', 'driver/test/scripts-gate-shell.test.ts']);
    });

    it('routes a test helper that reads a changed file through vitest related', () => {
        const steps = run(['server/migrations/helper-reader.sql']);
        // The migration is not a graph file; only the unit test is run directly, the helper via related.
        expect(vitestArgs(steps).at(-2)).toEqual(['run', 'server/test/job-store.test.ts']);
        expect(vitestArgs(steps).at(-1)).toEqual(['related', '--run', 'server/test/fixtures/reader.ts']);
    });

    it('maps a changed script to the spawn suite that names it', () => {
        const steps = run(['driver/src/scripts/gate-loop.sh']);
        expect(vitestArgs(steps).at(-1)).toEqual(['run', 'driver/test/scripts-gate-shell.test.ts']);
    });

    it('does not name-match typescript sources or test files, which the graph follows', () => {
        let asked = 0;
        run(['driver/src/loop.ts', 'driver/test/loop.test.ts', 'web/src/App.tsx'], () => {
            asked += 1;
            return [];
        });
        expect(asked).toBe(0);
    });

    it('plans only the graph step for an empty change', () => {
        expect(vitestArgs(run([]))).toHaveLength(1);
    });
});
