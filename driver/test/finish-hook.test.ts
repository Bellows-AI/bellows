import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT, readRepoFile as read } from './fixtures/repo-files.js';

/*
 * Claude Code's gate Stop hook: it runs the shared finish helper (`factory-finish.cjs`, beside it in
 * /usr/local/bin) and blocks the stop with the helper's text only when the helper says so (exit 10).
 * Anything else lets the stop through. It never reads `stop_hook_active`: the driver's round counter
 * is the only bound on the loop. Driven against a stand-in helper staged beside a copy of the hook.
 */
const HOOK = join(ROOT, 'docker/claude-executor/finish-hook.cjs');

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the hook beside a stand-in helper that prints `stdout` and exits `code`. */
const staged = (code: number, stdout: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'finish-hook-'));
    dirs.push(dir);
    copyFileSync(HOOK, join(dir, 'finish-hook.cjs'));
    writeFileSync(
        join(dir, 'factory-finish.cjs'),
        `process.stdout.write(${JSON.stringify(stdout)}, () => process.exit(${code}));\n`
    );
    chmodSync(join(dir, 'factory-finish.cjs'), 0o755);
    return join(dir, 'finish-hook.cjs');
};

const runHook = (hook: string, input: unknown): string =>
    execFileSync('node', [hook], { env: { PATH: process.env.PATH ?? '' }, input: JSON.stringify(input) }).toString();

const PROMPT = 'The "test" gate failed (round 1 of 3). Fix the cause.\n\nGate output:\nexpected "a" to be \'b\'';

describe('the finish Stop hook', () => {
    it('blocks the stop with the helper’s text on exit 10', () => {
        expect(JSON.parse(runHook(staged(10, PROMPT), { stop_hook_active: false }))).toEqual({
            decision: 'block',
            reason: PROMPT,
        });
    });

    it('still blocks when the stop is already continuing from a stop hook', () => {
        expect(JSON.parse(runHook(staged(10, PROMPT), { stop_hook_active: true }))).toEqual({
            decision: 'block',
            reason: PROMPT,
        });
    });

    it.each([
        ['a pass (exit 0)', 0, ''],
        ['exit 0 with text', 0, 'stray'],
        ['exit 10 with nothing to say', 10, ''],
        ['an unexpected exit', 1, PROMPT],
        ['a retryable exit', 75, PROMPT],
    ])('says nothing on %s', (_label, code, stdout) => {
        expect(runHook(staged(code, stdout), { stop_hook_active: false })).toBe('');
    });

    it('says nothing when the helper is missing', () => {
        const dir = mkdtempSync(join(tmpdir(), 'finish-hook-'));
        dirs.push(dir);
        copyFileSync(HOOK, join(dir, 'finish-hook.cjs'));
        expect(runHook(join(dir, 'finish-hook.cjs'), {})).toBe('');
    });

    it('never reads stop_hook_active or the control credential', () => {
        expect(read('docker/claude-executor/finish-hook.cjs')).not.toMatch(/stop_hook_active|token|authorization/i);
    });

    it('is registered beside the prose-question prompt hook in the Stop group, with a timeout in hours', () => {
        const settings = JSON.parse(read('docker/claude-executor/claude-home/settings.json')) as {
            hooks: { Stop: { hooks: { type: string; command?: string; timeout?: number }[] }[] };
        };
        const hooks = settings.hooks.Stop.flatMap((entry) => entry.hooks);
        expect(hooks.map((hook) => hook.type)).toEqual(['prompt', 'command']);
        expect(hooks[1]).toEqual({ type: 'command', command: 'node /usr/local/bin/finish-hook.cjs', timeout: 21600 });
    });

    it('is copied to /usr/local/bin beside the shared helper', () => {
        const dockerfile = read('docker/claude-executor/Dockerfile');
        expect(dockerfile).toMatch(/COPY finish-hook\.cjs \/usr\/local\/bin\/finish-hook\.cjs\n/);
        expect(dockerfile).toMatch(/COPY --from=common factory-finish\.cjs \/usr\/local\/bin\/factory-finish\.cjs\n/);
        expect(dockerfile).toMatch(/chmod 0755 [^\n]*\/usr\/local\/bin\/finish-hook\.cjs\b/);
    });
});
