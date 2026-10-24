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
    added?: string[];
    spawn: string[];
    namedBy: (names: string[]) => string[];
    namedInSource: (names: string[]) => string[];
    importers: (files: string[]) => string[];
}
const SCRIPT = new URL('../../scripts/test-changed.mjs', import.meta.url).href;
const { plan, reverseImports } = (await import(/* @vite-ignore */ SCRIPT)) as {
    plan: (input: PlanInput) => Step[];
    reverseImports: (texts: Record<string, string>) => (files: string[]) => string[];
};

const SPAWN = ['driver/test/scripts-gate-shell.test.ts', 'server/test/local-origin-plan.test.ts'];
const NAMED: Record<string, string[]> = {
    'metrics.md': ['core/test/docs.terminology.test.ts', 'driver/test/k8s-docs.test.ts'],
    'gate-loop.sh': ['driver/test/scripts-gate-shell.test.ts'],
    'reader.sql': ['server/test/fixtures/reader.ts', 'server/test/job-store.test.ts'],
    'suspend-outage.ts': ['driver/test/loop-containment.test.ts'],
};
const none = () => [];
const run = (changed: string[], over: Partial<PlanInput> = {}): Step[] =>
    plan({
        base: 'abc123',
        changed,
        spawn: SPAWN,
        namedBy: (names) => names.flatMap((name) => NAMED[name] ?? []),
        namedInSource: none,
        importers: none,
        ...over,
    });
const vitestArgs = (steps: Step[]) => steps.flatMap((step) => (step.vitest ? [step.vitest] : []));
const projects = (args: string[]) => args.flatMap((arg, at) => (args[at - 1] === '--project' ? [arg] : []));

describe('test:changed plan', () => {
    it('follows the import graph across every project, and only the source scanners beside it, for a driver module', () => {
        const steps = run(['driver/src/loop.ts']);
        expect(steps.some((step) => step.run)).toBe(false);
        expect(vitestArgs(steps)[0]).toEqual([
            'run',
            '--changed',
            'abc123',
            '--passWithNoTests',
            ...['core', 'server', 'web', 'driver', 'cli', 'dom', 'spawn'].flatMap((name) => ['--project', name]),
        ]);
        expect(vitestArgs(steps)[1]).toEqual([
            'run',
            'core/test/polling-authority.test.ts',
            'driver/test/k8s/pod-spec.test.ts',
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

    it('builds core and runs every server and web suite, spawn ones included, when core/src changed', () => {
        const steps = run(['core/src/metrics.ts']);
        expect(steps[0]?.run).toEqual(['npm', 'run', 'build', '-w', 'core']);
        expect(projects(steps[1]?.vitest ?? [])).toEqual(['server', 'web', 'dom']);
        expect(vitestArgs(steps)).toContainEqual(['run', 'server/test/local-origin-plan.test.ts']);
        const graph = vitestArgs(steps).find((args) => args.includes('--changed')) ?? [];
        expect(projects(graph)).not.toContain('server');
        expect(projects(graph)).toContain('spawn');
    });

    it('maps a changed script by the generic path-read rule: tests that name it', () => {
        const steps = run(['driver/src/scripts/gate-loop.sh']);
        expect(vitestArgs(steps).at(-1)).toEqual(['run', 'driver/test/scripts-gate-shell.test.ts']);
        expect(steps.some((step) => step.label.startsWith('widened'))).toBe(false);
    });

    it('routes a test helper that reads a changed file through vitest related', () => {
        const steps = run(['server/migrations/reader.sql']);
        expect(vitestArgs(steps).at(-2)).toEqual(['run', 'server/test/job-store.test.ts']);
        expect(vitestArgs(steps).at(-1)).toEqual(['related', '--run', 'server/test/fixtures/reader.ts']);
    });

    it('reaches the suites that import the loader of a changed script body', () => {
        const importers = reverseImports({
            'driver/src/container-scripts.ts': '',
            'driver/src/gate.ts': "import { gateShellScript } from './container-scripts.js';",
            'driver/test/scripts-gate-shell.test.ts': "import { gateShellScript } from '../src/container-scripts.js';",
        });
        const steps = run(['driver/src/scripts/gate-shell.sh'], {
            importers,
            namedInSource: (names) => (names.includes('gate-shell.sh') ? ['driver/src/container-scripts.ts'] : []),
        });
        expect(vitestArgs(steps).flat()).toContain('driver/test/scripts-gate-shell.test.ts');
        expect(steps.some((step) => step.label.startsWith('widened'))).toBe(false);
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
        const steps = run(['driver/src/loop-run.ts'], { importers });
        expect(vitestArgs(steps).at(-1)).toContain('driver/test/loop-containment.test.ts');
    });

    it('finds the suite that launches a changed test fixture by path, and rescans the test projects', () => {
        const steps = run(['driver/test/fixtures/suspend-outage.ts']);
        expect(vitestArgs(steps).at(-1)).toEqual([
            'run',
            'core/test/vitest-projects.test.ts',
            'driver/test/loop-containment.test.ts',
        ]);
    });

    describe('fails open', () => {
        it('runs everything, and says why, for a path nothing maps', () => {
            const steps = run(['charts/factory/templates/unknown-thing.yaml']);
            expect(vitestArgs(steps)).toEqual([
                [
                    'run',
                    ...['core', 'server', 'web', 'driver', 'cli', 'dom', 'spawn'].flatMap((name) => [
                        '--project',
                        name,
                    ]),
                ],
            ]);
            expect(steps.at(-1)?.label).toContain('widened to everything');
            expect(steps.at(-1)?.label).toContain('charts/factory/templates/unknown-thing.yaml');
        });

        it('runs everything for a file every package builds from, though a test names it', () => {
            const steps = run(['Makefile'], { namedBy: () => ['driver/test/executor-images.test.ts'] });
            expect(steps.at(-1)?.label).toContain('shared by every package');
            expect(vitestArgs(steps)).toHaveLength(1);
        });

        it('widens a package whose source file was added or removed, for the scans that list it', () => {
            const steps = run(['driver/src/unmapped-worker.ts'], { added: ['driver/src/unmapped-worker.ts'] });
            const widened = steps.find((step) => step.label.startsWith('widened'));
            expect(widened?.label).toContain('added or removed');
            expect(projects(widened?.vitest ?? [])).toEqual(['driver']);
            expect(vitestArgs(steps)).toContainEqual(['run', 'driver/test/scripts-gate-shell.test.ts']);
        });
    });

    it('reaches a suite that reads a changed TypeScript source by path, with no import', () => {
        const steps = run(['server/src/routes/jobs/job-limits.ts'], {
            namedBy: (names) => (names.includes('job-limits.ts') ? ['driver/test/board.test.ts'] : []),
        });
        expect(vitestArgs(steps).at(-1)).toContain('driver/test/board.test.ts');
    });

    it('plans only the graph step for an empty change', () => {
        expect(vitestArgs(run([]))).toHaveLength(1);
    });
});
