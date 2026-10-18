import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { git, makeOriginClone } from './fixtures/git-worktree-support.js';
import { hasGit, pathOf } from './fixtures/scripts-support.js';

/**
 * The tool uid's release of a task tree before its terminal reclaim (issue #814), against real git:
 * a directory a tool made with an explicit mode (`mkdir -m 555`, a read-only module cache) cannot be
 * emptied by the uid-1000 reclaim until the uid that owns it gives it group rwx. One uid plays both
 * here — an owner without write on a directory cannot unlink in it either — so the pass and the
 * reclaim are the same scripts the containers run, and only the uid split is the executors'.
 */
describe.skipIf(!hasGit())('the tool tree release', () => {
    const ROOT = '88888888-8888-4888-8888-888888888888';
    let dir: string;
    let clone: string;

    const release = (worktree: string, preload?: string): { released: number; skipped: number } =>
        JSON.parse(
            execFileSync('node', [...(preload ? ['--require', preload] : []), pathOf('tool-tree-release.cjs')], {
                env: { ...process.env, WORKTREE: worktree },
                encoding: 'utf8',
            })
        );

    const reclaim = (worktree: string): { ok: boolean; removed?: boolean; reason?: string } => {
        const stdout = execFileSync('node', [pathOf('git-worktree-remove.cjs')], {
            env: { ...process.env, REPO: clone, WORKTREE: worktree },
            encoding: 'utf8',
        });
        return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()!);
    };

    /** A task worktree holding what a tool leaves: a populated directory it closed to 0555. */
    const toolTree = (): { worktree: string; closed: string } => {
        const worktree = join(dir, 'worktrees', ROOT);
        git(clone, 'worktree', 'add', '-b', `factory/${ROOT}`, worktree);
        // Everything else as the shared tree's writers leave it, under umask 002.
        execFileSync('chmod', ['-R', 'g+rwx', worktree]);
        mkdirSync(join(worktree, 'cache'));
        chmodSync(join(worktree, 'cache'), 0o775);
        const closed = join(worktree, 'cache', 'mod@v1');
        mkdirSync(closed);
        writeFileSync(join(closed, 'go.mod'), 'module x\n');
        chmodSync(closed, 0o555);
        return { worktree, closed };
    };

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-release-')));
        clone = join(dir, 'clone');
        makeOriginClone(dir, clone);
    });

    it('leaves a reclaim that would fail on the closed directory able to remove the tree', () => {
        const { worktree, closed } = toolTree();
        expect(reclaim(worktree).ok).toBe(false);

        expect(release(worktree)).toEqual({ released: 1, skipped: 0 });
        expect(statSync(closed).mode & 0o070).toBe(0o070);
        expect(reclaim(worktree)).toEqual({ ok: true, removed: true });
        expect(existsSync(worktree)).toBe(false);
    });

    it('clears the sticky bit of a directory it owns, under which the reclaim could unlink nothing it did not make', () => {
        const { worktree } = toolTree();
        const shared = join(worktree, 'tmp');
        mkdirSync(shared);
        chmodSync(shared, 0o1777);
        writeFileSync(join(shared, 'scratch'), 'x');

        expect(release(worktree)).toEqual({ released: 2, skipped: 0 });
        expect(statSync(shared).mode & 0o7777).toBe(0o777);
    });

    it('skips a directory it cannot stat, releases the rest, and still exits 0', () => {
        const { worktree, closed } = toolTree();
        // The tool uid can list a directory another uid made 0744 but stat nothing in it: one uid
        // stands that in with the EACCES injected.
        mkdirSync(join(worktree, 'listed', 'unstattable'), { recursive: true });
        chmodSync(join(worktree, 'listed'), 0o775);
        const preload = join(dir, 'deny-stat.cjs');
        writeFileSync(
            preload,
            [
                "const fs = require('node:fs');",
                'const lstat = fs.lstatSync;',
                'fs.lstatSync = (p, ...rest) => {',
                "    if (String(p).endsWith('/unstattable')) throw Object.assign(new Error('denied'), { code: 'EACCES' });",
                '    return lstat(p, ...rest);',
                '};',
            ].join('\n')
        );

        expect(release(worktree, preload)).toEqual({ released: 1, skipped: 1 });
        expect(statSync(closed).mode & 0o070).toBe(0o070);
    });

    it('counts a tree root it cannot stat as skipped, and still exits 0', () => {
        const { worktree } = toolTree();
        const preload = join(dir, 'stale-root.cjs');
        writeFileSync(
            preload,
            [
                "const fs = require('node:fs');",
                'const lstat = fs.lstatSync;',
                'fs.lstatSync = (p, ...rest) => {',
                "    if (p === process.env.WORKTREE) throw Object.assign(new Error('stale'), { code: 'ESTALE' });",
                '    return lstat(p, ...rest);',
                '};',
            ].join('\n')
        );

        expect(release(worktree, preload)).toEqual({ released: 0, skipped: 1 });
    });

    it('never follows a symlink out of the tree', () => {
        const { worktree } = toolTree();
        const outside = join(dir, 'outside');
        mkdirSync(outside);
        chmodSync(outside, 0o500);
        symlinkSync(outside, join(worktree, 'link'));

        release(worktree);
        expect(statSync(outside).mode & 0o777).toBe(0o500);
        chmodSync(outside, 0o700);
    });

    it('counts nothing for a tree whose directories are already group rwx, or that is gone', () => {
        const worktree = join(dir, 'worktrees', ROOT);
        git(clone, 'worktree', 'add', '-b', `factory/${ROOT}`, worktree);
        execFileSync('chmod', ['-R', 'g+rwx', worktree]);

        expect(release(worktree)).toEqual({ released: 0, skipped: 0 });
        expect(release(join(dir, 'absent'))).toEqual({ released: 0, skipped: 0 });
    });
});
