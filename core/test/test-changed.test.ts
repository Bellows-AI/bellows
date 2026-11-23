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
interface DbPlanInput {
    changed: string[];
    dbTests: string[];
    namedByDb: (names: string[]) => string[];
    namedInSource: (names: string[]) => string[];
    importers: (files: string[]) => string[];
}
type DbPlan = { full: string[] } | { tests: string[] };
type Exec = (cmd: string, args: string[], options: { encoding: 'utf8' }) => string;
const { plan, planDb, gitGrep, reverseImports, selectionOf, gateReporterArgs } = (await import(
    /* @vite-ignore */ SCRIPT
)) as {
    selectionOf: (steps: Step[], changedCount: number, base: string) => { mode: string; reason: string };
    gateReporterArgs: (env: Record<string, string>, passthrough: string[]) => string[];
    plan: (input: PlanInput) => Step[];
    planDb: (input: DbPlanInput) => DbPlan;
    gitGrep: (pathspecs: string[], names: string[], exec?: Exec) => string[];
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

describe('test:db changed plan', () => {
    const DB_TESTS = [
        'server/test-db/commerce-store.test.ts',
        'server/test-db/job-store.test.ts',
        'server/test-db/run-lock.test.ts',
        'server/test-db/seed-cli.test.ts',
    ];
    const runDb = (changed: string[], over: Partial<DbPlanInput> = {}): DbPlan =>
        planDb({ changed, dbTests: DB_TESTS, namedByDb: none, namedInSource: none, importers: none, ...over });

    it('runs the whole DB suite for a migration', () => {
        const result = runDb(['server/migrations/170_x.sql']);
        expect('full' in result && result.full.join(' ')).toContain('server/migrations/170_x.sql');
    });

    it.each([
        'server/test-db/global-setup.ts',
        'server/test-db/setup-worker.ts',
        'server/test-db/workers.ts',
        'server/test-db/harness.ts',
        'server/test-db/database-names.ts',
        'server/test-db/database-guard.ts',
        'server/test-db/run-databases.ts',
        'server/test-db/run-lock.ts',
        'vitest.db.config.ts',
    ])('runs the whole DB suite for the harness and the global setup: %s', (file) => {
        expect(runDb([file])).toHaveProperty('full');
    });

    it('runs the whole DB suite when core/src changed', () => {
        expect(runDb(['core/src/metrics.ts'])).toHaveProperty('full');
    });

    it('runs the whole DB suite for a file every package builds from', () => {
        expect(runDb(['package.json'])).toHaveProperty('full');
    });

    it('selects the suites that import a changed store module, through any depth', () => {
        const importers = reverseImports({
            'server/src/db/commerce-store.ts': '',
            'server/src/db/x.ts': "import { store } from './commerce-store.js';",
            'server/test-db/commerce-store.test.ts': "import { x } from '../src/db/x.js';",
        });
        expect(runDb(['server/src/db/commerce-store.ts'], { importers })).toEqual({
            tests: ['server/test-db/commerce-store.test.ts'],
        });
    });

    it('selects the harness importers, not the full suite, for a module the harness imports', () => {
        const reached = ['server/test-db/commerce-store.test.ts', 'server/test-db/job-store.test.ts'];
        const result = runDb(['server/src/db/pool.ts'], {
            dbTests: [...reached, 'server/test-db/run-lock.test.ts'],
            importers: (files) =>
                files.includes('server/src/db/pool.ts') ? ['server/test-db/harness.ts', ...reached] : [],
        });
        expect(result).toEqual({ tests: reached });
    });

    it('selects a changed DB test itself', () => {
        expect(runDb(['server/test-db/job-store.test.ts'])).toEqual({ tests: ['server/test-db/job-store.test.ts'] });
    });

    it('selects a suite that launches a changed source by path', () => {
        const result = runDb(['server/src/seed/x.ts'], {
            importers: (files) => (files.includes('server/src/seed/x.ts') ? ['server/src/seed/cli.ts'] : []),
            namedByDb: (names) =>
                names.includes('cli.ts') && names.includes('x.ts') ? ['server/test-db/seed-cli.test.ts'] : [],
        });
        expect(result).toEqual({ tests: ['server/test-db/seed-cli.test.ts'] });
    });

    it('selects nothing for a web-only change', () => {
        expect(runDb(['web/src/panels/Foo.tsx'])).toEqual({ tests: [] });
    });

    it('selects nothing for a doc no DB suite names', () => {
        expect(runDb(['docs/metrics.md'])).toEqual({ tests: [] });
    });

    it('selects nothing for an unnamed config file in DB mode, where unit mode still widens', () => {
        expect(runDb(['docker/x/unknown.conf'])).toEqual({ tests: [] });
        expect(run(['docker/x/unknown.conf']).at(-1)?.label).toContain('widened to everything');
    });

    it('selects nothing for a path only a unit test names', () => {
        // The unit suite that reads it is in no DB project: `namedByDb` greps server/test-db only.
        const result = runDb(['.github/workflows/ci.yml'], {
            namedByDb: (names) => (names.includes('ci.yml') ? ['core/test/ci-workflows.test.ts'] : []),
        });
        expect(result).toEqual({ tests: [] });
    });

    it('selects the suites that import a test-db helper naming a changed file', () => {
        const result = runDb(['server/src/seed/data.json'], {
            namedByDb: (names) => (names.includes('data.json') ? ['server/test-db/fixtures.ts'] : []),
            importers: (files) =>
                files.includes('server/test-db/fixtures.ts') ? ['server/test-db/job-store.test.ts'] : [],
        });
        expect(result).toEqual({ tests: ['server/test-db/job-store.test.ts'] });
    });

    it('selects the suites that import a source loading a changed file', () => {
        const result = runDb(['server/src/skills/catalog.yaml'], {
            namedInSource: (names) => (names.includes('catalog.yaml') ? ['server/src/skill-catalog.ts'] : []),
            importers: (files) =>
                files.includes('server/src/skill-catalog.ts') ? ['server/test-db/commerce-store.test.ts'] : [],
        });
        expect(result).toEqual({ tests: ['server/test-db/commerce-store.test.ts'] });
    });
});

describe('gitGrep', () => {
    const failing =
        (status: number): Exec =>
        () => {
            throw Object.assign(new Error(`git grep exited ${status}`), { status });
        };

    it('lists the matching files', () => {
        const exec: Exec = () => 'server/test-db/a.test.ts\nserver/test-db/b.test.ts\n';
        expect(gitGrep(['server/test-db/*'], ['a.ts'], exec)).toEqual([
            'server/test-db/a.test.ts',
            'server/test-db/b.test.ts',
        ]);
    });

    it('returns [] when git grep exits 1', () => {
        expect(gitGrep(['server/test-db/*'], ['a.ts'], failing(1))).toEqual([]);
    });

    it('throws when git grep fails otherwise (status 128)', () => {
        expect(() => gitGrep(['server/test-db/*'], ['a.ts'], failing(128))).toThrow(/exited 128/);
    });
});

describe('what the gate records of its selection', () => {
    it('says `all` and why when the plan widened to everything', () => {
        const steps = run(['vitest.config.ts']);
        expect(selectionOf(steps, 1, 'abc123')).toEqual({
            mode: 'all',
            reason: expect.stringContaining('vitest.config.ts'),
        });
        expect(selectionOf(steps, 1, 'abc123').reason).not.toMatch(/^widened to everything/);
    });

    it('says `changed` with the count and base, naming a widened package', () => {
        const narrow = selectionOf(run(['core/test/a.test.ts']), 1, 'abc123');
        expect(narrow).toEqual({ mode: 'changed', reason: '1 changed file(s) since abc123' });
        const core = selectionOf(run(['core/src/a.ts']), 2, 'abc123');
        expect(core.mode).toBe('changed');
        expect(core.reason).toContain('core changed');
    });

    it('adds the gate reporter to a gate’s vitest runs only, and never over a reporter the caller named', () => {
        expect(gateReporterArgs({}, [])).toEqual([]);
        const args = gateReporterArgs({ FACTORY_GATE_RUN: '/factory/gate/running/x' }, []);
        expect(args[0]).toBe('--reporter=default');
        expect(args[1]).toMatch(/--reporter=.*scripts\/gate-reporter\.mjs$/);
        expect(gateReporterArgs({ FACTORY_GATE_RUN: '/x' }, ['--reporter=dot'])).toEqual([]);
    });
});
