import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYNC_FAILURE_KINDS } from '../src/publish.js';
import { git, hasGit, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The sync script names the deterministic refusals (issue #666): a missing workspace, a missing
 * clone and an unrestorable branch each carry a `kind` and a message naming the path and what
 * creates it. The conflict refusals carry none — #661 owns them.
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

    it('names no kind for a rebase conflict, and pins the kinds the driver reads', () => {
        expect(fx.sync()).toMatchObject({ ok: true });
        fx.commitIn(fx.worktree(), 'README.md', 'mine\n', 'mine');
        fx.pushToOrigin('README.md', 'theirs\n', 'theirs');
        git(fx.clone(), 'fetch', 'origin');

        const result = fx.sync();

        expect(result.ok).toBe(false);
        expect(result).not.toHaveProperty('kind');
        const source = readFileSync(join(import.meta.dirname, '..', 'src', 'scripts', 'git-worktree.cjs'), 'utf8');
        for (const kind of SYNC_FAILURE_KINDS) expect(source).toContain(`'${kind}'`);
    });
});
