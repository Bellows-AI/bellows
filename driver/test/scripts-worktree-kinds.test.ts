import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYNC_FAILURE_KINDS } from '../src/publish.js';
import { git, hasGit, SCRIPT_IDENTITY, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The sync script names the deterministic refusals (issue #666): a missing workspace, a missing
 * clone and an unrestorable branch each carry a `kind` and a message naming the path and what
 * creates it. A conflict is no refusal: it is handed to the agent with its paths (issue #661).
 */
describe.skipIf(!hasGit())('the worktree sync names its deterministic failures', () => {
    const fx = setupWorktreeFixture();

    it('names the missing workspace, the path and the board that creates it', () => {
        rmSync(dirname(fx.clone()), { recursive: true, force: true });

        for (const result of [fx.sync(), fx.restore()]) {
            expect(result).toMatchObject({ ok: false, kind: 'missing_workspace' });
            expect(result.reason).toContain(dirname(fx.clone()));
            expect(result.reason).toContain('the board creates it');
        }
    });

    it('names the missing clone, the path and the board checkout that creates it', () => {
        rmSync(fx.clone(), { recursive: true, force: true });

        for (const result of [fx.sync(), fx.restore()]) {
            expect(result).toMatchObject({ ok: false, kind: 'missing_clone' });
            expect(result.reason).toContain(fx.clone());
            expect(result.reason).toContain('the board clones it');
        }
    });

    it('names an unrestorable branch and the re-queue that fixes it', () => {
        const result = fx.restore();

        expect(result).toMatchObject({ ok: false, kind: 'branch_unrestorable' });
        expect(result.reason).toContain(`the task branch ${fx.branch()} could not be restored`);
        expect(result.reason).toContain('re-queue the task');
    });

    it('pins the kinds the driver reads', () => {
        const source = readFileSync(join(import.meta.dirname, '..', 'src', 'scripts', 'git-worktree.cjs'), 'utf8');
        for (const kind of SYNC_FAILURE_KINDS) expect(source).toContain(`'${kind}'`);
    });

    describe('hands a conflict to the agent instead of refusing the run (issue #661)', () => {
        const conflictedRebase = (): void => {
            expect(fx.sync()).toMatchObject({ ok: true });
            fx.commitIn(fx.worktree(), 'README.md', 'mine\n', 'mine');
            fx.pushToOrigin('README.md', 'theirs\n', 'theirs');
        };

        it('leaves the conflicted rebase in place and names the paths', () => {
            conflictedRebase();

            const result = fx.sync();

            expect(result).toMatchObject({ ok: true, reason: null, conflicts: ['README.md'] });
            expect(result).not.toHaveProperty('kind');
            expect(git(fx.worktree(), 'diff', '--name-only', '--diff-filter=U')).toBe('README.md');
            expect(existsSync(git(fx.worktree(), 'rev-parse', '--absolute-git-dir') + '/rebase-merge')).toBe(true);
        });

        it('hands over the tree a previous attempt left conflicted, without rebasing again', () => {
            conflictedRebase();
            fx.sync();

            const again = fx.sync();

            expect(again).toMatchObject({ ok: true, reason: null, conflicts: ['README.md'] });
            expect(readFileSync(join(fx.worktree(), 'README.md'), 'utf8')).toContain('<<<<<<<');
        });

        it('syncs clean again once the agent has resolved and continued the rebase', () => {
            conflictedRebase();
            fx.sync();

            writeFileSync(join(fx.worktree(), 'README.md'), 'resolved\n');
            git(fx.worktree(), 'add', 'README.md');
            const continued = execFileSync('git', ['rebase', '--continue'], {
                cwd: fx.worktree(),
                encoding: 'utf8',
                env: { ...process.env, ...SCRIPT_IDENTITY, GIT_EDITOR: 'true' },
            });

            expect(continued).toContain('mine');
            expect(git(fx.worktree(), 'branch', '--show-current')).toBe(fx.branch());
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
