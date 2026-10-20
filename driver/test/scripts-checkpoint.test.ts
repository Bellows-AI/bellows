import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SCRIPT_IDENTITY, git, hasGit, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The checkpoint script (issue #775): at an attempt's finalize it commits the whole task tree through
 * a throwaway index, bundles that commit against what the remote already has, and snapshots the
 * OpenCode session database. Real git on a real partial clone made by the sync script; the script
 * FILE is what runs, as in the container.
 */
const SCRIPT = join(import.meta.dirname, '..', 'src', 'scripts', 'checkpoint.cjs');

interface Verdict {
    ok: boolean;
    reason?: string;
    state?: string;
    cause?: string | null;
    header?: {
        tip: string;
        parent: string | null;
        branch: string;
        defaultBranch: string | null;
        prerequisites: { default: string | null; branch: string | null };
        bundleBytes: number;
        sqliteBytes: number;
        truncated: boolean;
    };
    parts?: { path: string; bytes: number }[];
}

const hashOf = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe.skipIf(!hasGit())('the checkpoint script', () => {
    const fx = setupWorktreeFixture();

    const run = (env: Record<string, string>): Verdict => {
        const out = spawnSync('node', ['--no-warnings', SCRIPT], {
            env: { ...process.env, ...SCRIPT_IDENTITY, ...env },
            encoding: 'utf8',
        });
        return JSON.parse(out.stdout.trim().split('\n').filter(Boolean).pop() ?? '{}');
    };
    const outDir = () => join(fx.dir(), 'checkpoint');
    const checkpoint = (extra: Record<string, string> = {}): Verdict =>
        run({ CHECKOUT: fx.checkout(), BRANCH: fx.branch(), OUT_DIR: outDir(), ...extra });

    /** A task with every kind of change the checkpoint must carry, and one it must not. */
    function workedTree(): void {
        fx.pushToOrigin('gone.txt', 'to be deleted\n', 'a file the task deletes');
        expect(fx.sync()).toMatchObject({ ok: true });
        writeFileSync(join(fx.checkout(), '.gitignore'), 'node_modules/\n');
        git(fx.checkout(), 'add', '.gitignore');
        fx.commitIn(fx.checkout(), 'feature.txt', 'committed work\n', 'the task commit');
        writeFileSync(join(fx.checkout(), 'README.md'), '# edited\n');
        rmSync(join(fx.checkout(), 'gone.txt'));
        writeFileSync(join(fx.checkout(), 'untracked.txt'), 'never added\n');
        mkdirSync(join(fx.checkout(), 'node_modules'));
        writeFileSync(join(fx.checkout(), 'node_modules', 'dep.js'), 'ignored\n');
        mkdirSync(join(fx.checkout(), '.factory'));
        writeFileSync(join(fx.checkout(), '.factory', 'state.json'), '{}\n');
    }

    /** The bundle fetched into a fresh clone of the remote, as the restore would: its commit's tree. */
    function bundledFiles(bundle: string, tip: string): { files: string[]; show: (file: string) => string } {
        const verify = join(fx.dir(), 'verify');
        execFileSync('git', ['clone', '--quiet', `file://${fx.bare()}`, verify]);
        git(verify, 'fetch', '--quiet', bundle, 'refs/factory/checkpoint:refs/heads/checkpoint');
        expect(git(verify, 'rev-parse', 'checkpoint')).toBe(tip);
        return {
            files: git(verify, 'ls-tree', '-r', '--name-only', tip).split('\n'),
            show: (file) => execFileSync('git', ['show', `${tip}:${file}`], { cwd: verify, encoding: 'utf8' }),
        };
    }

    it('bundles the commit of the whole tree: the edit, the deletion and the untracked file; not node_modules', () => {
        workedTree();

        const verdict = checkpoint();

        expect(verdict).toMatchObject({ ok: true, state: 'complete', cause: null });
        const { header, parts } = verdict;
        expect(parts).toEqual([{ path: join(outDir(), 'bundle'), bytes: header?.bundleBytes }]);
        const { files, show } = bundledFiles(join(outDir(), 'bundle'), header!.tip);
        expect(files).toContain('feature.txt');
        expect(files).toContain('untracked.txt');
        expect(files).toContain('.gitignore');
        expect(files).not.toContain('gone.txt');
        expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
        expect(files.some((f) => f.startsWith('.factory/'))).toBe(false);
        expect(show('README.md')).toBe('# edited\n');
        expect(show('untracked.txt')).toBe('never added\n');
    });

    it('records the commit it sits on and what the remote already has as prerequisites', () => {
        workedTree();
        git(fx.checkout(), 'push', '--quiet', 'origin', fx.branch());
        fx.commitIn(fx.checkout(), 'later.txt', 'after the push\n', 'unpushed commit');
        const main = git(fx.checkout(), 'rev-parse', 'refs/remotes/origin/main');
        const pushed = git(fx.checkout(), 'rev-parse', `refs/remotes/origin/${fx.branch()}`);
        const head = git(fx.checkout(), 'rev-parse', 'HEAD');

        const { header } = checkpoint();

        expect(header).toMatchObject({
            parent: head,
            branch: fx.branch(),
            defaultBranch: 'main',
            prerequisites: { default: main, branch: pushed },
        });
        // The bundle's own prerequisite lines name the same two commits: it carries only what they lack.
        const lines = readFileSync(join(outDir(), 'bundle'), 'latin1').slice(0, 400).split('\n');
        const required = lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1, 41));
        expect(required).toContain(pushed);
        expect(bundledFiles(join(outDir(), 'bundle'), header!.tip).files).toContain('later.txt');
    });

    it('never touches the real index, HEAD, refs or working tree', () => {
        workedTree();
        const index = join(fx.checkout(), '.git', 'index');
        const before = {
            index: hashOf(index),
            head: git(fx.checkout(), 'rev-parse', 'HEAD'),
            refs: git(fx.checkout(), 'for-each-ref'),
            status: git(fx.checkout(), 'status', '--porcelain=v2', '--untracked-files=all'),
            readme: readFileSync(join(fx.checkout(), 'README.md'), 'utf8'),
            gone: existsSync(join(fx.checkout(), 'gone.txt')),
        };

        expect(checkpoint()).toMatchObject({ ok: true, state: 'complete' });

        expect(hashOf(index)).toBe(before.index);
        expect(git(fx.checkout(), 'rev-parse', 'HEAD')).toBe(before.head);
        expect(git(fx.checkout(), 'for-each-ref')).toBe(before.refs);
        expect(git(fx.checkout(), 'status', '--porcelain=v2', '--untracked-files=all')).toBe(before.status);
        expect(readFileSync(join(fx.checkout(), 'README.md'), 'utf8')).toBe(before.readme);
        expect(existsSync(join(fx.checkout(), 'gone.txt'))).toBe(before.gone);
    });

    it('above the cap uploads no bytes: truncated, caused checkpoint_cap, the shas still recorded', () => {
        workedTree();

        const verdict = checkpoint({ CAP_BYTES: '1' });

        expect(verdict).toMatchObject({ ok: true, state: 'truncated', cause: 'checkpoint_cap', parts: [] });
        expect(verdict.header).toMatchObject({ truncated: true, bundleBytes: 0, sqliteBytes: 0, branch: fx.branch() });
        expect(verdict.header?.tip).toMatch(/^[0-9a-f]{40}$/);
        expect(existsSync(join(outDir(), 'bundle'))).toBe(false);
        expect(readdirSync(outDir())).toEqual([]);
    });

    it('snapshots the OpenCode database through the sqlite backup API, WAL contents included', () => {
        workedTree();
        const dbPath = join(fx.dir(), 'opencode.db');
        const db = new DatabaseSync(dbPath);
        db.exec("PRAGMA journal_mode = WAL; CREATE TABLE session (id TEXT); INSERT INTO session VALUES ('ses_1');");

        const verdict = checkpoint({ OPENCODE_DB: dbPath });
        db.close();

        expect(verdict).toMatchObject({ ok: true, state: 'complete' });
        const part = verdict.parts?.find((p) => p.path === join(outDir(), 'opencode.db'));
        expect(part?.bytes).toBe(verdict.header?.sqliteBytes);
        const copy = new DatabaseSync(join(outDir(), 'opencode.db'), { readOnly: true });
        expect(copy.prepare('SELECT id FROM session').all()).toEqual([{ id: 'ses_1' }]);
        copy.close();
    });

    it('reads an absent database and an absent checkout as absence, any other errno as a failure', () => {
        workedTree();
        expect(checkpoint({ OPENCODE_DB: join(fx.dir(), 'no', 'such.db') })).toMatchObject({
            ok: true,
            state: 'complete',
            header: { sqliteBytes: 0 },
        });
        // A path that exists but is no database is a failure of the read, never "not there".
        expect(checkpoint({ OPENCODE_DB: fx.dir() })).toMatchObject({ ok: false });
        expect(run({ CHECKOUT: join(fx.dir(), 'nowhere'), BRANCH: fx.branch(), OUT_DIR: outDir() })).toMatchObject({
            ok: true,
            state: 'none',
        });
    });
});
