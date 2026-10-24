import { spawn } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Resolved lazily: a missing devDependency must fail the behavior cases, not
// abort suite collection before the declarative cases report.
const biomeBin = () =>
    join(dirname(createRequire(import.meta.url).resolve('@biomejs/biome/package.json')), 'bin', 'biome');

interface BiomeResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

// A `biome check` is the suite's heaviest kind of spawn: most of its time is the up-front project
// scan, which alone can exceed the shared 30s budget under a full run's contention whatever the
// path argument (measured: ~29s for driver/src on an idle 5-core runner). Every check spawn gets
// its own longer allowance rather than raising the global one for every other, far lighter test.
// 120s was not enough: a gate run on a loaded runner pod took ~250s end to end (usual ~120s) and
// the tree-wide pass alone ran past 120s, while the same tree passed in the next run.
const BIOME_CHECK_TIMEOUT_MS = 300_000;

// Asynchronous on purpose, never spawnSync: a tree-wide pass takes over a minute on a contended
// box, and blocking the worker's event loop that long times out every vitest RPC in flight
// ("Timeout calling onTaskUpdate" — birpc's fixed 60s). Every test still passes, but the run
// reports unhandled errors and exits 1. Output is collected unbounded, so a tree-wide format
// drift's per-file diff reaches the failure message whole.
//
// Its own process group, killed whole at the check budget: `bin/biome` is a node wrapper around
// the native binary, so killing the wrapper alone leaves the native check running — an orphan
// that eats the CPU every later test in the run needs.
const runBiome = (args: string[], options: { cwd?: string; input?: string } = {}): Promise<BiomeResult> =>
    new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [biomeBin(), ...args], { cwd: options.cwd ?? root, detached: true });
        const deadline = setTimeout(() => {
            try {
                process.kill(-child.pid!, 'SIGKILL');
            } catch {
                // Already gone.
            }
        }, BIOME_CHECK_TIMEOUT_MS);
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (status) => {
            clearTimeout(deadline);
            resolve({ status, stdout, stderr });
        });
        child.stdin.end(options.input);
    });

interface PluginDiagnostics {
    messages: string[];
    errored: string[];
}

/**
 * `biome lint` over a scratch tree holding `files` (paths relative to its root), with the repo's
 * `biome.json` and a `lint/` symlink to `lintDir`. Plugins key on `$filename`, so a probe has to be
 * a real file under the path the plugin is scoped to — and never touches the repository. Empty or
 * unparsable output throws: an unreadable report is not a clean one.
 */
const lintScratch = async (files: Record<string, string>, lintDir = join(root, 'lint')): Promise<PluginDiagnostics> => {
    const dir = mkdtempSync(join(tmpdir(), 'biome-scratch-'));
    try {
        const config = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8'));
        config.vcs.enabled = false;
        writeFileSync(join(dir, 'biome.json'), JSON.stringify(config));
        symlinkSync(lintDir, join(dir, 'lint'));
        for (const [path, source] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            writeFileSync(join(dir, path), source);
        }
        const result = await runBiome(['lint', '.', '--reporter=json', '--max-diagnostics=200'], { cwd: dir });
        expect(result.stdout, `biome printed no JSON report:\n${result.stderr}`).not.toBe('');
        const report = JSON.parse(result.stdout) as { diagnostics?: { category?: string; message?: string }[] };
        const plugin = (report.diagnostics ?? []).filter((d) => d.category === 'plugin');
        return {
            messages: plugin.map((d) => d.message ?? ''),
            errored: plugin.filter((d) => /errored:/.test(d.message ?? '')).map((d) => d.message ?? ''),
        };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

describe('biome', () => {
    it('is configured at the root with the style the tree is written in', () => {
        expect(existsSync(join(root, 'biome.json')), 'biome.json missing at the repo root').toBe(true);
        const config = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8'));
        expect(config.formatter).toMatchObject({
            indentStyle: 'space',
            indentWidth: 4,
            lineWidth: 120,
            lineEnding: 'lf',
        });
        expect(config.javascript.formatter).toMatchObject({
            quoteStyle: 'single',
            jsxQuoteStyle: 'double',
            semicolons: 'always',
            trailingCommas: 'es5',
            arrowParentheses: 'always',
        });
        expect(config.linter).toMatchObject({ enabled: true });
        expect(config.linter.rules.preset).toBe('recommended');
        for (const glob of ['core/**', 'server/**', 'web/**', 'driver/**', 'cli/**']) {
            expect(config.files.includes).toContain(glob);
        }
    });

    it('loads every lint plugin in lint/', () => {
        const config = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8'));
        for (const plugin of [
            './lint/no-shared-literals.grit',
            './lint/no-inline-container-scripts.grit',
            './lint/no-cross-package-imports.grit',
            './lint/no-silent-empty-read.grit',
        ]) {
            expect(config.plugins, `${plugin} is not loaded`).toContain(plugin);
            expect(existsSync(join(root, plugin)), `${plugin} is missing`).toBe(true);
        }
    });

    /**
     * A Grit plugin that fails to compile does NOT fail the run: Biome reports
     * "<plugin> errored: …" once per file at `info` severity and then matches nothing, so a broken
     * ratchet is indistinguishable from a clean one. The known way in is a regex alternation group
     * — Grit binds a group to a variable, so `(src|test)` compiles to "matched 1 variables, but
     * expected 0". Assert the absence of that message, not just the absence of hits.
     *
     * Run against a scratch tree of a few tiny files, never the repository: Biome's cost is its
     * up-front project scan, so the guard takes about a second and the tree-wide pass stays with
     * `npm run lint` (CI `validate`). The error surfaces only when a regex is evaluated and
     * matches, so the fixtures sit on paths that reach each plugin's first path regex and hold a
     * violation behind each of shared-literals' pre-check gates; the static case below covers the
     * regexes no fixture reaches.
     */
    describe('plugin compile guard', () => {
        const FIXTURES: Record<string, string> = {
            'driver/src/k8s/k8s-probe.ts': [
                "export const a = await deps.request('GET', '/x').catch(() => null);",
                "import { y } from '@factory-ai/core';",
                "export const c = 'claude-code';",
                "export const d = 'factory.job';",
                "export const e = 'NOT_FOUND';",
            ].join('\n'),
            'driver/src/probe-script.ts': "export const v = ['node', '-e', 'x'];",
            'driver/test/probe-script.ts': "export const v = ['node', '-e', 'x'];",
            'core/src/executors.ts': "export const w = 'claude-code';",
            'server/src/probe.ts': "import { z } from '../../core/src/x.js';",
        };
        // One distinctive phrase per plugin message: each plugin must hit its fixture, so a plugin
        // that loads but matches nothing fails here too.
        const HITS: Record<string, RegExp> = {
            'no-cross-package-imports': /copy the type instead/,
            'no-inline-container-scripts': /Container script passed inline/,
            'no-shared-literals': /^Shared literal/,
            'no-silent-empty-read': /A failed read must stay inconclusive/,
        };

        it('has a fixture hit for every plugin in lint/', () => {
            const plugins = readdirSync(join(root, 'lint'))
                .filter((f) => f.endsWith('.grit'))
                .map((f) => f.slice(0, -'.grit'.length))
                .sort();
            expect(plugins).toEqual(Object.keys(HITS).sort());
        });

        it(
            'runs every plugin without a compile error and with a hit',
            async () => {
                const found = await lintScratch(FIXTURES);
                expect(found.errored, 'a lint plugin failed to compile').toEqual([]);
                for (const [plugin, hit] of Object.entries(HITS)) {
                    expect(
                        found.messages.some((m) => hit.test(m)),
                        `${plugin} reported nothing on its fixtures`
                    ).toBe(true);
                }
            },
            BIOME_CHECK_TIMEOUT_MS
        );

        // Deliberately broken plugin, one per file in lint/: the first path regex gains a capture
        // group. The control proves the guard can fail, for every plugin, on every run.
        it.each(Object.keys(HITS))(
            'fails when %s is broken',
            async (plugin) => {
                const lintDir = mkdtempSync(join(tmpdir(), 'broken-lint-'));
                try {
                    for (const f of readdirSync(join(root, 'lint'))) {
                        const text = readFileSync(join(root, 'lint', f), 'utf8');
                        writeFileSync(
                            join(lintDir, f),
                            f === `${plugin}.grit` ? text.replace(/r"\.\*\//, 'r"(.*)/') : text
                        );
                    }
                    const found = await lintScratch(FIXTURES, lintDir);
                    expect(found.errored.some((m) => m.startsWith(`${plugin} errored:`))).toBe(true);
                } finally {
                    rmSync(lintDir, { recursive: true, force: true });
                }
            },
            BIOME_CHECK_TIMEOUT_MS
        );

        // Most regexes sit behind a predicate no fixture reaches, so the known break is also
        // refused statically: a capture group in any `r"…"` of any plugin. Escapes and character
        // classes are removed first, so `\(` and `[(]` are literals, not groups.
        const hasCaptureGroup = (regex: string): boolean =>
            /\((?!\?:)/.test(regex.replace(/\\.|\[(?:\\.|[^\]\\])*\]/g, ''));

        it('tells a capture group from a literal parenthesis', () => {
            expect(hasCaptureGroup('.*/(src|test)/.*')).toBe(true);
            expect(hasCaptureGroup('.*/(?<dir>src)/.*')).toBe(true);
            expect(hasCaptureGroup('.*/(?:src|test)/.*')).toBe(false);
            expect(hasCaptureGroup('.*/roles\\(\\)\\.ts$')).toBe(false);
            expect(hasCaptureGroup('.*/roles[(][)]\\.ts$')).toBe(false);
            expect(hasCaptureGroup('.*/x[\\]()]')).toBe(false);
            expect(hasCaptureGroup('.*/x[a](b)')).toBe(true);
        });

        it('has no capture group in any plugin regex', () => {
            for (const f of readdirSync(join(root, 'lint')).filter((n) => n.endsWith('.grit'))) {
                const regexes = [...readFileSync(join(root, 'lint', f), 'utf8').matchAll(/\br"((?:[^"\\]|\\.)*)"/g)];
                expect(regexes.length, `${f} has no path regex to check`).toBeGreaterThan(0);
                for (const [, body] of regexes) {
                    expect(
                        hasCaptureGroup(body ?? ''),
                        `${f}: capture group in r"${body}" (use (?:…) or separate regexes)`
                    ).toBe(false);
                }
            }
        });
    });

    /**
     * `lint/no-silent-empty-read.grit` is run against a scratch tree so the probe is a real file
     * under a `driver/src/` path (the plugin keys on `$filename`) and never touches the repo. Each
     * positive line is one refused shape; each negative line is a carve-out or a non-read.
     */
    describe('no-silent-empty-read', () => {
        const probe = (source: string, path = 'driver/src/k8s/k8s-probe.ts'): Promise<PluginDiagnostics> =>
            lintScratch({ [path]: source });

        it(
            'refuses each shape of a failed read collapsed into an empty answer',
            async () => {
                const found = await probe(
                    [
                        "export const a = await deps.request('GET', '/x').catch(() => null);",
                        "export const b = await execDocker(['ps']).catch(() => []);",
                        "export const c = await execDocker(['ps']).catch(() => undefined);",
                        "export async function f() { try { return await deps.request('GET', '/y'); } catch { return null; } }",
                        'export const d = JSON.parse(text) as { a: string };',
                    ].join('\n')
                );
                expect(found.errored).toEqual([]);
                expect(found.messages).toHaveLength(5);
            },
            BIOME_CHECK_TIMEOUT_MS
        );

        it(
            'refuses an unchecked JSON.parse cast in the k8s and docker executor folders only',
            async () => {
                const cast = 'export const d = JSON.parse(text) as { a: string };';
                const hits = async (path: string): Promise<number> => (await probe(cast, path)).messages.length;
                expect(await hits('driver/src/k8s/k8s-probe.ts')).toBe(1);
                expect(await hits('driver/src/docker/docker-probe.ts')).toBe(1);
                expect(await hits('driver/src/loop/loop-probe.ts')).toBe(0);
            },
            BIOME_CHECK_TIMEOUT_MS
        );

        it(
            'leaves removals, kills and the named carve-outs alone',
            async () => {
                const found = await probe(
                    [
                        "export const a = await execDocker(['rm', '-f', 'x']).catch(() => null);",
                        "export const b = await execDocker(['kill', 'x']).catch(() => []);",
                        "await execDocker(['ps']).catch(() => undefined);",
                        "export const c = await execDocker(['stats', 'x']).catch(() => null);",
                        'export const d = await execDocker(servicePsArgs(job)).catch(() => null);',
                        'export const e = await ctx.execDocker(opencodeCacheProbeArgs(c, j)).catch(() => null);',
                        "export const g = await deps.request('GET', path).catch(() => null);",
                        "export async function h() { try { return await deps.request('GET', jobPodsPath(n, r)); } catch { return null; } }",
                        'export const i = JSON.parse(t) as { kind?: unknown };',
                        'export const j = JSON.parse(t) as { Status?: string };',
                    ].join('\n')
                );
                expect(found.errored).toEqual([]);
                expect(found.messages).toEqual([]);
            },
            BIOME_CHECK_TIMEOUT_MS
        );

        it('names exactly the documented carve-outs', () => {
            const grit = readFileSync(join(root, 'lint/no-silent-empty-read.grit'), 'utf8');
            for (const token of [
                "'stats'",
                'servicePsArgs($...)',
                'opencodeCacheProbeArgs($...)',
                "$_.request('GET', path)",
                "$_.request('GET', jobPodsPath($...))",
                'kind[?]: unknown',
                'Status[?]: string',
            ]) {
                expect(grit, `carve-out ${token} is missing from the plugin`).toContain(token);
            }
        });
    });

    it('exposes the lint and format scripts and an exact-pinned biome devDependency', () => {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        expect(pkg.scripts.lint).toBe('biome check .');
        expect(pkg.scripts['lint:changed']).toBe('sh scripts/lint-changed.sh');
        expect(pkg.scripts.format).toBe('biome format --write .');
        expect(pkg.devDependencies['@biomejs/biome']).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('formats a violating snippet into the pinned style', async () => {
        const messy = 'const a = 1\nfunction f() {\n\treturn "text";\n}\n';
        const result = await runBiome(['format', '--stdin-file-path=core/style-probe.ts'], { input: messy });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("const a = 1;\nfunction f() {\n    return 'text';\n}\n");
    });

    it('still fails a file that violates a rule (negative control)', async () => {
        const result = await runBiome(['lint', '--stdin-file-path=core/bad-probe.ts'], { input: 'debugger;\n' });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).not.toBe('');
    });
});
