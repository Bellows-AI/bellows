import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    git,
    hasGit,
    OTHER_ROOT,
    runScript,
    SCRIPT_IDENTITY,
    setupWorktreeFixture,
} from './fixtures/git-worktree-support.js';

/**
 * The task checkout script's creation is all-or-nothing, and its git commands that can lazily
 * fetch (a partial clone's blobs) run under the claim's credential helper.
 */
describe.skipIf(!hasGit())('the task checkout script (atomic creation, credentialed lazy fetch)', () => {
    const fx = setupWorktreeFixture();

    /** The directory beside the checkout where a fresh tree is built before it is renamed into place. */
    const buildDir = (): string => join(dirname(fx.checkout()), '.factory.sync');

    /**
     * A `git` on PATH that logs every invocation, and dies like a SIGKILLed process (exit 137) on the
     * subcommands named in `dieOn`. The script's children resolve git through PATH.
     */
    const shim = (dieOn: string[] = [], originUrl = ''): { env: Record<string, string>; log: () => string[] } => {
        const home = mkdtempSync(join(tmpdir(), 'factory-gitshim-'));
        const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
        const logFile = join(home, 'log');
        writeFileSync(
            join(home, 'git'),
            [
                '#!/bin/sh',
                `printf '%s\\n' "$*" >> '${logFile}'`,
                // git expands insteadOf in `remote get-url`; the script must see the https origin the claim names.
                ...(originUrl ? [`[ "$1 $2" = 'remote get-url' ] && { echo '${originUrl}'; exit 0; }`] : []),
                'for a in "$@"; do',
                '  case "$a" in',
                ...dieOn.map((sub) => `    ${sub}) exit 137 ;;`),
                '  esac',
                'done',
                `exec '${real}' "$@"`,
            ].join('\n')
        );
        chmodSync(join(home, 'git'), 0o755);
        return {
            env: { PATH: `${home}:${process.env.PATH ?? ''}` },
            log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []),
        };
    };

    const syncWith = (extra: Record<string, string>) => runScript({ ...fx.syncEnv(), ...extra });

    /**
     * What an older, non-atomic sync left when it was killed inside `checkout -b`: a git dir whose HEAD
     * is already the task branch, no index and no files — every file would read as staged-deleted.
     */
    const halfMade = (): void => {
        git(dirname(fx.checkout()), 'clone', '--no-checkout', `file://${fx.bare()}`, fx.checkout());
        git(fx.checkout(), 'update-ref', `refs/heads/${fx.branch()}`, 'origin/main');
        git(fx.checkout(), 'symbolic-ref', 'HEAD', `refs/heads/${fx.branch()}`);
    };

    describe('a creation killed midway never leaves a tree the next claim misreads', () => {
        it('leaves no checkout path behind when the checkout step dies, and the next sync starts clean', () => {
            const dying = shim(['checkout']);
            expect(() => syncWith(dying.env)).not.toThrow();

            expect(existsSync(fx.checkout())).toBe(false);

            expect(fx.sync()).toMatchObject({ ok: true, reason: null });
            expect(readFileSync(join(fx.checkout(), 'README.md'), 'utf8')).toBe('# factory\n');
            expect(git(fx.checkout(), 'status', '--porcelain')).toBe('');
            expect(existsSync(buildDir())).toBe(false);
        });

        it('replaces a stale build directory a killed sync left beside the checkout', () => {
            mkdirSync(join(buildDir(), '.git'), { recursive: true });
            writeFileSync(join(buildDir(), 'junk'), 'half\n');

            expect(fx.sync()).toMatchObject({ ok: true, reason: null });

            expect(existsSync(join(fx.checkout(), 'junk'))).toBe(false);
            expect(readFileSync(join(fx.checkout(), 'README.md'), 'utf8')).toBe('# factory\n');
            expect(existsSync(buildDir())).toBe(false);
        });

        it('rebuilds a checkout an older sync killed between the clone and the checkout (a git dir, no index, no files)', () => {
            halfMade();

            expect(fx.sync()).toMatchObject({ ok: true, reason: null });

            expect(readFileSync(join(fx.checkout(), 'README.md'), 'utf8')).toBe('# factory\n');
            // Not every file staged as deleted: a publish's `git add -A` would commit that.
            expect(git(fx.checkout(), 'status', '--porcelain')).toBe('');
        });

        it('refuses an index-less checkout that holds files, keeping them', () => {
            halfMade();
            writeFileSync(join(fx.checkout(), 'MINE.md'), 'work\n');

            const result = fx.sync();

            expect(result).toMatchObject({ ok: false });
            expect(result.reason).toContain('no index');
            expect(readFileSync(join(fx.checkout(), 'MINE.md'), 'utf8')).toBe('work\n');
        });

        it('refuses to continue an index-less checkout (RESTORE) rather than hand it to the agent', () => {
            halfMade();

            const result = fx.restore();

            expect(result).toMatchObject({ ok: false, kind: 'branch_unrestorable' });
            expect(result.reason).toContain('no index');
        });

        it('rebuilds a reviewer worktree that lost its index to a killed creation', () => {
            expect(fx.sync()).toMatchObject({ ok: true });
            const ref = 'refs/factory/review/55555555-5555-4555-8555-555555555555/security-1';
            execFileSync('node', [join(import.meta.dirname, '..', 'src', 'scripts', 'git-review-snapshot.cjs')], {
                env: { ...process.env, ...SCRIPT_IDENTITY, REPO: fx.checkout(), REVIEW_REF: ref },
                encoding: 'utf8',
            });
            const tree = join(fx.checkout(), '..', '.factory', 'reviews', OTHER_ROOT);
            const env = { REPO: fx.checkout(), WORKTREE: tree, BRANCH: `factory/${OTHER_ROOT}`, REVIEW_REF: ref };
            expect(runScript(env)).toMatchObject({ ok: true });
            const index = git(tree, 'rev-parse', '--git-path', 'index');
            rmSync(resolve(tree, index), { force: true });
            for (const name of readdirSync(tree)) if (name !== '.git') rmSync(join(tree, name), { recursive: true });

            expect(runScript(env)).toMatchObject({ ok: true });

            expect(readFileSync(join(tree, 'README.md'), 'utf8')).toBe('# factory\n');
            expect(git(tree, 'status', '--porcelain')).toBe('');
        });
    });

    describe('every git command that can fetch runs under the credential helper (partial clone)', () => {
        const HELPER = '!f() { echo password=x; }; f';
        const URL = 'https://example.invalid/acme/factory.git';

        /** The https remote the script requires with a helper, served from the local bare through insteadOf. */
        const credentialed = (extra: Record<string, string> = {}): Record<string, string> => ({
            REMOTE: URL,
            CRED_HELPER: HELPER,
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: `url.file://${fx.bare()}.insteadOf`,
            GIT_CONFIG_VALUE_0: URL,
            ...extra,
        });

        const partial = (): void => {
            git(fx.bare(), 'config', 'uploadpack.allowFilter', 'true');
            git(fx.bare(), 'config', 'uploadpack.allowAnySHA1InWant', 'true');
        };

        it('clones partially and checks out under the helper', () => {
            partial();
            const spy = shim();

            expect(syncWith(credentialed(spy.env))).toMatchObject({ ok: true, reason: null });

            expect(git(fx.checkout(), 'config', 'remote.origin.promisor')).toBe('true');
            expect(readFileSync(join(fx.checkout(), 'README.md'), 'utf8')).toBe('# factory\n');
            const withHelper = (sub: string) =>
                spy
                    .log()
                    .filter((line) => line.split(' ').includes(sub) && line.includes(`credential.helper=${HELPER}`));
            expect(withHelper('clone')).toHaveLength(1);
            expect(withHelper('checkout').length).toBeGreaterThan(0);
            // No fetching command of the sync runs without it.
            for (const sub of ['checkout', 'rebase', 'fetch', 'clone']) {
                const bare = spy
                    .log()
                    .filter((line) => line.split(' ').includes(sub) && !line.includes('credential.helper='));
                expect(bare, sub).toEqual([]);
            }
        });

        it('rebases a present checkout under the helper', () => {
            partial();
            expect(syncWith(credentialed())).toMatchObject({ ok: true });
            fx.commitIn(fx.checkout(), 'TASK.md', 'task work\n', 'the task commit');
            fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');
            const spy = shim([], URL);

            expect(syncWith(credentialed(spy.env))).toMatchObject({ ok: true, reason: null });

            const rebases = spy.log().filter((line) => line.split(' ').includes('rebase'));
            expect(rebases.length).toBeGreaterThan(0);
            for (const line of rebases) expect(line).toContain(`credential.helper=${HELPER}`);
        });
    });
});
