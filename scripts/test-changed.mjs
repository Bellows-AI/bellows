#!/usr/bin/env node
// `npm run test:changed [<base>]` — the tests a branch can reach, not the whole suite.
//
// Vitest's `--changed` follows imports only. This adds the two couplings it cannot see: `server`
// and `web` import `@factory-ai/core` from `core/dist`, and tests read docs, shell scripts,
// migrations, charts and skills by path. `npm test` and the lanes stay the gate before shipping.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE = 'origin/main';
const PROJECTS = ['core', 'server', 'web', 'driver', 'cli', 'dom', 'spawn'];
// Packages whose in-process suites import `@factory-ai/core` from `core/dist`.
const CORE_CONSUMERS = ['server', 'web', 'dom'];
const UNIT_TEST = /^(core|server|web|driver|cli)\/test\/.*\.test\.tsx?$/;
const TEST_TREE = /^(core|server|web|driver|cli)\/test\//;
const GRAPH_FILE = /\.(ts|tsx|mts|cts)$/;
// Suites that enumerate a directory (`readdirSync`) and never name its files, so no grep finds them.
// `core/test/test-changed.test.ts` pins that each one exists and still names its directory.
export const DIRECTORY_READERS = [
    [/^server\/migrations\//, ['core/test/migrations.sql.test.ts'], 'migrations'],
    [/^lint\//, ['core/test/biome.test.ts'], 'lint'],
    [/^docker\/skills\//, ['core/test/skills.test.ts', 'driver/test/executor-images.test.ts'], 'skills'],
    [/^core\/src\//, ['core/test/core-index.test.ts'], 'src'],
];

const projectArgs = (projects) => projects.flatMap((name) => ['--project', name]);

/**
 * The ordered steps for a set of changed files.
 *
 * - `changed`: repo-relative paths changed since the base.
 * - `spawn`: the spawn-tier test files (`vitest.spawn-tests.json`).
 * - `namedBy(names)`: files under a `test/` directory that mention any of `names`.
 */
export function plan({ base, changed, spawn, namedBy }) {
    const spawning = new Set(spawn);
    const steps = [];
    const coreChanged = changed.some((file) => file.startsWith('core/src/'));
    const covered = coreChanged ? CORE_CONSUMERS : [];

    if (coreChanged) {
        steps.push({ label: 'build core (server and web import core/dist)', run: ['npm', 'run', 'build', '-w', 'core'] });
        steps.push({
            label: 'core changed: every server and web suite',
            vitest: ['run', ...projectArgs(covered)],
        });
        // The spawn tier is in no package project, and its server and web suites import core/dist too.
        const spawnConsumers = spawn.filter((file) => /^(server|web)\//.test(file)).sort();
        if (spawnConsumers.length > 0) {
            steps.push({ label: 'core changed: the server and web spawn suites', vitest: ['run', ...spawnConsumers] });
        }
    }

    // Spawn-tier suites join the import-graph step: they run when a file they import changed, or
    // when they changed themselves, and in no other case.
    steps.push({
        label: `import graph since ${base}`,
        vitest: [
            'run',
            '--changed',
            base,
            '--passWithNoTests',
            ...projectArgs(PROJECTS.filter((name) => !covered.includes(name))),
        ],
    });

    // Everything vitest's graph cannot see: a file a test reads by path, whatever its language, a
    // fixture under test/, and a directory a test enumerates.
    const named = new Set(
        changed.flatMap((file) => DIRECTORY_READERS.filter(([pattern]) => pattern.test(file)).flatMap(([, tests]) => tests))
    );
    const helpers = new Set();
    const names = [
        ...new Set(
            changed
                .filter((file) => !(TEST_TREE.test(file) && GRAPH_FILE.test(file)))
                .map((file) => file.slice(file.lastIndexOf('/') + 1))
        ),
    ];
    for (const hit of names.length > 0 ? namedBy(names) : []) {
        if (UNIT_TEST.test(hit)) named.add(hit);
        else if (TEST_TREE.test(hit)) helpers.add(hit);
    }
    const inCovered = (file) => {
        const pkg = file.split('/')[0];
        return coreChanged && (pkg === 'server' || pkg === 'web') && !spawning.has(file);
    };
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

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);

function changedFiles(mergeBase) {
    return [
        ...new Set([
            ...git('diff', '--no-renames', '--name-only', mergeBase),
            ...git('ls-files', '--others', '--exclude-standard'),
        ]),
    ];
}

function namedBy(names) {
    try {
        return git('grep', '-l', '-F', ...names.flatMap((name) => ['-e', name]), '--', '*/test/*');
    } catch {
        return []; // git grep exits 1 on no match
    }
}

function main(argv) {
    const dash = argv.indexOf('--');
    const passthrough = dash === -1 ? [] : argv.slice(dash + 1);
    const args = dash === -1 ? argv : argv.slice(0, dash);
    const show = args.includes('--plan');
    const fromStdin = args.includes('--files');
    const positional = args.filter((arg) => !arg.startsWith('--'));
    if (positional.length > 1) {
        console.error('usage: test-changed.mjs [<base>] [--plan] [--files] [-- <vitest args>]');
        return 2;
    }
    const base = positional[0] ?? process.env.TEST_CHANGED_BASE ?? DEFAULT_BASE;
    let changed;
    let mergeBase = base;
    if (fromStdin) changed = readFileSync(0, 'utf8').split('\n').filter(Boolean);
    else {
        // From the merge base, so a branch behind <base> is not charged with <base>'s newer commits.
        [mergeBase] = git('merge-base', base, 'HEAD');
        changed = changedFiles(mergeBase);
    }
    const spawn = JSON.parse(readFileSync(new URL('../vitest.spawn-tests.json', import.meta.url), 'utf8')).tests;
    const steps = plan({ base: mergeBase, changed, spawn, namedBy });
    if (show) {
        process.stdout.write(`${JSON.stringify({ changed, steps }, null, 2)}\n`);
        return 0;
    }
    console.error(`[test:changed] ${changed.length} changed file(s) since ${base}`);
    for (const step of steps) {
        const argvOf = step.run ?? ['npx', 'vitest', ...step.vitest, ...passthrough];
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
