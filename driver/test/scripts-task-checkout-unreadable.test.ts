import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GIT_FIXTURE_CONFIG, ROOT, hasGit, runScript } from './fixtures/git-worktree-support.js';

/*
 * A permission error is no evidence of absence (#869): a path the script could not read must fail the
 * sync with an `unreadable` reason, never be treated as missing and written over.
 */
describe.skipIf(!hasGit() || process.getuid?.() === 0)('the task checkout sync over a path it cannot read', () => {
    let dir: string;
    let checkout: string;
    let bare: string;
    const branch = `factory/${ROOT}`;
    const sync = () => runScript({ CHECKOUT: checkout, REMOTE: `file://${bare}`, BRANCH: branch });

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-checkout-unreadable-')));
        checkout = join(dir, 'task', 'scaffold');
        bare = join(dir, 'scaffold.git');
        mkdirSync(join(dir, 'task'));
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'init', '--bare', bare], { stdio: 'ignore' });
    });

    it('is no absent exclude file: the sync answers not-ok with an unreadable reason', () => {
        expect(sync()).toMatchObject({ ok: true });
        const info = join(checkout, '.git', 'info');
        chmodSync(info, 0o000);
        try {
            const verdict = sync();
            expect(verdict.ok).toBe(false);
            expect(String(verdict.reason)).toContain(`unreadable ${join(info, 'exclude')}`);
        } finally {
            chmodSync(info, 0o755);
        }
        expect(existsSync(join(checkout, '.git'))).toBe(true);
    });
});
