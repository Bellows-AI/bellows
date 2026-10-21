import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYNC_FAILURE_KINDS } from '../src/publish.js';
import { git, hasGit, SCRIPT_IDENTITY, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The task checkout script (issue #775) against real git, offline: the clone, the retry, and the
 * deterministic refusals (issue #666) that carry a `kind`. A conflict is no refusal: it is handed to the agent with its paths (issue #661).
 */
describe.skipIf(!hasGit())('the task checkout script', () => {
    const fx = setupWorktreeFixture();

    it('names an unrestorable branch and the re-queue that fixes it', () => {
        const result = fx.restore();

        expect(result).toMatchObject({ ok: false, kind: 'branch_unrestorable' });
        expect(result.reason).toContain(fx.checkout());
        expect(result.reason).toContain('re-queue the task');
    });

    it('clones the remote into the task’s own checkout, on the task branch at the remote default', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.checkout(), 'branch', '--show-current')).toBe(fx.branch());
        expect(git(fx.checkout(), 'rev-parse', 'HEAD')).toBe(git(fx.work(), 'rev-parse', 'HEAD'));
        expect(readFileSync(join(fx.checkout(), 'README.md'), 'utf8')).toBe('# factory\n');
        // An independent clone: its git dir is its own, never a linked worktree's gitdir file.
        expect(statSync(join(fx.checkout(), '.git')).isDirectory()).toBe(true);
        expect(git(fx.checkout(), 'remote', 'get-url', 'origin')).toBe(`file://${fx.bare()}`);
    });

    it('is idempotent: a second sync rebases the checkout onto the new default', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        fx.commitIn(fx.checkout(), 'TASK.md', 'task work\n', 'the task commit');
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.checkout(), 'log', '--format=%s')).toContain('the task commit');
        expect(existsSync(join(fx.checkout(), 'NEWS.md'))).toBe(true);
        expect(git(fx.checkout(), 'merge-base', 'HEAD', 'origin/main')).toBe(git(fx.work(), 'rev-parse', 'main'));
    });

    it('refuses a path that holds something this sync did not create, deleting nothing', () => {
        mkdirSync(fx.checkout(), { recursive: true });
        writeFileSync(join(fx.checkout(), 'PRECIOUS.md'), 'uncommitted work\n');

        const result = fx.sync();

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('holds something this sync did not create');
        expect(readFileSync(join(fx.checkout(), 'PRECIOUS.md'), 'utf8')).toBe('uncommitted work\n');
    });

    it('starts a fresh volume from the branch the thread already pushed, not from main', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        fx.commitIn(fx.checkout(), 'KEPT.md', 'kept work\n', 'kept committed work');
        git(fx.checkout(), 'push', 'origin', fx.branch());
        rmSync(fx.checkout(), { recursive: true });

        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.checkout(), 'branch', '--show-current')).toBe(fx.branch());
        expect(git(fx.checkout(), 'log', '--format=%s')).toContain('kept committed work');
    });

    it('rebases a checkout with uncommitted edits by autostash, and keeps the edits', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');
        writeFileSync(join(fx.checkout(), 'README.md'), 'an agent was here\n');

        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.checkout(), 'merge-base', 'HEAD', 'origin/main')).toBe(git(fx.work(), 'rev-parse', 'main'));
        expect(readFileSync(join(fx.checkout(), 'README.md'), 'utf8')).toBe('an agent was here\n');
    });

    it('keeps the uncommitted edits when the autostash rebase conflicts with upstream', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        fx.commitIn(fx.checkout(), 'TASK.md', 'task work\n', 'the task commit');
        writeFileSync(join(fx.checkout(), 'README.md'), 'an agent was here\n');
        fx.pushToOrigin('README.md', 'upstream rewrites the readme\n', 'conflicting upstream commit');

        expect(fx.sync()).toMatchObject({ ok: true, reason: null, conflicts: ['README.md'] });
        expect(readFileSync(join(fx.checkout(), 'README.md'), 'utf8')).toContain('an agent was here');
        expect(git(fx.checkout(), 'stash', 'list')).toContain('autostash');
    });

    it('git-ignores the .factory/ state namespace, once', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        const exclude = readFileSync(join(fx.checkout(), '.git', 'info', 'exclude'), 'utf8');
        expect(exclude.split('\n').filter((line) => line === '/.factory/')).toHaveLength(1);
        mkdirSync(join(fx.checkout(), '.factory'), { recursive: true });
        writeFileSync(join(fx.checkout(), '.factory', 'merge-conflict-probe.json'), '{}\n');
        expect(git(fx.checkout(), 'status', '--porcelain')).toBe('');
    });

    it('pins the failure kinds the driver reads', () => {
        const source = readFileSync(join(import.meta.dirname, '..', 'src', 'scripts', 'task-checkout.cjs'), 'utf8');
        for (const kind of SYNC_FAILURE_KINDS) expect(source).toContain(`'${kind}'`);
    });

    describe('hands a conflict to the agent instead of refusing the run (issue #661)', () => {
        const conflictedRebase = (): void => {
            expect(fx.sync()).toMatchObject({ ok: true });
            fx.commitIn(fx.checkout(), 'README.md', 'mine\n', 'mine');
            fx.pushToOrigin('README.md', 'theirs\n', 'theirs');
        };

        it('leaves the conflicted rebase in place and names the paths', () => {
            conflictedRebase();

            const result = fx.sync();

            expect(result).toMatchObject({ ok: true, reason: null, conflicts: ['README.md'] });
            expect(result).not.toHaveProperty('kind');
            expect(git(fx.checkout(), 'diff', '--name-only', '--diff-filter=U')).toBe('README.md');
            expect(existsSync(git(fx.checkout(), 'rev-parse', '--absolute-git-dir') + '/rebase-merge')).toBe(true);
        });

        it('hands over the tree a previous attempt left conflicted, without rebasing again', () => {
            conflictedRebase();
            fx.sync();

            const again = fx.sync();

            expect(again).toMatchObject({ ok: true, reason: null, conflicts: ['README.md'] });
            expect(readFileSync(join(fx.checkout(), 'README.md'), 'utf8')).toContain('<<<<<<<');
        });

        it('syncs clean again once the agent has resolved and continued the rebase', () => {
            conflictedRebase();
            fx.sync();

            writeFileSync(join(fx.checkout(), 'README.md'), 'resolved\n');
            git(fx.checkout(), 'add', 'README.md');
            const continued = execFileSync('git', ['rebase', '--continue'], {
                cwd: fx.checkout(),
                encoding: 'utf8',
                env: { ...process.env, ...SCRIPT_IDENTITY, GIT_EDITOR: 'true' },
            });

            expect(continued).toContain('mine');
            expect(git(fx.checkout(), 'branch', '--show-current')).toBe(fx.branch());
            expect(fx.sync()).toMatchObject({ ok: true, reason: null });
            expect(fx.sync()).not.toHaveProperty('conflicts');
        });

        it('reports the conflict a continuation claim finds in the tree', () => {
            conflictedRebase();
            fx.sync();

            expect(fx.restore()).toMatchObject({ ok: true, reason: null, conflicts: ['README.md'] });
        });
    });
});
