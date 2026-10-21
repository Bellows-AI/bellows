import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach } from 'vitest';

/**
 * Shared support for the task checkout script suites (`scripts-task-checkout.test.ts`) — real git,
 * offline throughout: every remote here is a `file://` bare repository the fixture creates. The
 * script under test is what the driver's sync container (docker) or sync Job (kubernetes) runs.
 *
 * The script's git children inherit this process's environment, so the fixture pins a committer
 * identity through GIT_* env vars — a rebase creates commits, and a runner without a global git
 * config must not fail the fixture.
 */
export const SCRIPT_IDENTITY = {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
};

export function hasGit(): boolean {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** Pinned so the fixture does not depend on the runner's global git config, or on having one. */
export const GIT_FIXTURE_CONFIG = [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    '-c',
    'init.defaultBranch=main',
    '-c',
    'commit.gpgsign=false',
];

export function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', [...GIT_FIXTURE_CONFIG, ...args], { cwd, encoding: 'utf8' }).trim();
}

/**
 * A `file://` origin under `dir` and a clone of it at `clone`: an `origin-work` repo with one
 * README commit (`# <name>`), its bare copy `<name>.git`, and the clone. Answers the work and bare paths.
 */
export function makeOriginClone(dir: string, clone: string, name = 'factory'): { work: string; bare: string } {
    const origin = makeOrigin(dir, name);
    execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', `file://${origin.bare}`, clone], { stdio: 'ignore' });
    return origin;
}

/** The `file://` origin alone: an `origin-work` repo with one README commit and its bare copy `<name>.git`. */
export function makeOrigin(dir: string, name = 'factory'): { work: string; bare: string } {
    const work = join(dir, 'origin-work');
    mkdirSync(work, { recursive: true });
    git(work, 'init');
    writeFileSync(join(work, 'README.md'), `# ${name}\n`);
    git(work, 'add', 'README.md');
    git(work, 'commit', '-m', 'init');
    const bare = join(dir, `${name}.git`);
    execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', '--bare', work, bare], { stdio: 'ignore' });
    return { work, bare };
}

/** An arbitrary fixed instant the imported commits count up from; the exact value is irrelevant. */
const FIRST_COMMIT_EPOCH_SECONDS = 1_700_000_000;

/** Builds a long, empty history in one process; one `git commit` spawn per row made the cap test the suite's slowest. */
export function importEmptyCommits(cwd: string, branch: string, count: number): void {
    let stream = '';
    for (let i = 0; i < count; i += 1) {
        const message = `commit ${i}`;
        const timestamp = FIRST_COMMIT_EPOCH_SECONDS + i;
        stream +=
            `commit refs/heads/${branch}\n` +
            `mark :${i + 1}\n` +
            `author Test <test@example.com> ${timestamp} +0000\n` +
            `committer Test <test@example.com> ${timestamp} +0000\n` +
            `data ${Buffer.byteLength(message)}\n${message}\n` +
            `from ${i === 0 ? 'refs/heads/main' : `:${i}`}\n\n`;
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd, input: `${stream}done\n` });
}

/** The script's verdict: `conflicts` rides an ok sync that left a conflict for the agent (issue #661). */
export interface SyncVerdict {
    ok: boolean;
    reason: string | null;
    kind?: string;
    conflicts?: string[];
}

export const runScript = (env: Record<string, string>): SyncVerdict => {
    // The script FILE itself, not a -e wrap: the artifact the sync container runs is what is
    // under test.
    const out = execFileSync('node', [join(import.meta.dirname, '..', '..', 'src', 'scripts', 'task-checkout.cjs')], {
        env: { ...process.env, ...SCRIPT_IDENTITY, ...env },
        encoding: 'utf8',
    });
    return JSON.parse(out.trim().split('\n').filter(Boolean).pop()!);
};

export const USER = '11111111-2222-3333-4444-555555555555';
export const ROOT = '55555555-5555-4555-8555-555555555555';
export const OTHER_ROOT = '66666666-6666-4666-8666-666666666666';

export interface WorktreeFixture {
    dir: () => string;
    /** The task's own checkout: absent until the first sync clones it from the bare origin. */
    checkout: () => string;
    branch: () => string;
    work: () => string;
    bare: () => string;
    /** The env a sync of `root` runs under — the base suites overlay (PATH shims, knobs) on it. */
    syncEnv: (root?: string) => Record<string, string>;
    sync: (root?: string) => SyncVerdict;
    /** The restore mode a continuation claim gets (RESTORE=1): no fetch, no rebase. */
    restore: (root?: string) => SyncVerdict;
    /** A commit on the remote default branch, pushed from the fixture's work copy. */
    pushToOrigin: (file: string, content: string, message: string) => void;
    commitIn: (cwd: string, file: string, content: string, message: string) => void;
}

/**
 * Registers the `beforeEach` that builds one bare-remote + clone + worktree layout, and answers
 * the state and the script-driving helpers both the sync and the restore suites run against. Must
 * be called from inside a `describe` — `beforeEach` binds to whichever suite is current.
 */
export function setupWorktreeFixture(): WorktreeFixture {
    let dir: string;
    let checkout: string;
    let branch: string;
    let work: string;
    let bare: string;

    const syncEnv = (root = ROOT): Record<string, string> => ({
        CHECKOUT: join(dir, 'task', 'factory'),
        REMOTE: `file://${bare}`,
        BRANCH: `factory/${root}`,
    });

    const sync = (root = ROOT): SyncVerdict => runScript(syncEnv(root));

    const restore = (root = ROOT): SyncVerdict => runScript({ ...syncEnv(root), RESTORE: '1' });

    const pushToOrigin = (file: string, content: string, message: string): void => {
        writeFileSync(join(work, file), content);
        git(work, 'add', file);
        git(work, 'commit', '-m', message);
        git(work, 'push', 'origin', 'main');
    };

    const commitIn = (cwd: string, file: string, content: string, message: string): void => {
        writeFileSync(join(cwd, file), content);
        git(cwd, 'add', file);
        git(cwd, 'commit', '-m', message);
    };

    beforeEach(async () => {
        // Every git call here is synchronous, and vitest awaits tests without a macrotask turn, so
        // the worker reads no RPC reply until something yields: a suite of these past 60s times out
        // its own `onTaskUpdate` calls and the run loses files' reports. One event-loop turn per test.
        await new Promise((resolve) => setImmediate(resolve));
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-worktree-')));
        // The real layout: the task's own checkout at <volume>/<repo>, cloned from the remote.
        mkdirSync(join(dir, 'task'));
        checkout = join(dir, 'task', 'factory');
        branch = `factory/${ROOT}`;
        ({ work, bare } = makeOrigin(dir));
        // The work copy pushes to the bare the way a real checkout pushes to its forge.
        git(work, 'remote', 'add', 'origin', bare);
    });

    return {
        dir: () => dir,
        checkout: () => checkout,
        branch: () => branch,
        work: () => work,
        bare: () => bare,
        syncEnv,
        sync,
        restore,
        pushToOrigin,
        commitIn,
    };
}
