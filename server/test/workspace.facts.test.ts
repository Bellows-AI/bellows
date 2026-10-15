import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFactsCache } from '../src/workspace/facts.js';

/** Lets the cache's single-flight refresh promise settle: the reads are real subprocesses, so the loop must reach the timer phase, not just the microtask queue. */
const settle = async () => {
    while (cache.get(dir).sizeBytes === null) await new Promise((r) => setTimeout(r, 5));
};

/**
 * The facts cache against a real git checkout — the branch and commit reads are one `git log`, and
 * faking git here would test the fake. The suite builds one bare-fixture checkout of its own, the
 * same way workspace.reconcile.test.ts does, with every identity pinned on the command line so the
 * runner's global git config cannot leak in.
 */

let dir = '';
let cache: ReturnType<typeof createFactsCache>;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-facts-'));
    const run = (args: string[], cwd?: string) =>
        execFileSync('git', ['-c', 'user.email=t@f.io', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
            cwd,
        });
    run(['init', '-b', 'main', dir]);
    writeFileSync(join(dir, 'file.txt'), 'one\n');
    run(['add', '.'], dir);
    run(['commit', '-m', 'first'], dir);
    cache = createFactsCache();
});

afterAll(() => {
    execFileSync('rm', ['-rf', '--', dir]);
});

describe('the facts cache', () => {
    it('measures a real checkout once the refresh settles', async () => {
        const facts = cache.get(dir);
        // Cold: nothing has been measured yet, and none of it is awaited.
        expect(facts.sizeBytes).toBeNull();
        await settle();
        const measured = cache.get(dir);
        expect(measured.sizeBytes).toBeGreaterThan(0);
        expect(measured.branch).toBe('main');
        expect(measured.lastCommit?.headline).toBe('first');
    });

    it('forgets a directory it is told to invalidate', async () => {
        cache.get(dir);
        await settle();
        expect(cache.get(dir).sizeBytes).toBeGreaterThan(0);

        cache.invalidate(dir);
        const cold = cache.get(dir);
        // A deleted tree's facts must not survive it: the next get is a cold entry, so a
        // re-cloned checkout can never briefly show its predecessor's size or commit.
        expect(cold).toEqual({ branch: null, lastCommit: null, sizeBytes: null });
    });

    // Issue #734: the per-repo package cache is a size reading only — no git, and null until measured.
    it('measures a size-only directory, null while cold or absent', async () => {
        const sized = createFactsCache();
        const root = dirname(dir);
        expect(sized.sizeOf(dir, root)).toBeNull();
        while (sized.sizeOf(dir, root) === null) await new Promise((r) => setTimeout(r, 5));
        expect(sized.sizeOf(dir, root)).toBeGreaterThan(0);

        const missing = join(dir, 'no-such-cache');
        sized.sizeOf(missing, root);
        for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 5));
        expect(sized.sizeOf(missing, root)).toBeNull();
    });

    it('measures a cache directory as soon as it appears, not a size TTL later', async () => {
        const sized = createFactsCache();
        const late = join(dir, 'late-cache');
        sized.sizeOf(late, dir);
        for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 5));
        expect(sized.sizeOf(late, dir)).toBeNull();

        // A run creates the cache: the absent reading must not be held for the five-minute TTL.
        mkdirSync(late);
        writeFileSync(join(late, 'pkg'), 'x'.repeat(4096));
        for (let i = 0; i < 400 && sized.sizeOf(late, dir) === null; i += 1) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(sized.sizeOf(late, dir)).toBeGreaterThan(0);
    });

    // The cache path runs through directories a member's agent can write: a symlink there must
    // never make the board (which sees every org's tree) measure a directory outside the member's.
    it.each([
        ['an intermediate component', (member: string, victim: string) => symlinkSync(victim, join(member, '.cache'))],
        [
            'the final component',
            (member: string, victim: string) => {
                mkdirSync(join(member, '.cache', 'acme'), { recursive: true });
                symlinkSync(join(victim, 'acme', 'web'), join(member, '.cache', 'acme', 'web'));
            },
        ],
    ])('never measures through a symlink in %s that leaves the member tree', async (_where, plant) => {
        const member = mkdtempSync(join(tmpdir(), 'factory-member-'));
        const victim = mkdtempSync(join(tmpdir(), 'factory-victim-'));
        mkdirSync(join(victim, 'acme', 'web'), { recursive: true });
        writeFileSync(join(victim, 'acme', 'web', 'blob'), 'v'.repeat(65_536));
        plant(member, victim);
        const cacheDir = join(member, '.cache', 'acme', 'web');

        const sized = createFactsCache();
        sized.sizeOf(cacheDir, member);
        for (let i = 0; i < 100; i += 1) await new Promise((r) => setTimeout(r, 5));
        expect(sized.sizeOf(cacheDir, member)).toBeNull();
    });
});
