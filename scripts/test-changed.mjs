#!/usr/bin/env node
// `npm run test:changed [<base>]` — the tests a branch can reach, not the whole suite.
// `--db` plans the `server/test-db` suites instead, as one `npm run test:db` run.
//
// Vitest's `--changed` follows imports only. This adds the two couplings it cannot see: `server`
// and `web` import `@factory-ai/core` from `core/dist`, and tests read docs, shell scripts,
// migrations, charts and skills by path. `npm test` and `npm run test:db` on CI stay the merge gate.
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeSection } from './gate-report.mjs';

const DEFAULT_BASE = 'origin/main';
/** The label prefix of the plan step that runs every project. */
const WIDENED_TO_ALL = 'widened to everything';
const PROJECTS = ['core', 'server', 'web', 'driver', 'cli', 'dom', 'spawn'];
// Packages whose in-process suites import `@factory-ai/core` from `core/dist`.
const CORE_CONSUMERS = ['server', 'web', 'dom'];
const UNIT_TEST = /^(core|server|web|driver|cli)\/test\/.*\.test\.tsx?$/;
const TEST_TREE = /^(core|server|web|driver|cli)\/test\//;
// Names too common for a source to be said to load them, and files every package builds from or
// runs under: a change to one is not narrowed, it runs everything.
const SHARED_NAME = /^(package(-lock)?\.json|tsconfig[\w.]*\.json|Makefile|VERSION|README\.md|Dockerfile[\w.]*|index\.[a-z]+)$/;
const GRAPH_FILE = /\.(ts|tsx|mts|cts)$/;
const SRC_MODULE = /^(core|server|web|driver|cli)\/src\/.*\.tsx?$/;
// Suites that read a whole source tree (`readdirSync`, a recursive read) and import nothing from it,
// so neither the import graph nor a grep reaches them when a module there changes.
const POLLING = 'core/test/polling-authority.test.ts';
const SOURCE_SCANNERS = {
    core: ['core/test/core-index.test.ts', POLLING],
    server: [POLLING, 'server/test/import-boundaries.test.ts'],
    driver: [POLLING, 'driver/test/loop-fence.test.ts', 'driver/test/k8s/pod-spec.test.ts'],
    web: ['web/test/styles.test.ts'],
};

// The DB suites (`vitest.db.config.ts` includes `server/test-db/**/*.test.ts`).
const DB_ROOT = 'server/test-db';
// The DB config's globalSetup and setupFiles, and the modules they load: every DB suite runs under them.
const DB_SETUP = [
    'global-setup',
    'setup-worker',
    'workers',
    'harness',
    'database-names',
    'database-guard',
    'run-databases',
    'run-lock',
].map((name) => `${DB_ROOT}/${name}.ts`);
// The only paths that guarantee the whole DB suite. Shared store code is reached through the import
// graph instead: the harness imports it, so a change there selects the suites that import the harness.
const DB_FULL = [
    [(file) => file.startsWith('server/migrations/'), 'a migration'],
    [(file) => file === 'vitest.db.config.ts' || DB_SETUP.includes(file), 'the DB suite setup'],
    [(file) => SHARED_NAME.test(baseName(file)), 'shared by every package'],
    [(file) => file.startsWith('core/src/'), 'server imports core/dist, which no import graph sees'],
];

const projectArgs = (projects) => projects.flatMap((name) => ['--project', name]);
const baseName = (file) => file.slice(file.lastIndexOf('/') + 1);

/**
 * The ordered steps for a set of changed files. Fail open: a changed path the selector cannot
 * positively map widens the run (its package, or everything) and says why. Unknown means run more.
 *
 * - `changed`: repo-relative paths changed since the base; `added`: those added or removed.
 * - `spawn`: the spawn-tier test files (`vitest.spawn-tests.json`).
 * - `importers(files)`: every file that imports one of `files`, directly or through others.
 * - `namedInSource(names)`: source files (outside every `test/` directory) that mention any of `names`.
 * - `namedBy(names)`: files under a `test/` directory that mention any of `names`.
 */
export function plan({ base, changed, added = [], spawn, namedBy, namedInSource, importers }) {
    const spawning = new Set(spawn);
    const addedSet = new Set(added);
    const named = new Set();
    const helpers = new Set();
    const wide = new Map(); // scope ('all' or a package) -> why
    const widen = (scope, why) => wide.set(scope, [...(wide.get(scope) ?? []), why]);
    const classify = (hits) => {
        for (const hit of hits) {
            if (UNIT_TEST.test(hit)) named.add(hit);
            else if (TEST_TREE.test(hit)) helpers.add(hit);
        }
        return hits.length;
    };
    const loaded = [];

    for (const file of changed) {
        const pkg = file.split('/')[0];
        if (TEST_TREE.test(file)) {
            // A test file or helper added, moved or changed moves the project lists and the test scans.
            named.add('core/test/vitest-projects.test.ts');
            if (GRAPH_FILE.test(file)) classify(namedBy([baseName(file)])); // launched by path
        } else if (SRC_MODULE.test(file)) {
            if (addedSet.has(file)) widen(pkg, `${file} was added or removed: directory scans see it`);
            else for (const scanner of SOURCE_SCANNERS[pkg] ?? []) named.add(scanner);
            classify(namedBy([baseName(file)])); // a test that reads the module by path
        } else if (/\.md$/.test(file) && !SHARED_NAME.test(baseName(file))) {
            classify(namedBy([baseName(file)]));
            if (file.startsWith('docs/design-system/')) named.add('web/test/styles.test.ts');
        } else if (SHARED_NAME.test(baseName(file))) {
            widen('all', `${file}: shared by every package`);
        } else {
            // Read by path, not imported: a test names it, or a source loads it and tests import that.
            const readers = namedBy([baseName(file)]);
            const loaders = namedInSource([baseName(file)]);
            loaded.push(...loaders);
            if (classify(readers) + loaders.length === 0) widen('all', `${file}: nothing in the tests or sources names it`);
        }
    }
    // A source that loads a changed file by name is as good as changed: its importers' suites run.
    const throughLoaders = [...loaded, ...importers(loaded)];
    for (const file of throughLoaders) if (UNIT_TEST.test(file)) named.add(file);
    // A fixture under test/ that imports a changed source, however deep, may be launched by path
    // (`spawn`, `fork`), which no import graph connects: the suites that name it are reached too.
    const reaching = [
        ...importers(changed.filter((file) => GRAPH_FILE.test(file))),
        ...throughLoaders,
    ].filter((file) => TEST_TREE.test(file) && !UNIT_TEST.test(file));
    if (reaching.length > 0) classify(namedBy([...new Set(reaching.map(baseName))]));

    const coreChanged = changed.some((file) => file.startsWith('core/src/'));
    const steps = [];
    const build = { label: 'build core (server and web import core/dist)', run: ['npm', 'run', 'build', '-w', 'core'] };
    if (wide.has('all')) {
        steps.push(build, {
            label: `${WIDENED_TO_ALL}: ${wide.get('all').join('; ')}`,
            vitest: ['run', ...projectArgs(PROJECTS)],
        });
        return steps;
    }
    const covered = new Set(coreChanged ? CORE_CONSUMERS : []);
    for (const pkg of wide.keys()) {
        covered.add(pkg);
        if (pkg === 'web') covered.add('dom');
    }
    if (coreChanged) steps.push(build);
    if (covered.size > 0) {
        const why = [...wide.values()].flat();
        steps.push({
            label: `${coreChanged ? 'core changed (server and web import core/dist)' : 'widened'}${why.length > 0 ? `: ${why.join('; ')}` : ''}`,
            vitest: ['run', ...projectArgs([...covered])],
        });
        // The spawn tier is in no package project: its suites of a covered package run too.
        const spawned = spawn
            .filter((file) => [...covered].some((pkg) => file.startsWith(`${pkg === 'dom' ? 'web' : pkg}/`)))
            .sort();
        if (spawned.length > 0) {
            steps.push({ label: 'spawn suites of the widened packages', vitest: ['run', ...spawned] });
        }
    }
    // Spawn-tier suites join the import-graph step: they run when a file they import changed, or
    // when they changed themselves, and in no other case.
    steps.push({
        label: `import graph since ${base}`,
        vitest: ['run', '--changed', base, '--passWithNoTests', ...projectArgs(PROJECTS.filter((name) => !covered.has(name)))],
    });
    const inCovered = (file) => covered.has(file.split('/')[0]) && !spawning.has(file);
    const byPath = [...named].filter((file) => !inCovered(file)).sort();
    if (byPath.length > 0) steps.push({ label: 'tests that read a changed file by path', vitest: ['run', ...byPath] });
    if (helpers.size > 0) {
        steps.push({
            label: 'tests that import a test helper that reads a changed file by path',
            vitest: ['related', '--run', ...[...helpers].sort()],
        });
    }
    return steps;
}

/**
 * How the gate chose its tests, for the gate's report (`selection` section, scripts/gate-report.mjs): `all` when the
 * plan widened to everything, with the reason it printed, else `changed`, naming any package it widened.
 */
export function selectionOf(steps, changedCount, base) {
    const everything = steps.find((step) => step.label.startsWith(WIDENED_TO_ALL));
    if (everything) return { mode: 'all', reason: everything.label.slice(WIDENED_TO_ALL.length).replace(/^: /, '') };
    const widened = steps.filter((step) => /^(widened|core changed)/.test(step.label)).map((step) => step.label);
    return {
        mode: 'changed',
        reason: [`${changedCount} changed file(s) since ${base}`, ...widened].join('; '),
    };
}

/** The reporter a gate's vitest runs add, so the failures and durations reach the gate's report (scripts/gate-reporter.mjs). */
export function gateReporterArgs(env, passthrough) {
    if (!env.FACTORY_GATE_RUN || passthrough.some((arg) => arg.startsWith('--reporter'))) return [];
    return ['--reporter=default', `--reporter=${fileURLToPath(new URL('./gate-reporter.mjs', import.meta.url))}`];
}

/**
 * The DB suites a set of changed files reaches: `{ full: [why] }` for the whole suite, or
 * `{ tests }`, possibly empty. Unlike `plan`, a path nothing names selects nothing: CI's full
 * `test:db` run is the backstop.
 *
 * - `dbTests`: every DB test file. `namedByDb(names)`: files under `server/test-db` naming any of `names`.
 * - `namedInSource` and `importers`: as for `plan`.
 */
export function planDb({ changed, dbTests, namedByDb, namedInSource, importers }) {
    const isDbTest = new Set(dbTests);
    const full = [];
    const tests = new Set();
    const select = (files) => {
        for (const file of files) if (isDbTest.has(file)) tests.add(file);
    };
    // DB suites that name one of `names`, or import a test-db helper that does.
    const naming = (names) => {
        const hits = namedByDb(names);
        select(hits);
        select(importers(hits.filter((hit) => hit.startsWith(`${DB_ROOT}/`) && !isDbTest.has(hit))));
    };
    // DB suites that import a source, or name it or a non-test importer of it (launched by path).
    const reach = (files) => {
        const above = importers(files);
        select(above);
        const names = [...files, ...above.filter((file) => !/\.test\.tsx?$/.test(file))]
            .map(baseName)
            .filter((name) => !SHARED_NAME.test(name));
        naming([...new Set(names)]);
    };
    for (const file of changed) {
        const rule = DB_FULL.find(([matches]) => matches(file));
        if (rule) full.push(`${file}: ${rule[1]}`);
        if (full.length > 0) continue;
        if (isDbTest.has(file)) tests.add(file);
        else if (GRAPH_FILE.test(file)) reach([file]);
        else {
            naming([baseName(file)]);
            const loaders = namedInSource([baseName(file)]);
            if (loaders.length > 0) reach(loaders);
        }
    }
    return full.length > 0 ? { full } : { tests: [...tests].sort() };
}

/** `importers` over `texts` ({ path: source }): the relative imports of TypeScript files, reversed. */
export function reverseImports(texts) {
    const paths = new Set(Object.keys(texts));
    const importedBy = new Map();
    for (const [file, text] of Object.entries(texts)) {
        const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
        for (const [, specifier] of text.matchAll(/(?:from|import\()\s*['"](\.[^'"]*)['"]/g)) {
            const target = posix.normalize(posix.join(dir, specifier.replace(/\.[cm]?jsx?$/, '')));
            for (const candidate of [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`]) {
                if (paths.has(candidate)) importedBy.set(candidate, [...(importedBy.get(candidate) ?? []), file]);
            }
        }
    }
    return (files) => {
        const seen = new Set();
        const queue = [...files];
        while (queue.length > 0) {
            for (const parent of importedBy.get(queue.pop()) ?? []) {
                if (!seen.has(parent)) {
                    seen.add(parent);
                    queue.push(parent);
                }
            }
        }
        return [...seen];
    };
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);

/** Changed paths since `mergeBase`, and those of them added or removed (directory scans see those). */
function changedFiles(mergeBase) {
    const untracked = git('ls-files', '--others', '--exclude-standard');
    const status = git('diff', '--no-renames', '--name-status', mergeBase).map((line) => line.split('\t'));
    return {
        changed: [...new Set([...status.map(([, file]) => file), ...untracked])],
        added: [...status.filter(([code]) => code !== 'M').map(([, file]) => file), ...untracked],
    };
}

/** Files under `pathspecs` that mention any of `names`. Only git grep's exit 1 means none; any other failure throws. */
export function gitGrep(pathspecs, names, exec = execFileSync) {
    if (names.length === 0) return [];
    try {
        const args = ['grep', '-l', '-F', ...names.flatMap((name) => ['-e', name]), '--', ...pathspecs];
        return exec('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch (error) {
        if (error?.status === 1) return [];
        throw error;
    }
}

const namedBy = (names) => gitGrep(['*/test/*'], names);
const namedByDb = (names) => gitGrep([`${DB_ROOT}/*`], names);
const namedInSource = (names) => gitGrep(['*.ts', '*.tsx', ':(exclude)*/test/*'], names);

/** Every DB test file. A missing directory throws: the DB project always exists. */
const listDbTests = () =>
    readdirSync(DB_ROOT, { recursive: true })
        .map((file) => `${DB_ROOT}/${file}`)
        .filter((file) => file.endsWith('.test.ts'))
        .sort();

/** The DB plan as runnable steps: none when no DB suite is reached. */
function dbSteps(planned, passthrough) {
    if ('full' in planned) {
        const extra = passthrough.length > 0 ? ['--', ...passthrough] : [];
        return [{ label: `the whole DB suite: ${planned.full.join('; ')}`, run: ['npm', 'run', 'test:db', ...extra] }];
    }
    if (planned.tests.length === 0) return [];
    return [
        { label: 'DB suites the change reaches', run: ['npm', 'run', 'test:db', '--', ...planned.tests, ...passthrough] },
    ];
}

/** A `test:db` run takes the reporter after its `--`, as vitest arguments; any other command is left as it was. */
function withReporter(argv, reporter) {
    if (reporter.length === 0 || (argv[0] === 'npm' && argv[2] !== 'test:db')) return argv;
    if (argv[0] !== 'npm') return [...argv, ...reporter];
    return argv.includes('--') ? [...argv, ...reporter] : [...argv, '--', ...reporter];
}

function main(argv) {
    const dash = argv.indexOf('--');
    const passthrough = dash === -1 ? [] : argv.slice(dash + 1);
    const args = dash === -1 ? argv : argv.slice(0, dash);
    const show = args.includes('--plan');
    const fromStdin = args.includes('--files');
    const db = args.includes('--db');
    const positional = args.filter((arg) => !arg.startsWith('--'));
    if (positional.length > 1) {
        console.error('usage: test-changed.mjs [<base>] [--db] [--plan] [--files] [-- <vitest args>]');
        return 2;
    }
    const base = positional[0] ?? process.env.TEST_CHANGED_BASE ?? DEFAULT_BASE;
    let changed;
    let added = [];
    let mergeBase = base;
    if (fromStdin) changed = readFileSync(0, 'utf8').split('\n').filter(Boolean);
    else {
        // From the merge base, so a branch behind <base> is not charged with <base>'s newer commits.
        [mergeBase] = git('merge-base', base, 'HEAD');
        ({ changed, added } = changedFiles(mergeBase));
    }
    const spawn = JSON.parse(readFileSync(new URL('../vitest.spawn-tests.json', import.meta.url), 'utf8')).tests;
    const texts = Object.fromEntries(
        git('ls-files', '*.ts', '*.tsx').map((file) => {
            try {
                return [file, readFileSync(file, 'utf8')];
            } catch (error) {
                if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [file, '']; // deleted in the tree
                throw error;
            }
        })
    );
    const importers = reverseImports(texts);
    const steps = db
        ? dbSteps(planDb({ changed, dbTests: listDbTests(), namedByDb, namedInSource, importers }), passthrough)
        : plan({ base: mergeBase, changed, added, spawn, namedBy, namedInSource, importers });
    if (show) {
        process.stdout.write(`${JSON.stringify({ changed, steps }, null, 2)}\n`);
        return 0;
    }
    console.error(`[test:changed] ${changed.length} changed file(s) since ${base}`);
    writeSection('selection', selectionOf(steps, changed.length, base));
    if (steps.length === 0) console.error('[test:changed] no test:db suite reached; nothing to run');
    for (const step of steps) {
        const reporter = gateReporterArgs(process.env, passthrough);
        const argvOf = withReporter(step.run ?? ['npx', 'vitest', ...step.vitest, ...passthrough], reporter);
        console.error(`[test:changed] ${step.label}: ${argvOf.join(' ')}`);
        const [cmd, ...rest] = argvOf;
        const result = spawnSync(cmd, rest, { stdio: 'inherit' });
        if (result.status !== 0) return result.status ?? 1;
    }
    return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    process.exitCode = main(process.argv.slice(2));
}
