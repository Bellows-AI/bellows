import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitProbeScript } from '../src/publish/publish.js';
import { git, hasGit, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The mutation guard of the gate-run record (issue #983): the probe's `MUTATED_SINCE_MS` mode answers
 * whether any file or directory of the tree a publish would ship was touched at or after a moment —
 * which a fingerprint cannot say about a file changed and put back. The same script both executors run.
 */
interface Probed {
    fingerprint: string | null;
    mutatedSince?: boolean | null;
}

describe.skipIf(!hasGit())('the probe’s mutation guard', () => {
    const fx = setupWorktreeFixture();
    const NOW = () => Date.now();
    const OLD = new Date(NOW() - 100_000);

    const probed = (since?: number): Probed => {
        const out = execFileSync('node', ['-e', gitProbeScript], {
            env: {
                ...process.env,
                REPO: fx.checkout(),
                ...(since === undefined ? {} : { MUTATED_SINCE_MS: String(since) }),
            },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return JSON.parse(out.trim().split('\n').filter(Boolean).pop()!) as Probed;
    };

    /** Every path of the checkout but `.git` set to a moment long before the guard's `since`. */
    const age = (dir = fx.checkout()): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '.git') continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) age(full);
            else utimesSync(full, OLD, OLD);
        }
        utimesSync(dir, OLD, OLD);
    };
    const since = () => NOW() - 50_000;

    const prepared = (): void => {
        fx.sync();
        mkdirSync(join(fx.checkout(), 'src'), { recursive: true });
        writeFileSync(join(fx.checkout(), 'src', 'a.txt'), 'a\n');
        writeFileSync(join(fx.checkout(), '.gitignore'), 'build/\n');
        git(fx.checkout(), 'add', '-A');
        git(fx.checkout(), 'commit', '-m', 'seed');
        age();
    };

    it('says nothing without a since: the field is null', () => {
        prepared();
        expect(probed().mutatedSince ?? null).toBeNull();
    });

    it('is false over a tree nothing touched since', () => {
        prepared();
        expect(probed(since()).mutatedSince).toBe(false);
    });

    it('is true for a tracked file changed and put back: the fingerprint is equal, the mtime is not', () => {
        prepared();
        const before = probed(since()).fingerprint;
        writeFileSync(join(fx.checkout(), 'src', 'a.txt'), 'changed\n');
        writeFileSync(join(fx.checkout(), 'src', 'a.txt'), 'a\n');
        const after = probed(since());
        expect(after.fingerprint).toBe(before);
        expect(after.mutatedSince).toBe(true);
    });

    it('is true for a file created and removed again: its directory moved', () => {
        prepared();
        writeFileSync(join(fx.checkout(), 'src', 'tmp.txt'), 'x');
        rmSync(join(fx.checkout(), 'src', 'tmp.txt'));
        expect(probed(since()).mutatedSince).toBe(true);
    });

    it('is true for a new untracked file', () => {
        prepared();
        writeFileSync(join(fx.checkout(), 'new.txt'), 'x');
        expect(probed(since()).mutatedSince).toBe(true);
    });

    it('ignores what a publish never ships: an ignored file and the .factory state namespace', () => {
        prepared();
        mkdirSync(join(fx.checkout(), 'build'));
        mkdirSync(join(fx.checkout(), '.factory'), { recursive: true });
        age();
        writeFileSync(join(fx.checkout(), 'build', 'out.js'), 'x');
        writeFileSync(join(fx.checkout(), '.factory', 'state.json'), '{}');
        expect(probed(since()).mutatedSince).toBe(false);
    });

    // Unknown is mutated: a walk that cannot read a path never reports the tree untouched.
    it.skipIf(process.getuid?.() === 0)('is true when the walk cannot read a path', () => {
        prepared();
        const dir = join(fx.checkout(), 'src');
        chmodSync(dir, 0o000);
        try {
            expect(probed(since()).mutatedSince).toBe(true);
        } finally {
            chmodSync(dir, 0o755);
        }
    });
});
