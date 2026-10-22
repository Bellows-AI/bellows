import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SCRIPT_IDENTITY, git, hasGit, makeOrigin, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

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
    headerFile?: string;
    /** The verdict line's own size: the supervisor keeps only the tail of a step's stdout. */
    lineBytes?: number;
    state?: string;
    cause?: string | null;
    header?: {
        tip: string;
        parent: string | null;
        branch: string;
        base: string | null;
        defaultBranch: string | null;
        prerequisites: { ref: string; sha: string }[];
        bundleBytes: number;
        sqliteBytes: number;
        truncated: boolean;
    };
    parts?: { path: string; bytes: number }[];
}

const runCheckpoint = (env: Record<string, string>): Verdict => {
    const out = spawnSync('node', ['--no-warnings', SCRIPT], {
        env: { ...process.env, ...SCRIPT_IDENTITY, ...env },
        encoding: 'utf8',
    });
    const line = out.stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
    const verdict: Verdict = { ...JSON.parse(line), lineBytes: Buffer.byteLength(line) };
    // The header rides a file named by the verdict, never the verdict line itself.
    if (verdict.headerFile) verdict.header = JSON.parse(readFileSync(verdict.headerFile, 'utf8'));
    return verdict;
};

const hashOf = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe.skipIf(!hasGit())('the checkpoint script', () => {
    const fx = setupWorktreeFixture();

    const run = runCheckpoint;
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
        });
        expect(header?.prerequisites).toEqual(
            expect.arrayContaining([
                { ref: 'refs/remotes/origin/main', sha: main },
                { ref: `refs/remotes/origin/${fx.branch()}`, sha: pushed },
            ])
        );
        expect(header?.prerequisites.map((p) => p.ref)).not.toContain('refs/remotes/origin/HEAD');
        // The bundle's own prerequisite lines name the same two commits: it carries only what they lack.
        const lines = readFileSync(join(outDir(), 'bundle'), 'latin1').slice(0, 400).split('\n');
        const required = lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1, 41));
        expect(required).toContain(pushed);
        expect(bundledFiles(join(outDir(), 'bundle'), header!.tip).files).toContain('later.txt');
    });

    it('checkpoints a repository with thousands of remote branches: a small verdict line, every prerequisite in the header file', () => {
        workedTree();
        const head = git(fx.checkout(), 'rev-parse', 'refs/remotes/origin/main');
        const count = 12_000;
        // Packed directly: twelve thousand loose refs cost tens of seconds to create one by one.
        const packed = join(fx.checkout(), git(fx.checkout(), 'rev-parse', '--git-common-dir'), 'packed-refs');
        git(fx.checkout(), 'pack-refs', '--all');
        const kept = readFileSync(packed, 'utf8')
            .split('\n')
            .filter((l) => l && !l.startsWith('#') && !l.startsWith('^'));
        const entries = [
            ...kept,
            ...Array.from({ length: count }, (_, i) => `${head} refs/remotes/origin/bulk/${'x'.repeat(60)}-${i}`),
        ].sort((a, b) => (a.slice(41) < b.slice(41) ? -1 : 1));
        writeFileSync(packed, `# pack-refs with: sorted \n${entries.join('\n')}\n`);

        const verdict = checkpoint();

        expect(verdict).toMatchObject({ ok: true, state: 'complete' });
        expect(verdict.lineBytes).toBeLessThan(4096);
        expect(verdict.header?.prerequisites.filter((p) => p.ref.includes('/bulk/'))).toHaveLength(count);
        const bundle = join(outDir(), 'bundle');
        const { files } = bundledFiles(bundle, verdict.header!.tip);
        expect(files).toContain('feature.txt');
        git(fx.checkout(), 'bundle', 'verify', bundle);
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

    it('removes a checkpoint ref a killed run left behind, even when this run fails early', () => {
        workedTree();
        git(fx.checkout(), 'update-ref', 'refs/factory/checkpoint', git(fx.checkout(), 'rev-parse', 'HEAD'));
        writeFileSync(join(fx.checkout(), '.git', 'index'), 'not an index');

        const verdict = checkpoint();

        expect(verdict.ok).toBe(false);
        expect(git(fx.checkout(), 'for-each-ref', 'refs/factory')).toBe('');
    });

    it('survives more than a buffer of `git add` warnings on a big tree', () => {
        expect(fx.sync()).toMatchObject({ ok: true });
        git(fx.checkout(), 'config', 'core.autocrlf', 'input');
        const crlf = 'line\r\nline\r\n';
        for (let i = 0; i < 12_000; i += 1)
            writeFileSync(join(fx.checkout(), `crlf-with-a-long-enough-name-${i}.txt`), crlf);

        const verdict = checkpoint();

        expect(verdict).toMatchObject({ ok: true, state: 'complete' });
        expect(existsSync(join(outDir(), 'add.err'))).toBe(false);
    }, 60_000);

    it('above the cap uploads no bytes: truncated, caused checkpoint_cap, the shas still recorded', () => {
        workedTree();

        const verdict = checkpoint({ CAP_BYTES: '1' });

        expect(verdict).toMatchObject({ ok: true, state: 'truncated', cause: 'checkpoint_cap', parts: [] });
        expect(verdict.header).toMatchObject({ truncated: true, bundleBytes: 0, sqliteBytes: 0, branch: fx.branch() });
        expect(verdict.header?.tip).toMatch(/^[0-9a-f]{40}$/);
        expect(existsSync(join(outDir(), 'bundle'))).toBe(false);
        expect(readdirSync(outDir())).toEqual(['header.json']);
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

/**
 * The checkout the sync script makes is a `--filter=blob:none` clone, and the checkpoint runs with
 * no credential: a bundle range that reaches a commit whose blobs were never fetched would try a
 * lazy fetch it cannot make. Here the remote is unreachable once the clone exists, so any lazy
 * fetch is a failure.
 */
describe.skipIf(!hasGit())('the checkpoint script in a partial clone', () => {
    it('bundles an unpushed task branch on a non-default base with no origin/HEAD and no network', () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-checkpoint-partial-')));
        const { work, bare } = makeOrigin(dir);
        git(bare, 'config', 'uploadpack.allowFilter', 'true');
        git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
        // A batch base two commits ahead of main on one file: the clone's checkout fetches only the newer blob.
        git(work, 'checkout', '-b', 'batch-base');
        writeFileSync(join(work, 'a.txt'), 'v1\n');
        git(work, 'add', 'a.txt');
        git(work, 'commit', '-m', 'a v1');
        writeFileSync(join(work, 'a.txt'), 'v2\n');
        git(work, 'commit', '-am', 'a v2');
        git(work, 'checkout', 'main');
        writeFileSync(join(work, 'other.txt'), 'main moved\n');
        git(work, 'add', 'other.txt');
        git(work, 'commit', '-m', 'main moves');
        git(work, 'push', '--quiet', `file://${bare}`, 'main', 'batch-base');

        const clone = join(dir, 'task', 'factory');
        execFileSync('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', `file://${bare}`, clone]);
        git(clone, 'checkout', '--quiet', '-b', 'factory/root', 'origin/batch-base');
        writeFileSync(join(clone, 'task.txt'), 'unpushed work\n');
        git(clone, 'add', 'task.txt');
        git(clone, 'commit', '-m', 'task commit');
        writeFileSync(join(clone, 'untracked.txt'), 'dirty\n');
        git(clone, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
        git(clone, 'remote', 'set-url', 'origin', `file://${join(dir, 'gone.git')}`);
        const refs = Object.fromEntries(
            git(clone, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin')
                .split('\n')
                .map((l) => l.split(' '))
        );

        const outDir = join(dir, 'out');
        const verdict = runCheckpoint({ CHECKOUT: clone, BRANCH: 'factory/root', BASE: 'batch-base', OUT_DIR: outDir });

        expect(verdict).toMatchObject({ ok: true, state: 'complete' });
        expect(verdict.header).toMatchObject({ base: 'batch-base', defaultBranch: null });
        expect(verdict.header?.prerequisites).toHaveLength(Object.keys(refs).length);
        expect(verdict.header?.prerequisites).toEqual(
            expect.arrayContaining(Object.entries(refs).map(([ref, sha]) => ({ ref, sha })))
        );
        const fresh = join(dir, 'fresh');
        execFileSync('git', ['clone', '--quiet', `file://${bare}`, fresh]);
        git(fresh, 'bundle', 'verify', join(outDir, 'bundle'));
        git(fresh, 'fetch', '--quiet', join(outDir, 'bundle'), 'refs/factory/checkpoint:refs/heads/checkpoint');
        expect(git(fresh, 'show', 'checkpoint:untracked.txt')).toBe('dirty');
        expect(git(fresh, 'show', 'checkpoint:task.txt')).toBe('unpushed work');
    });
});
