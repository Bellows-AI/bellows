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

    it('continues a restore on the named branch the agent switched to, untouched', () => {
        // The task checkout is task-owned, so the branch the agent moved it to is the task's work:
        // publish pushes that branch, and a resume after a lost driver continues on it rather than
        // ending the task branch_unrestorable.
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        const taskTip = git(fx.checkout(), 'rev-parse', 'HEAD');
        git(fx.checkout(), 'switch', '-c', 'factory/agent-work');
        fx.commitIn(fx.checkout(), 'TASK.md', 'agent work\n', 'the agent commit');
        writeFileSync(join(fx.checkout(), 'TASK.md'), 'agent work, mid-edit\n');
        const before = git(fx.checkout(), 'rev-parse', 'HEAD');

        expect(fx.restore()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.checkout(), 'branch', '--show-current')).toBe('factory/agent-work');
        expect(git(fx.checkout(), 'rev-parse', 'HEAD')).toBe(before);
        expect(readFileSync(join(fx.checkout(), 'TASK.md'), 'utf8')).toBe('agent work, mid-edit\n');
        expect(git(fx.checkout(), 'stash', 'list')).toBe('');
        expect(git(fx.checkout(), 'rev-parse', fx.branch())).toBe(taskTip);
    });

    it("hands over a stopped rebase of the agent's own branch", () => {
        // A rebase the agent stopped on its own branch is the agent's to finish: the restore hands
        // the conflict over instead of refusing a branch that is not the task branch.
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        git(fx.checkout(), 'switch', '-c', 'agent-work');
        fx.commitIn(fx.checkout(), 'README.md', 'agent side\n', 'agent edits README');
        git(fx.checkout(), 'switch', fx.branch());
        fx.commitIn(fx.checkout(), 'README.md', 'task side\n', 'task edits README');
        git(fx.checkout(), 'switch', 'agent-work');
        expect(() => git(fx.checkout(), 'rebase', fx.branch())).toThrow();

        expect(fx.restore()).toMatchObject({ ok: true, reason: null, conflicts: ['README.md'] });
        expect(existsSync(git(fx.checkout(), 'rev-parse', '--absolute-git-dir') + '/rebase-merge')).toBe(true);
    });

    it('refuses a restore whose checkout is on a detached HEAD', () => {
        // A detached checkout is no thread to continue: no branch names its commits, and publish
        // would switch away from them, so the refusal names the detached state.
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        git(fx.checkout(), 'checkout', '--detach');

        const result = fx.restore();
        expect(result).toMatchObject({ ok: false, kind: 'branch_unrestorable' });
        expect(result.reason).toContain('detached');
        expect(git(fx.checkout(), 'rev-parse', '--is-inside-work-tree')).toBe('true');
        expect(git(fx.checkout(), 'branch', '--show-current')).toBe('');
    });

    it('refuses a stopped rebase of a detached HEAD, never reading it as a branch', () => {
        // A rebase of a detached HEAD records `detached HEAD` as its head-name: that names no
        // branch, so it is refused like any detached checkout.
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        git(fx.checkout(), 'switch', '-c', 'side');
        fx.commitIn(fx.checkout(), 'README.md', 'side\n', 'side edits README');
        git(fx.checkout(), 'switch', fx.branch());
        fx.commitIn(fx.checkout(), 'README.md', 'task side\n', 'task edits README');
        git(fx.checkout(), 'checkout', '--detach', 'side');
        expect(() => git(fx.checkout(), 'rebase', fx.branch())).toThrow();

        const result = fx.restore();
        expect(result).toMatchObject({ ok: false, kind: 'branch_unrestorable' });
        expect(result.reason).toContain('detached');
        expect(result.reason).not.toContain('branch detached HEAD');
    });
});
