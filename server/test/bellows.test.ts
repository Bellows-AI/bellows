import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseBellows } from '../src/workspace/bellows.js';

/**
 * The `.bellows.yaml` strict-subset parser, pure: text in, config or null out, named error thrown.
 *
 * No YAML package exists in this repo and none may be added, so the accepted grammar is pinned
 * here — the issue's example must parse, and everything outside the subset must fail loudly rather
 * than mis-parse, because a silently dropped gate is a check that never ran.
 */

const EXAMPLE = [
    'environment: ',
    '    image: node:24',
    '    gates:',
    '         - name: test',
    '           command: "npm test"',
].join('\n');

describe('parseBellows: valid documents', () => {
    it('parses the issue example', () => {
        expect(parseBellows(EXAMPLE)).toEqual({
            image: 'node:24',
            gates: [{ name: 'test', command: 'npm test' }],
        });
    });

    it('reads an optional environment setup command', () => {
        const text = EXAMPLE.replace('    image: node:24', '    image: node:24\n    setup: "npm ci"');
        expect(parseBellows(text)).toEqual({
            image: 'node:24',
            setup: 'npm ci',
            gates: [{ name: 'test', command: 'npm test' }],
        });
    });

    it("reads a gate's timeout in whole minutes", () => {
        const text = `${EXAMPLE}\n           timeout: 45`;
        expect(parseBellows(text)?.gates).toEqual([{ name: 'test', command: 'npm test', timeoutMinutes: 45 }]);
    });

    it('omits timeoutMinutes when a gate declares none', () => {
        const [gate] = parseBellows(EXAMPLE)?.gates ?? [];
        expect(gate).toBeDefined();
        expect('timeoutMinutes' in (gate ?? {})).toBe(false);
    });

    it('reads an on-demand gate, and omits onDemand when a gate declares none', () => {
        expect(parseBellows(`${EXAMPLE}\n           on_demand: true`)?.gates).toEqual([
            { name: 'test', command: 'npm test', onDemand: true },
        ]);
        expect('onDemand' in (parseBellows(EXAMPLE)?.gates[0] ?? {})).toBe(false);
    });

    it('reads a filter gate, omits filter when a gate declares none, and refuses a non-true value', () => {
        expect(parseBellows(`${EXAMPLE}\n           filter: true`)?.gates).toEqual([
            { name: 'test', command: 'npm test', filter: true },
        ]);
        expect('filter' in (parseBellows(EXAMPLE)?.gates[0] ?? {})).toBe(false);
        expect(() => parseBellows(`${EXAMPLE}\n           filter: yes`)).toThrow(/filter must be "true"/);
    });

    it('reads a parallel gate, omits parallel when a gate declares none, and refuses a non-true value', () => {
        expect(parseBellows(`${EXAMPLE}\n           parallel: true`)?.gates).toEqual([
            { name: 'test', command: 'npm test', parallel: true },
        ]);
        expect('parallel' in (parseBellows(EXAMPLE)?.gates[0] ?? {})).toBe(false);
        expect(() => parseBellows(`${EXAMPLE}\n           parallel: yes`)).toThrow(/parallel must be "true"/);
    });

    it.each([
        ['an empty setup', '    setup: ""', /line 3: setup is empty/],
        ['a valueless setup', '    setup:', /line 3: setup takes a value/],
        ['a second setup', '    setup: a\n    setup: b', /line 4: setup is declared twice/],
    ])('refuses %s', (_label, setup, message) => {
        const text = EXAMPLE.replace('    image: node:24', `    image: node:24\n${setup}`);
        expect(() => parseBellows(text)).toThrow(message);
    });

    it('reads an environment cache list, and omits cache when none is declared', () => {
        const text = EXAMPLE.replace(
            '    image: node:24',
            '    image: node:24\n    cache:\n        - NPM_CONFIG_CACHE\n        - PIP_CACHE_DIR\n    setup: npm ci'
        );
        expect(parseBellows(text)).toEqual({
            image: 'node:24',
            setup: 'npm ci',
            cache: ['NPM_CONFIG_CACHE', 'PIP_CACHE_DIR'],
            gates: [{ name: 'test', command: 'npm test' }],
        });
        expect('cache' in (parseBellows(EXAMPLE) ?? {})).toBe(false);
    });

    it.each([
        [
            'a name that is not env-shaped',
            '        - npm-cache',
            /line 4: cache name "npm-cache" is not an environment variable name/,
        ],
        ['an inline comment after a name', '        - NPM_CONFIG_CACHE  # npm', /line 4: cache name/],
        ['HOME, which the driver owns', '        - HOME', /line 4: cache name "HOME" is reserved/],
        ['PATH, which the driver owns', '        - PATH', /line 4: cache name "PATH" is reserved/],
        [
            'XDG_DATA_HOME, which the driver owns',
            '        - XDG_DATA_HOME',
            /line 4: cache name "XDG_DATA_HOME" is reserved/,
        ],
        ['a RUNNER_ name', '        - RUNNER_CACHE', /line 4: cache name "RUNNER_CACHE" is reserved/],
        ['a reserved env name', '        - WORKDIR', /line 4: cache name "WORKDIR" is reserved/],
        ...[
            'OTEL_EXPORTER_OTLP_ENDPOINT',
            'NPM_CONFIG_UPDATE_NOTIFIER',
            'LD_PRELOAD',
            'DYLD_INSERT_LIBRARIES',
            'NODE_OPTIONS',
            'BASH_ENV',
            'GIT_CONFIG_GLOBAL',
            'CLAUDE_CONFIG_DIR',
        ].map((name): [string, string, RegExp] => [
            `${name}, a driver or code-loading name`,
            `        - ${name}`,
            new RegExp(`line 4: cache name "${name}" is reserved`),
        ]),
        [
            'a duplicate name',
            '        - GOMODCACHE\n        - GOMODCACHE',
            /line 5: cache name "GOMODCACHE" is declared twice/,
        ],
        [
            'more than 16 names',
            Array.from({ length: 17 }, (_, i) => `        - CACHE_${i}`).join('\n'),
            /line 20: more than 16 cache names/,
        ],
        ['an empty list', '', /line 3: cache lists no names/],
    ])('refuses %s', (_label, items, message) => {
        const block = items ? `    cache:\n${items}` : '    cache:';
        const text = EXAMPLE.replace('    image: node:24', `    image: node:24\n${block}`);
        expect(() => parseBellows(text)).toThrow(message);
    });

    it.each([
        ['an inline value', '    cache: NPM_CONFIG_CACHE', /line 3: cache takes a list, not a value/],
        ['a second cache block', '    cache:\n        - A\n    cache:\n        - B', /line 5: cache is declared twice/],
        ['a cache block after gates', '    gates:\n    cache:\n        - A', /line 4: "cache"/],
    ])('refuses %s', (_label, block, message) => {
        const text = EXAMPLE.replace('    image: node:24', `    image: node:24\n${block}`);
        expect(() => parseBellows(text)).toThrow(message);
    });

    it('tolerates comments and blank lines', () => {
        const text = [
            '# CI gates for this repository',
            '',
            'environment:',
            '    # the image gates run in',
            '    image: node:24',
            '',
            '    gates:',
            '        - name: test',
            '          command: npm test',
            '',
            '# trailing comment',
        ].join('\n');
        expect(parseBellows(text)).toEqual({
            image: 'node:24',
            gates: [{ name: 'test', command: 'npm test' }],
        });
    });

    it('reads bare, single-quoted and double-quoted scalars', () => {
        const text = [
            'environment:',
            "    image: 'ghcr.io/acme/ci:1'",
            '    gates:',
            '        - name: lint',
            "          command: 'npm run lint'",
            '        - name: test',
            '          command: "npm test"',
        ].join('\n');
        expect(parseBellows(text)).toEqual({
            image: 'ghcr.io/acme/ci:1',
            gates: [
                { name: 'lint', command: 'npm run lint' },
                { name: 'test', command: 'npm test' },
            ],
        });
    });

    it('keeps colons inside command values', () => {
        const text = [
            'environment:',
            '    image: node:24',
            '    gates:',
            '        - name: test',
            '          command: npx vitest run -t "a: b"',
        ].join('\n');
        expect(parseBellows(text)?.gates[0]?.command).toBe('npx vitest run -t "a: b"');
    });

    it('answers null for an empty or comment-only file', () => {
        expect(parseBellows('')).toBeNull();
        expect(parseBellows('# nothing here\n')).toBeNull();
    });

    it('answers an empty gate list when environment declares no gates', () => {
        expect(parseBellows('environment:\n    image: node:24\n')).toEqual({
            image: 'node:24',
            gates: [],
        });
    });

    it('accepts gates: with a trailing space, as environment: is accepted', () => {
        expect(
            parseBellows(
                'environment: \n    image: node:24\n    gates: \n        - name: test\n          command: npm test\n'
            )
        ).toEqual({ image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] });
    });
});

describe('parseBellows: services block', () => {
    it("skips a top-level services block — the services half is `bellows-services.ts`'s grammar", () => {
        // One file may carry both halves: the services parser reads `services:`, this parser reads
        // `environment:`, and each skips the other's block wholesale rather than judging its
        // grammar — a `- name:` item inside `services:` is Drone's, never a gate list item.
        const text = [
            'environment:',
            '    image: node:24',
            '    gates:',
            '        - name: test',
            '          command: npm test',
            '',
            'services:',
            '    - name: postgres',
            '      image: postgres:17',
            '      environment:',
            '          POSTGRES_PASSWORD: factory',
        ].join('\n');
        expect(parseBellows(text)).toEqual({
            image: 'node:24',
            gates: [{ name: 'test', command: 'npm test' }],
        });
    });

    it('answers null for a services-only file — it declares no gates', () => {
        const text = ['services:', '    - name: db', '      image: postgres:16'].join('\n');
        expect(parseBellows(text)).toBeNull();
    });

    it('rejects a second services block', () => {
        expect(() =>
            parseBellows(
                'services:\n    - name: db\n      image: postgres\nservices:\n    - name: cache\n      image: redis\n'
            )
        ).toThrow(/second "services:" block/);
    });

    it('rejects services with an inline value', () => {
        expect(() => parseBellows('services: [db]\nenvironment:\n    image: node:24\n')).toThrow(
            /services takes a list, not a value/
        );
    });
});

describe("parseBellows: this repository's own .bellows.yaml", () => {
    // The yaml library the ci-workflows checks use accepts what this grammar refuses; the real
    // parser is the one the board runs at claim.
    it('parses under the strict grammar', async () => {
        const text = await readFile(new URL('../../.bellows.yaml', import.meta.url), 'utf8');
        const gates = parseBellows(text)?.gates ?? [];
        expect(gates.map((gate) => gate.name)).toEqual([
            'build:core',
            'test',
            'lint',
            'typecheck',
            'test:db',
            'test:executors',
            'ui',
        ]);
        expect(gates.slice(0, 3)).toEqual([
            { name: 'build:core', command: 'npm run build -w core' },
            { name: 'test', command: 'sh scripts/gate-test-changed.sh', timeoutMinutes: 30 },
            { name: 'lint', command: 'npm run lint' },
        ]);
    });

    // The end-of-run gates run one after another: side by side in one microVM they shared one gate
    // container and its I/O, and every one hit its deadline. build:core runs first, so each
    // later tsc -b of core is an up-to-date no-op. An on_demand gate is not part of that pass.
    it('builds core first, then runs every other end-of-run gate one after another', async () => {
        const text = await readFile(new URL('../../.bellows.yaml', import.meta.url), 'utf8');
        const [first, ...rest] = (parseBellows(text)?.gates ?? []).filter((gate) => !gate.onDemand);
        expect(first).toEqual({ name: 'build:core', command: 'npm run build -w core' });
        expect(rest.length).toBeGreaterThan(0);
        for (const gate of rest) expect(gate.parallel, gate.name).toBeUndefined();
    });

    // The test and test:db gates run only the suites the change reaches; the full suites stay CI's merge
    // gate, and the file says so where the gates are declared.
    it('names CI as the merge gate beside the changed-only gates', async () => {
        const text = await readFile(new URL('../../.bellows.yaml', import.meta.url), 'utf8');
        expect(text).toMatch(/# CI's npm test and npm run test:db stay the merge gate/);
    });

    // The gates run in the dev runner image a release publishes, pinned to one release tag: a moving
    // tag would change the gates' tools under a commit that did not change.
    it('runs its gates in a released dev runner image', async () => {
        const text = await readFile(new URL('../../.bellows.yaml', import.meta.url), 'utf8');
        expect(parseBellows(text)?.image).toMatch(/^ghcr\.io\/bellows-ai\/dev-runner:v\d+\.\d+\.\d+(-rc(-\d+)?)?$/);
    });

    // The suites that need more than `npm test`: each states its own budget, and test:db points at
    // the declared `postgres` service, never at a server of its own. In a microVM the suite waits on
    // round trips and WAL syncs, not CPU: test:db first turns the throwaway service's durability off,
    // then runs eight workers instead of four.
    it('declares typecheck and test:db, each with a timeout', async () => {
        const text = await readFile(new URL('../../.bellows.yaml', import.meta.url), 'utf8');
        const gates = new Map((parseBellows(text)?.gates ?? []).map((gate) => [gate.name, gate]));
        for (const name of ['typecheck', 'test:db']) expect(gates.get(name)?.timeoutMinutes, name).toBeGreaterThan(0);
        expect(gates.get('typecheck')?.command).toBe('npm run typecheck');
        expect(gates.get('test:db')?.command).toBe(
            'sh scripts/gate-pg-fast.sh postgres://factory:factory@postgres:5432/postgres' +
                ' && TEST_DB_WORKERS=8 DATABASE_URL=postgres://factory:factory@postgres:5432/factory_test' +
                ' sh scripts/gate-test-changed.sh --db'
        );
    });

    // The executor gate needs no docker daemon: the in-process driver, supervisor and job-route
    // suites, under the root vitest config and its spawn tier (the script's pretest builds core).
    // The docker lane, npm run test:jobs, runs nightly (.github/workflows/lanes-nightly.yml), as
    // the kind lane does.
    it('declares the executor suites as its docker-free gate, and no test:jobs gate', async () => {
        const text = await readFile(new URL('../../.bellows.yaml', import.meta.url), 'utf8');
        const gates = parseBellows(text)?.gates ?? [];
        expect(gates.find((g) => g.name === 'test:executors')).toEqual({
            name: 'test:executors',
            command: 'npm run test:executors',
            timeoutMinutes: 15,
        });
        expect(gates.filter((g) => /test:jobs|make runners|docker/.test(`${g.name} ${g.command}`))).toEqual([]);
    });

    // The browser check the agent cannot run in its own image: on demand, narrowed to the specs a change
    // touches, and within the 10 minutes an ad-hoc gate run may take. CI's verify:ui stays the full suite.
    it('declares verify:ui as an on-demand, filtered gate the agent may run', async () => {
        const text = await readFile(new URL('../../.bellows.yaml', import.meta.url), 'utf8');
        const gates = parseBellows(text)?.gates ?? [];
        expect(gates.find((g) => g.name === 'ui')).toEqual({
            name: 'ui',
            command: 'sh scripts/gate-ui.sh',
            timeoutMinutes: 10,
            onDemand: true,
            filter: true,
        });
    });

    // The gate image ships no jq and runs as a non-root user; the pr-land suite needs one.
    it('installs jq after npm ci, which would empty node_modules/.bin again', async () => {
        const text = await readFile(new URL('../../.bellows.yaml', import.meta.url), 'utf8');
        expect(parseBellows(text)?.setup).toBe('npm ci && sh scripts/gate-jq.sh');
    });
});

const MAX_GATES = 16;
const OVER_COMMAND_LIMIT_LENGTH = 4100;
/** An environment with an image, opening its gate list: each row appends the gate items. */
const GATES = 'environment:\n    image: node:24\n    gates:\n';
const TOO_MANY_GATES = [
    'environment:',
    '    image: node:24',
    '    gates:',
    ...Array.from({ length: MAX_GATES + 1 }, (_, i) => [
        `        - name: gate-${i}`,
        `          command: echo ${i}`,
    ]).flat(),
].join('\n');

describe('parseBellows: rejects malformed structure, invalid gates and limits', () => {
    // A missing pattern means the row asserts only that the parse throws.
    it.each<[string, string, RegExp | undefined]>([
        [
            'a gate whose command is empty — a vacuously-green check',
            `${GATES}        - name: test\n          command: ''\n`,
            /empty command/,
        ],
        [
            'a gate whose command is absent after the key',
            `${GATES}        - name: test\n          command:\n`,
            undefined,
        ],
        [
            'a whitespace-only quoted command as empty — sh -c would exit green on it',
            `${GATES}        - name: test\n          command: "  "\n`,
            /empty command/,
        ],
        ['a tab indent', 'environment:\n\timage: node:24\n', /tab/i],
        ['an unknown top-level key', `pipeline:\n    steps: []\n${EXAMPLE}`, /pipeline/],
        ['an unknown key inside environment', 'environment:\n    image: node:24\n    timeout: 30\n', /timeout/],
        // A runner class is an org admin's choice on an executor profile: a repo never names one.
        ['a top-level runnerClass', `runnerClass: sandboxed\n${EXAMPLE}`, /runnerClass/],
        [
            'a runnerClass inside environment',
            'environment:\n    image: node:24\n    runnerClass: sandboxed\n',
            /runnerClass/,
        ],
        ['an unknown field in a gate', `${GATES}        - name: test\n          cwd: /app\n`, /cwd/],
        [
            'gates without an image',
            'environment:\n    gates:\n        - name: test\n          command: npm t\n',
            /image/,
        ],
        ['an empty environment block', 'environment:\n', /environment/],
        ['more than 16 gates', TOO_MANY_GATES, /16/],
        [
            'a command longer than 4096 characters',
            `${GATES}        - name: test\n          command: echo ${'x'.repeat(OVER_COMMAND_LIMIT_LENGTH)}\n`,
            /4096/,
        ],
        [
            'a gate name with a slash, which cannot be a path segment',
            `${GATES}        - name: a/b\n          command: x\n`,
            /name/,
        ],
        ['a gate name that reads as a flag', `${GATES}        - name: -rf\n          command: x\n`, /name/],
        ['an empty gate name', `${GATES}        - name: ''\n          command: x\n`, /name/],
        ...['0', '121', '1.5', 'ten', '""'].map((value): [string, string, RegExp] => [
            `a gate timeout of ${value}`,
            `${EXAMPLE}\n           timeout: ${value}`,
            /line 6: timeout is whole minutes, 1 to 120/,
        ]),
        ...['false', 'yes', '""'].map((value): [string, string, RegExp] => [
            `an on_demand of ${value} — the one value is true`,
            `${EXAMPLE}\n           on_demand: ${value}`,
            /line 6: on_demand must be "true"/,
        ]),
        [
            'an unknown gate field, naming timeout, on_demand, filter and parallel among the fields read',
            `${EXAMPLE}\n           retries: 2`,
            /unknown gate field "retries" — only name, command, timeout, on_demand, filter and parallel are read/,
        ],
        [
            'duplicate gate names',
            `${GATES}        - name: test\n          command: a\n        - name: test\n          command: b\n`,
            /twice|duplicate/i,
        ],
        ['an image that smuggles a docker flag', 'environment:\n    image: -v /:/host\n    gates: []\n', /image/],
        ['an image that smuggles whitespace', 'environment:\n    image: node:24 alpine\n    gates: []\n', /image/],
        ['an image that smuggles an expansion', 'environment:\n    image: node:$TAG\n    gates: []\n', /image/],
        ['a mismatched or unclosed quote', `${GATES}        - name: test\n          command: 'npm test\n`, /quote/],
        ['a gate item missing its command', `${GATES}        - name: test\n`, /command/],
    ])('rejects %s', (_label, yaml, pattern) => {
        expect(() => parseBellows(yaml)).toThrow(pattern);
    });
});
