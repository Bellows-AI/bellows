import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, hasGit, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The RESTORE mode of the task checkout script (issue #58): a follow-up continues the task where it
 * stands — no fetch, no rebase, the tree kept byte-for-byte as the run before it left it, and a
 * missing tree a named failure rather than a fresh clone.
 */
describe.skipIf(!hasGit())('the task checkout script (restore)', () => {
    const fx = setupWorktreeFixture();

    it('restores an existing checkout untouched: no fetch, no rebase', () => {
        // A follow-up continues the task where it stands (issue #58): git operations that touch
        // the remote belong to the task's beginning and end, never mid-flight. The tree must be
        // byte-for-byte what the previous run left — no rebase onto a moved main, no fetch
        // dragging upstream commits in, no autostash dance over the session's edits.
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        fx.commitIn(fx.checkout(), 'TASK.md', 'task work\n', 'the task commit');
        writeFileSync(join(fx.checkout(), 'TASK.md'), 'task work, mid-edit\n');
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');
        const before = git(fx.checkout(), 'rev-parse', 'HEAD');

        expect(fx.restore()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.checkout(), 'rev-parse', 'HEAD')).toBe(before);
        expect(existsSync(join(fx.checkout(), 'NEWS.md'))).toBe(false);
        expect(readFileSync(join(fx.checkout(), 'TASK.md'), 'utf8')).toBe('task work, mid-edit\n');
        expect(git(fx.checkout(), 'stash', 'list')).toBe('');
    });

    it('fails a restore whose checkout is gone, instead of cloning the thread fresh off main', () => {
        // A follow-up with no checkout on the volume has nothing to continue: cloning at
        // origin/<default> would look like a continuation while carrying none of the work over, and
        // a restore never talks to the remote. The attempt fails as branch_unrestorable.
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        rmSync(fx.checkout(), { recursive: true });

        const result = fx.restore();
        expect(result).toMatchObject({ ok: false, kind: 'branch_unrestorable' });
        expect(result.reason).toContain('nothing to continue');
        expect(existsSync(fx.checkout())).toBe(false);
    });

    it('refuses a restore whose checkout sits on another branch', () => {
        // The tree is ours, but the checkout moved off the task branch: a follow-up must not
        // run there, and must not reset or recreate it either — the refusal names the branch
        // it found against the branch it expected, and the tree stays as it stands.
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        git(fx.checkout(), 'switch', '-c', 'rogue');

        const result = fx.restore();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('rogue');
        expect(result.reason).toContain(fx.branch());
        expect(git(fx.checkout(), 'branch', '--show-current')).toBe('rogue');
    });

    it('refuses a restore whose checkout is on a detached HEAD', () => {
        // A detached checkout is no thread to continue either: no branch survives under it,
        // so the refusal names the detached state instead of answering success.
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        git(fx.checkout(), 'checkout', '--detach');

        const result = fx.restore();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('detached');
        expect(git(fx.checkout(), 'rev-parse', '--is-inside-work-tree')).toBe('true');
    });
});
