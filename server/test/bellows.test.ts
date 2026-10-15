import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBellows, readGatesFile } from '../src/workspace/bellows.js';

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
    it("skips a top-level services block — the services half is the driver parser's grammar", () => {
        // One file may carry both halves: the driver reads `services:`, this parser reads
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
        expect(parseBellows(text)?.gates).toEqual([
            { name: 'test', command: 'npm test' },
            { name: 'lint', command: 'npm run lint' },
        ]);
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
            'an unknown gate field, naming timeout and on_demand among the fields read',
            `${EXAMPLE}\n           retries: 2`,
            /unknown gate field "retries" — only name, command, timeout and on_demand are read/,
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

describe('readGatesFile: repo tree resolution', () => {
    const USER = '0b9e6c50-8d13-4b8e-9dfb-2fa2d1ba4c71';
    const seam = (content: string | Error) => (_path: string) =>
        content instanceof Error ? Promise.reject(content) : Promise.resolve(content);

    it('reads the repo checkout root under the member tree, by repo NAME', async () => {
        const seen: string[] = [];
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: `4f7d3c2e-1a9b-4c8d-8e2f-3a5b6c7d8e9f/${USER}`,
            repo: 'Bellows-AI/factory',
            readFile: (path) => {
                seen.push(path);
                return Promise.resolve(EXAMPLE);
            },
        });
        expect(seen).toEqual([`/workspaces/4f7d3c2e-1a9b-4c8d-8e2f-3a5b6c7d8e9f/${USER}/factory/.bellows.yaml`]);
        expect(result).toEqual({
            config: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            error: null,
            source: 'clone',
        });
    });

    it('answers no gates for a missing file — the normal repository', async () => {
        const error = Object.assign(new Error('nope'), { code: 'ENOENT' });
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: `o/${USER}`,
            repo: 'o/r',
            readFile: seam(error),
        });
        expect(result).toEqual({ config: null, error: null, source: 'clone' });
    });

    it('answers a named error for any other read failure', async () => {
        const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: `o/${USER}`,
            repo: 'o/r',
            readFile: seam(error),
        });
        expect(result.config).toBeNull();
        expect(result.error).toMatch(/permission denied/);
    });

    it('answers a named error for a file outside the accepted grammar', async () => {
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: `o/${USER}`,
            repo: 'o/r',
            readFile: seam('pipeline:\n    steps: []\n'),
        });
        expect(result.config).toBeNull();
        expect(result.error).toMatch(/pipeline/);
    });

    it('reads nothing without a workspace root or a repo label', async () => {
        const seen: string[] = [];
        const readFile = (path: string) => {
            seen.push(path);
            return Promise.resolve(EXAMPLE);
        };
        expect(await readGatesFile({ root: null, workspacePath: `o/${USER}`, repo: 'o/r', readFile })).toEqual({
            config: null,
            error: null,
            source: null,
        });
        expect(await readGatesFile({ root: '/w', workspacePath: `o/${USER}`, repo: null, readFile })).toEqual({
            config: null,
            error: null,
            source: null,
        });
        expect(seen).toEqual([]);
    });

    it('refuses a workspace path whose user segment is not a uuid', async () => {
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: 'org/../shared',
            repo: 'o/r',
            readFile: seam(EXAMPLE),
        });
        expect(result.config).toBeNull();
        expect(result.error).toMatch(/workspace path is not <orgId>\/<userId>/);
    });
});

/*
 * The per-task worktree (issue #35): the run edits `<ws>/.worktrees/<root id>`, and the
 * gates it must satisfy live THERE. The read prefers the worktree's file and falls back to
 * the clone — at claim time the worktree does not exist yet, so the clone's file is the
 * claim's answer, and the post-sync re-read finds the worktree's.
 */
describe('readGatesFile: worktree precedence', () => {
    const USER = '0b9e6c50-8d13-4b8e-9dfb-2fa2d1ba4c71';
    const ROOT = '55555555-5555-4555-8555-555555555555';

    it('reads the worktree first and falls back to the clone when the worktree has none', async () => {
        const seen: string[] = [];
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: `o/${USER}`,
            repo: 'o/r',
            worktreeId: ROOT,
            readFile: (path) => {
                seen.push(path);
                return seen.length === 1
                    ? Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }))
                    : Promise.resolve(EXAMPLE);
            },
        });
        expect(seen).toEqual([
            `/workspaces/o/${USER}/.worktrees/${ROOT}/.bellows.yaml`,
            `/workspaces/o/${USER}/r/.bellows.yaml`,
        ]);
        // Issue #444: the claim's answer names the tree it came from — the clone here, which the
        // driver must not gate against if its post-sync re-read is refused.
        expect(result).toEqual({
            config: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            error: null,
            source: 'clone',
        });
    });

    it('takes the worktree’s declaration when the worktree has one', async () => {
        const seen: string[] = [];
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: `o/${USER}`,
            repo: 'o/r',
            worktreeId: ROOT,
            readFile: (path) => {
                seen.push(path);
                return Promise.resolve(
                    'environment:\n    image: node:20\n    gates:\n        - name: wt\n          command: "npm test"\n'
                );
            },
        });
        // The worktree's file is authoritative for the gates once it exists; the clone's is read
        // too, for the evidence policy only — the worktree is the run's to edit.
        expect(seen).toEqual([
            `/workspaces/o/${USER}/.worktrees/${ROOT}/.bellows.yaml`,
            `/workspaces/o/${USER}/r/.bellows.yaml`,
        ]);
        expect(result.config?.image).toBe('node:20');
        expect(result.error).toBeNull();
        expect(result.source).toBe('worktree');
    });

    it('names the worktree as the source of a worktree read failure, and the clone when neither has a file', async () => {
        const failing = await readGatesFile({
            root: '/workspaces',
            workspacePath: `o/${USER}`,
            repo: 'o/r',
            worktreeId: ROOT,
            readFile: () => Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
        });
        expect(failing).toEqual({ config: null, error: 'permission denied', source: 'worktree' });
        const missing = await readGatesFile({
            root: '/workspaces',
            workspacePath: `o/${USER}`,
            repo: 'o/r',
            worktreeId: ROOT,
            readFile: () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' })),
        });
        expect(missing).toEqual({ config: null, error: null, source: 'clone' });
    });

    it('refuses a worktree id that is not a uuid, before it joins a path', async () => {
        const seen: string[] = [];
        const result = await readGatesFile({
            root: '/workspaces',
            workspacePath: `o/${USER}`,
            repo: 'o/r',
            worktreeId: '../../etc',
            readFile: (path) => {
                seen.push(path);
                return Promise.resolve(EXAMPLE);
            },
        });
        expect(seen).toEqual([]);
        expect(result.config).toBeNull();
        expect(result.error).toMatch(/worktree id is not a uuid/);
    });
});

/**
 * `readGatesFile` against a real checkout under `os.tmpdir()` — the seam tests above pin the
 * path and error plumbing, these pin what the default reader does with the filesystem itself:
 * a checkout-authored `.bellows.yaml` can be a symlink, so the read must refuse one rather than
 * follow it, and the size bound must survive a rewrite of the reader. Each test gets its own
 * mkdtemp tree and removes it.
 */
describe('readGatesFile against a real checkout', () => {
    const ORG = '4f7d3c2e-1a9b-4c8d-8e2f-3a5b6c7d8e9f';
    const USER = '0b9e6c50-8d13-4b8e-9dfb-2fa2d1ba4c71';
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'bellows-read-'));
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const checkoutWith = async (write: (checkout: string) => Promise<void>): Promise<void> => {
        const checkout = join(root, ORG, USER, 'factory');
        await mkdir(checkout, { recursive: true });
        await write(checkout);
    };

    const read = (): Promise<{ config: unknown; error: string | null }> =>
        readGatesFile({ root, workspacePath: `${ORG}/${USER}`, repo: 'Bellows-AI/factory' }) as Promise<{
            config: unknown;
            error: string | null;
        }>;

    it('refuses a .bellows.yaml that is a symlink out of the checkout, never leaking the target', async () => {
        const secret = join(root, 'outside.txt');
        await writeFile(secret, 'TOPSECRET-CREDENTIALS\n');
        await checkoutWith(async (checkout) => symlink(secret, join(checkout, '.bellows.yaml')));

        const result = await read();
        expect(result.config).toBeNull();
        expect(result.error).toBeTruthy();
        expect(result.error).not.toMatch(/TOPSECRET/);
    });

    // The checkout directory and `.worktrees/<id>` are the member's agent's to write: a symlinked
    // directory above the file must not make the board read another member's `.bellows.yaml`.
    it.each([
        ['the checkout directory', undefined],
        ['the task worktree', '5c8d2a1e-3b4f-4a6c-9d8e-7f6a5b4c3d2e'],
    ])("never reads another member's gates through a symlinked %s", async (_where, worktreeId) => {
        const victim = join(root, ORG, 'a1c2e3f4-5b6d-4e7f-8a9b-0c1d2e3f4a5b', 'factory');
        await mkdir(victim, { recursive: true });
        await writeFile(join(victim, '.bellows.yaml'), EXAMPLE.replace('npm test', 'VICTIM-SECRET-COMMAND'));
        const member = join(root, ORG, USER);
        await mkdir(join(member, '.worktrees'), { recursive: true });
        await symlink(victim, worktreeId ? join(member, '.worktrees', worktreeId) : join(member, 'factory'));

        const result = await readGatesFile({
            root,
            workspacePath: `${ORG}/${USER}`,
            repo: 'Bellows-AI/factory',
            worktreeId,
        });
        expect(JSON.stringify(result)).not.toContain('VICTIM-SECRET-COMMAND');
        expect(result.config).toBeNull();
        expect(result.error).toBeTruthy();
    });

    it('refuses an oversized .bellows.yaml with the size-limit error', async () => {
        const OVER_BELLOWS_LIMIT_BYTES = 65537;
        await checkoutWith(async (checkout) =>
            writeFile(join(checkout, '.bellows.yaml'), 'x'.repeat(OVER_BELLOWS_LIMIT_BYTES))
        );
        const result = await read();
        expect(result.config).toBeNull();
        expect(result.error).toMatch(/larger than 65536 bytes/);
    });

    it('refuses a whitespace-only quoted command read from disk', async () => {
        await checkoutWith(async (checkout) =>
            writeFile(
                join(checkout, '.bellows.yaml'),
                'environment:\n    image: node:24\n    gates:\n        - name: test\n          command: "  "\n'
            )
        );
        const result = await read();
        expect(result.config).toBeNull();
        expect(result.error).toMatch(/empty command/);
    });

    it('parses an ordinary valid file from disk', async () => {
        await checkoutWith(async (checkout) => writeFile(join(checkout, '.bellows.yaml'), EXAMPLE));
        const result = await read();
        expect(result).toEqual({
            config: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            error: null,
            source: 'clone',
        });
    });
});
