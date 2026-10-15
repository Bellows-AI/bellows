import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitProbeScript } from '../src/publish.js';
import { git, hasGit, runScript, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The worktree sync on a claim that names its base (BASE_BRANCH, a batch task's target branch):
 * the task tree is created off and rebased onto `origin/<base>`, never the remote default, while
 * the clone keeps fast-forwarding its own default.
 */
describe.skipIf(!hasGit())('the worktree sync script (a named base branch)', () => {
    const fx = setupWorktreeFixture();
    const BASE = 'batch-sandbox';

    const pushBase = (file: string, message: string): void => {
        git(fx.work(), 'checkout', '-B', BASE, `origin/${BASE}`);
        fx.commitIn(fx.work(), file, `${message}\n`, message);
        git(fx.work(), 'push', 'origin', BASE);
        git(fx.work(), 'checkout', 'main');
    };

    const createBase = (): void => {
        git(fx.work(), 'push', 'origin', `main:refs/heads/${BASE}`);
        git(fx.work(), 'fetch', 'origin');
        pushBase('SANDBOX.md', 'sandbox only');
    };

    const syncOnBase = () => runScript({ ...fx.syncEnv(), BASE_BRANCH: BASE });

    it('creates the worktree off origin/<base>, and the clone still fast-forwards its default', () => {
        createBase();
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'main moves on');

        expect(syncOnBase()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.worktree(), 'rev-parse', 'HEAD')).toBe(git(fx.clone(), 'rev-parse', `origin/${BASE}`));
        expect(existsSync(join(fx.worktree(), 'SANDBOX.md'))).toBe(true);
        expect(existsSync(join(fx.worktree(), 'NEWS.md'))).toBe(false);
        expect(git(fx.clone(), 'branch', '--show-current')).toBe('main');
        expect(git(fx.clone(), 'rev-parse', 'HEAD')).toBe(git(fx.clone(), 'rev-parse', 'origin/main'));
    });

    it('rebases an existing worktree onto origin/<base>, not the default', () => {
        createBase();
        expect(syncOnBase()).toMatchObject({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'TASK.md', 'task work\n', 'the task commit');
        pushBase('MORE.md', 'sandbox moves on');
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'main moves on');

        expect(syncOnBase()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.worktree(), 'log', '--format=%s')).toContain('the task commit');
        expect(git(fx.worktree(), 'merge-base', 'HEAD', `origin/${BASE}`)).toBe(
            git(fx.clone(), 'rev-parse', `origin/${BASE}`)
        );
        expect(existsSync(join(fx.worktree(), 'NEWS.md'))).toBe(false);
    });

    it('refuses a base the remote does not have as missing_base_branch', () => {
        const result = syncOnBase();

        expect(result).toMatchObject({ ok: false, kind: 'missing_base_branch' });
        expect(result.reason).toContain(`origin/${BASE}`);
        expect(existsSync(fx.worktree())).toBe(false);
    });

    it('the publish probe reads the base as the branch to compare against', () => {
        createBase();
        expect(syncOnBase()).toMatchObject({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'TASK.md', 'task work\n', 'the task commit');
        const probe = (env: Record<string, string>) =>
            JSON.parse(
                execFileSync('node', ['-e', gitProbeScript], {
                    env: { ...process.env, REPO: fx.worktree(), ...env },
                    encoding: 'utf8',
                })
                    .trim()
                    .split('\n')
                    .pop()!
            ) as { defaultBranch: string; unpushed: number };

        expect(probe({ BASE_BRANCH: BASE })).toMatchObject({ defaultBranch: BASE, unpushed: 1 });
        // Without a base the remote default stands, and the sandbox commit counts as unpushed too.
        expect(probe({})).toMatchObject({ defaultBranch: 'main', unpushed: 2 });
    });
});
