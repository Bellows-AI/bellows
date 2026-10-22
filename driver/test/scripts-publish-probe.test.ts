import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GIT_STAGE_STEPS, gitProbeScript } from '../src/publish.js';
import { GIT_FIXTURE_CONFIG, git, hasGit, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The publish probe, executed for real against a checkout — the same artifact the publish flow's
 * probe container runs, driven by `REPO` alone. It answers the three questions the publisher
 * branches on: is this a checkout at all, does it hold uncommitted work, and does it carry
 * commits the remote default does not have.
 */
describe.skipIf(!hasGit())('the publish probe script', () => {
    let dir: string;
    let repo: string;

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-probe-')));
        const work = join(dir, 'origin-work');
        mkdirSync(work, { recursive: true });
        git(work, 'init');
        writeFileSync(join(work, 'README.md'), '# probe\n');
        git(work, 'add', 'README.md');
        git(work, 'commit', '-m', 'init');
        const bare = join(dir, 'probe.git');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', '--bare', work, bare], { stdio: 'ignore' });
        repo = join(dir, 'clone');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', `file://${bare}`, repo], { stdio: 'ignore' });
    });

    const probe = (): {
        cloned: boolean;
        branch: string;
        defaultBranch: string;
        dirty: boolean;
        unpushed: number;
        hasIdentity: boolean;
    } => {
        const out = execFileSync('node', [join(import.meta.dirname, '..', 'src', 'scripts', 'git-probe.cjs')], {
            env: {
                ...process.env,
                REPO: repo,
                // Hermetic identity: the runner's global/system git config must not decide
                // hasIdentity — the publisher's fallback-identity branch depends on the answer.
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_SYSTEM: '/dev/null',
            },
            encoding: 'utf8',
        });
        return JSON.parse(out.trim().split('\n').filter(Boolean).pop()!);
    };

    it('reads the checkout state the publish flow branches on', () => {
        writeFileSync(join(repo, 'WIP.md'), 'uncommitted\n');
        writeFileSync(join(repo, 'TRACKED.md'), 'edit\n');
        git(repo, 'add', 'TRACKED.md');
        git(repo, 'commit', '-m', 'local commit');

        expect(probe()).toMatchObject({
            cloned: true,
            branch: 'main',
            defaultBranch: 'main',
            dirty: true,
            unpushed: 1,
        });
        // The fixture pins a committer identity per git() call only — the clone itself has
        // none, which is exactly the state the publisher's fallback identity exists for.
        expect(probe().hasIdentity).toBe(false);
    });

    it('answers the never-cloned shape for a directory that is not a checkout', () => {
        repo = join(dir, 'not-a-checkout');
        mkdirSync(repo, { recursive: true });

        expect(probe()).toEqual({
            cloned: false,
            branch: '',
            defaultBranch: 'main',
            dirty: false,
            unpushed: 0,
            hasIdentity: false,
            fingerprint: null,
            conflicts: [],
            rebasing: false,
        });
        // The constant is the file — asserting the executed path is the artifact (parity with
        // the loader is pinned in scripts.test.ts).
        expect(gitProbeScript.length).toBeGreaterThan(0);
    });

    it('reads a tree dirty only under .factory/ as clean, and the publisher never stages it', () => {
        // A state file an older commit already tracks (how merge-conflict-probe.json leaked into
        // main): rewriting it is not publishable work, and staging it again re-spreads the leak.
        mkdirSync(join(repo, '.factory'), { recursive: true });
        writeFileSync(join(repo, '.factory', 'merge-conflict-probe.json'), '{"verdict":"up-to-date"}\n');
        git(repo, 'add', '.factory');
        git(repo, 'commit', '-m', 'leaked state');
        writeFileSync(join(repo, '.factory', 'merge-conflict-probe.json'), '{"verdict":"rebased"}\n');
        writeFileSync(join(repo, '.factory', 'digest.json'), '{}\n');

        expect(probe().dirty).toBe(false);

        writeFileSync(join(repo, 'WORK.md'), 'real work\n');
        expect(probe().dirty).toBe(true);
        for (const args of GIT_STAGE_STEPS) git(repo, ...args);
        expect(git(repo, 'diff', '--cached', '--name-only')).toBe('WORK.md');
    });

    // The sync git-ignores `.factory/` (task-checkout.cjs excludeFactoryState). A pathspec naming an
    // ignored path makes `git add` exit 1 even though it staged the rest — observed live: a run
    // whose worktree held `.factory/` lost its finished work at publish.
    it('stages the work and exits cleanly when .factory/ is present and git-ignored', () => {
        writeFileSync(join(repo, '.git', 'info', 'exclude'), '/.factory/\n');
        mkdirSync(join(repo, '.factory'), { recursive: true });
        writeFileSync(join(repo, '.factory', 'digest.json'), '{}\n');
        writeFileSync(join(repo, 'WORK.md'), 'real work\n');

        for (const args of GIT_STAGE_STEPS) git(repo, ...args);
        expect(git(repo, 'diff', '--cached', '--name-only')).toBe('WORK.md');
    });
});

/**
 * The tree fingerprint the sync prints and the probe re-reads after a failed gate: equal means the
 * round between them changed nothing. Both scripts spell it identically; this pins that they agree.
 */
describe.skipIf(!hasGit())('the tree fingerprint', () => {
    const fx = setupWorktreeFixture();

    const probed = (): string | null => {
        const out = execFileSync('node', ['-e', gitProbeScript], {
            env: { ...process.env, REPO: fx.checkout() },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return (JSON.parse(out.trim().split('\n').filter(Boolean).pop()!) as { fingerprint: string | null })
            .fingerprint;
    };
    const synced = (): string | null => (fx.sync() as { fingerprint?: string | null }).fingerprint ?? null;

    it('agrees between the sync and the probe over an untouched tree', () => {
        const before = synced();
        expect(before).toMatch(/^[0-9a-f]{40}:[0-9a-f]{64}$/);
        expect(probed()).toBe(before);
        // The restore a follow-up gets prints the same one.
        expect((fx.restore() as { fingerprint?: string | null }).fingerprint).toBe(before);
    });

    it('moves on a commit, an edit, a further edit of an already-dirty file, and a new file', () => {
        const seen = new Set([synced()]);
        const step = (): void => {
            const now = probed();
            expect(seen.has(now)).toBe(false);
            seen.add(now);
        };
        fx.commitIn(fx.checkout(), 'TASK.md', 'one\n', 'a commit');
        step();
        writeFileSync(join(fx.checkout(), 'README.md'), 'edited\n');
        step();
        // The porcelain line is the same ` M README.md`; the content is not.
        writeFileSync(join(fx.checkout(), 'README.md'), 'edited again\n');
        step();
        writeFileSync(join(fx.checkout(), 'NEW.md'), 'new\n');
        step();
        writeFileSync(join(fx.checkout(), 'NEW.md'), 'new, changed\n');
        step();
    });

    it('ignores the .factory/ state namespace', () => {
        const before = synced();
        mkdirSync(join(fx.checkout(), '.factory'), { recursive: true });
        writeFileSync(join(fx.checkout(), '.factory', 'state.json'), '{}');
        expect(probed()).toBe(before);
    });
});
