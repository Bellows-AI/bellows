import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitProbeScript } from '../src/publish/publish.js';
import { GIT_FIXTURE_CONFIG, git, hasGit, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The tree fingerprint (git-probe.cjs / git-worktree.cjs fingerprintOf), issue #438. The
 * engine only stops a gate-fix loop on `treeChanged === false`; null and true both keep it going.
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

    // ---- unknown forever: an untracked path `hash-object --stdin-paths` cannot read ----------------
    it.each([
        ['a dangling symlink', () => symlinkSync('/nonexistent/target', join(fx.checkout(), 'link'))],
        [
            'a nested repository',
            () => {
                mkdirSync(join(fx.checkout(), 'vendored'));
                git(join(fx.checkout(), 'vendored'), 'init');
            },
        ],
    ])('stays measurable with an untracked %s', (_what, make) => {
        fx.sync();
        make();
        // A null fingerprint is treeChanged null every round: the no-progress stop never fires.
        expect(probed()).toMatch(/^[0-9a-f]{40}:[0-9a-f]{64}$/);
    });

    // The gate's own writes are kept out by ordering, not by the fingerprint: the loop probes
    // before the gates (driver/test/loop/, 'reads the tree before the gates run').

    // ---- false negative: a submodule that was dirty and is now differently dirty -------------------
    it('moves when a dirty submodule’s content changes again', () => {
        fx.sync();
        const subSrc = realpathSync(mkdtempSync(join(tmpdir(), 'fingerprint-sub-')));
        git(subSrc, 'init');
        writeFileSync(join(subSrc, 'lib.txt'), 'v1\n');
        git(subSrc, 'add', 'lib.txt');
        git(subSrc, 'commit', '-m', 'sub');
        execFileSync(
            'git',
            [...GIT_FIXTURE_CONFIG, '-c', 'protocol.file.allow=always', 'submodule', 'add', subSrc, 'sub'],
            { cwd: fx.checkout(), stdio: 'ignore' }
        );
        git(fx.checkout(), 'commit', '-m', 'add sub');
        writeFileSync(join(fx.checkout(), 'sub', 'lib.txt'), 'agent edit one\n');
        const before = probed();
        writeFileSync(join(fx.checkout(), 'sub', 'lib.txt'), 'agent edit two — the real fix\n');
        // " m sub" / "Subproject commit X-dirty" stay identical: only the submodule's content moves.
        expect(probed()).not.toBe(before);
    });

    it('untracked names git C-quotes (a double quote, a tab)', () => {
        fx.sync();
        writeFileSync(join(fx.checkout(), 'say "hi".txt'), 'x');
        writeFileSync(join(fx.checkout(), 'a\tb.txt'), 'x');
        expect(probed()).toMatch(/^[0-9a-f]{40}:[0-9a-f]{64}$/);
    });

    it('moves on a mode-only change, and survives a stale index.lock', () => {
        fx.sync();
        const before = probed();
        chmodSync(join(fx.checkout(), 'README.md'), 0o755);
        const moded = probed();
        expect(moded).not.toBe(before);
        const gitDir = git(fx.checkout(), 'rev-parse', '--absolute-git-dir');
        writeFileSync(join(gitDir, 'index.lock'), '');
        expect(probed()).toBe(moded);
    });

    // ---- the evidence binding (issue #825): what moves the fingerprint is what a publish would ship -
    it('stays put when a git-ignored artifact is written after it, and moves on publishable content', () => {
        fx.sync();
        writeFileSync(join(fx.checkout(), '.gitignore'), 'dist/\n');
        git(fx.checkout(), 'add', '.gitignore');
        git(fx.checkout(), 'commit', '-m', 'ignore dist');
        const before = probed();

        mkdirSync(join(fx.checkout(), 'dist'));
        writeFileSync(join(fx.checkout(), 'dist', 'out.js'), 'generated\n');
        expect(probed()).toBe(before);

        writeFileSync(join(fx.checkout(), 'NEW.md'), 'untracked, not ignored\n');
        const untracked = probed();
        expect(untracked).not.toBe(before);

        writeFileSync(join(fx.checkout(), 'README.md'), '# edited\n');
        expect(probed()).not.toBe(untracked);
    });
});

/**
 * The content key (git-probe.cjs contentKeyOf), issue #983: what a gate run saw, as file contents
 * alone. A publish commits the work without changing a byte, so the key survives it where the
 * fingerprint (HEAD-bound) does not; any content change moves it, and a checkout git would rewrite
 * on the way in (line endings, filters) has no key at all.
 */
describe.skipIf(!hasGit())('the content key', () => {
    const fx = setupWorktreeFixture();
    const probe = (): { fingerprint: string | null; content: string | null } => {
        // A runner's checkout is case-sensitive; git on a case-folding host turns ignorecase on.
        git(fx.checkout(), 'config', 'core.ignorecase', 'false');
        const out = execFileSync('node', ['-e', gitProbeScript], {
            env: { ...process.env, REPO: fx.checkout() },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return JSON.parse(out.trim().split('\n').filter(Boolean).pop()!);
    };
    const KEY = /^[0-9a-f]{40}:[0-9a-f]{64}$/;
    const nestedRepo = (name: string) => {
        const dir = join(fx.checkout(), name);
        mkdirSync(dir);
        git(dir, 'init');
        git(dir, 'config', 'core.ignorecase', 'false');
        writeFileSync(join(dir, 'lib.txt'), 'v1\n');
        return dir;
    };

    it('survives committing the same content, which moves the fingerprint', () => {
        fx.sync();
        writeFileSync(join(fx.checkout(), 'README.md'), '# edited\n');
        writeFileSync(join(fx.checkout(), 'NEW.md'), 'new\n');
        const dirty = probe();
        expect(dirty.content).toMatch(KEY);
        git(fx.checkout(), 'add', '-A');
        git(fx.checkout(), 'commit', '-m', 'publish');
        const committed = probe();
        expect(committed.fingerprint).not.toBe(dirty.fingerprint);
        expect(committed.content).toBe(dirty.content);
    });

    it('moves on a content edit, a mode change and a removal, and ignores .factory/', () => {
        fx.sync();
        const before = probe().content;
        mkdirSync(join(fx.checkout(), '.factory'), { recursive: true });
        writeFileSync(join(fx.checkout(), '.factory', 'state.json'), '{}');
        expect(probe().content).toBe(before);
        writeFileSync(join(fx.checkout(), 'README.md'), '# edited again\n');
        const edited = probe().content;
        expect(edited).not.toBe(before);
        chmodSync(join(fx.checkout(), 'README.md'), 0o755);
        const moded = probe().content;
        expect(moded).not.toBe(edited);
        rmSync(join(fx.checkout(), 'README.md'));
        expect(probe().content).not.toBe(moded);
    });

    it('moves when an untracked nested repository changes, dirty or committed', () => {
        fx.sync();
        const dir = nestedRepo('vendored');
        const uncommitted = probe().content;
        expect(uncommitted).toMatch(KEY);
        writeFileSync(join(dir, 'lib.txt'), 'v2\n');
        const edited = probe().content;
        expect(edited).not.toBe(uncommitted);
        git(dir, 'add', '-A');
        git(dir, 'commit', '-m', 'one');
        const committed = probe().content;
        writeFileSync(join(dir, 'lib.txt'), 'v3\n');
        git(dir, 'commit', '-am', 'two');
        // Clean both times: only the nested repository's committed content tells them apart.
        expect(probe().content).not.toBe(committed);
    });

    it('moves when a submodule’s content changes, dirty or committed', () => {
        fx.sync();
        const subSrc = realpathSync(mkdtempSync(join(tmpdir(), 'content-sub-')));
        git(subSrc, 'init');
        writeFileSync(join(subSrc, 'lib.txt'), 'v1\n');
        git(subSrc, 'add', 'lib.txt');
        git(subSrc, 'commit', '-m', 'sub');
        execFileSync(
            'git',
            [...GIT_FIXTURE_CONFIG, '-c', 'protocol.file.allow=always', 'submodule', 'add', subSrc, 'sub'],
            { cwd: fx.checkout(), stdio: 'ignore' }
        );
        git(fx.checkout(), 'commit', '-m', 'add sub');
        git(join(fx.checkout(), 'sub'), 'config', 'core.ignorecase', 'false');
        writeFileSync(join(fx.checkout(), 'sub', 'lib.txt'), 'agent edit one\n');
        const one = probe().content;
        writeFileSync(join(fx.checkout(), 'sub', 'lib.txt'), 'agent edit two\n');
        const two = probe().content;
        expect(two).not.toBe(one);
        git(join(fx.checkout(), 'sub'), 'commit', '-am', 'inside');
        expect(probe().content).toMatch(KEY);
    });

    // Each a checkout where the staged blob could stay put while what a gate reads changes.
    it.each<[string, () => void]>([
        ['line endings converted (core.autocrlf)', () => git(fx.checkout(), 'config', 'core.autocrlf', 'input')],
        ['a text/eol attribute', () => writeFileSync(join(fx.checkout(), '.gitattributes'), '*.md text eol=lf\n')],
        [
            'a clean filter driver, whatever the attribute value names',
            () => git(fx.checkout(), 'config', 'filter.unset.clean', 'tr -d 0-9'),
        ],
        ['modes not recorded (core.filemode=false)', () => git(fx.checkout(), 'config', 'core.filemode', 'false')],
        ['symlinks not recorded (core.symlinks=false)', () => git(fx.checkout(), 'config', 'core.symlinks', 'false')],
        ['an assume-unchanged entry', () => git(fx.checkout(), 'update-index', '--assume-unchanged', 'README.md')],
        ['a skip-worktree entry', () => git(fx.checkout(), 'update-index', '--skip-worktree', 'README.md')],
        ['a split index', () => git(fx.checkout(), 'update-index', '--split-index')],
    ])('has no key with %s', (_what, make) => {
        fx.sync();
        expect(probe().content).toMatch(KEY);
        make();
        expect(probe().content).toBeNull();
    });

    it('has no key where git folds case (core.ignorecase)', () => {
        fx.sync();
        expect(probe().content).toMatch(KEY);
        const folded = execFileSync('node', ['-e', gitProbeScript], {
            env: { ...process.env, REPO: fx.checkout(), GIT_CONFIG_PARAMETERS: "'core.ignorecase=true'" },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        expect(JSON.parse(folded.trim().split('\n').filter(Boolean).pop()!).content).toBeNull();
    });

    it('leaves the checkout as it found it: index, objects, status and the mutation guard', () => {
        fx.sync();
        writeFileSync(join(fx.checkout(), 'NEW.md'), 'new\n');
        git(fx.checkout(), 'config', 'core.ignorecase', 'false');
        const gitDir = git(fx.checkout(), 'rev-parse', '--absolute-git-dir');
        const index = readFileSync(join(gitDir, 'index'));
        const objects = git(fx.checkout(), 'count-objects', '-v');
        const status = git(fx.checkout(), 'status', '--porcelain');
        const sinceMs = Date.now();
        const out = execFileSync('node', ['-e', gitProbeScript], {
            env: { ...process.env, REPO: fx.checkout(), MUTATED_SINCE_MS: String(sinceMs + 1000) },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const read = JSON.parse(out.trim().split('\n').filter(Boolean).pop()!);
        expect(read.content).toMatch(KEY);
        expect(read.mutatedSince).toBe(false);
        expect(readFileSync(join(gitDir, 'index')).equals(index)).toBe(true);
        expect(git(fx.checkout(), 'count-objects', '-v')).toBe(objects);
        expect(git(fx.checkout(), 'status', '--porcelain')).toBe(status);
        expect(existsSync(join(gitDir, 'index.lock'))).toBe(false);
    });
});
