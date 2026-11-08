import { execFileSync, spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GIT_STAGE_STEPS, gitProbeScript } from '../src/publish/publish.js';
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
        noChange: boolean;
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

    // Issue #1020: the close-time gates skip only on a CONFIRMED no-change read.
    it('answers noChange only for a clean tree with no diff against the base', () => {
        expect(probe().noChange).toBe(true);

        writeFileSync(join(repo, 'WIP.md'), 'uncommitted\n');
        expect(probe().noChange).toBe(false);

        git(repo, 'add', 'WIP.md');
        git(repo, 'commit', '-m', 'local commit');
        expect(probe().noChange).toBe(false);

        // Committed then reverted: a commit ahead of the base, but no diff against it.
        git(repo, 'revert', '--no-edit', 'HEAD');
        expect(probe()).toMatchObject({ unpushed: 2, noChange: true });
    });

    it('answers noChange false when the base cannot be read', () => {
        git(repo, 'update-ref', '-d', 'refs/remotes/origin/main');
        expect(probe().noChange).toBe(false);
    });

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
            content: null,
            noChange: false,
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

/**
 * The probe's own git calls under the supervisor's hardening (BEL-284): the probe hardens each call in-process with
 * the module the supervisor wrote beside its `git` shim, instead of starting the shim (a node process) per call. The
 * hardening is the same code and still reads the checkout's config before every call.
 */
describe.skipIf(!hasGit())('the probe’s own git under the supervisor’s hardening', () => {
    const fx = setupWorktreeFixture();
    const SCRIPTS = join(import.meta.dirname, '..', 'src', 'scripts');
    const HARDEN_SOURCE = readFileSync(join(SCRIPTS, 'git-harden.cjs'), 'utf8');
    const REAL = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const CONFIG_READ = 'config --list --includes --show-scope -z';
    let tools: string;
    let shimLog: string;
    let realLog: string;
    let seq = 0;

    // The supervisor's directory: a mkdtemp (0700) holding the shim, the module (0644), and a logging real git.
    beforeAll(() => {
        tools = realpathSync(mkdtempSync(join(tmpdir(), 'factory-git-')));
        writeFileSync(
            join(tools, 'git'),
            `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.SHIM_LOG, process.argv.slice(2).join(' ') + '\\n');\n${HARDEN_SOURCE}`,
            { mode: 0o755 }
        );
        writeFileSync(join(tools, 'git-harden.cjs'), HARDEN_SOURCE, { mode: 0o644 });
        // Logs each call's argv; after the last directory listing, which precedes the staging call, it runs
        // $BEFORE_STAGING once.
        writeFileSync(
            join(tools, 'real-git'),
            `#!/bin/sh
printf '%s\\n' "$*" >> "$REAL_LOG"
case "$*" in
*"ls-files -z --others --exclude-standard --directory"*)
    '${REAL}' "$@"; status=$?
    if [ -n "$BEFORE_STAGING" ] && [ ! -e "$BEFORE_STAGING.done" ]; then : > "$BEFORE_STAGING.done"; sh "$BEFORE_STAGING"; fi
    exit $status ;;
esac
exec '${REAL}' "$@"
`,
            { mode: 0o755 }
        );
    });
    afterAll(() => rmSync(tools, { recursive: true, force: true }));

    beforeEach(() => {
        seq += 1;
        shimLog = join(fx.dir(), `shim-${seq}.log`);
        realLog = join(fx.dir(), `real-${seq}.log`);
        writeFileSync(shimLog, '');
        writeFileSync(realLog, '');
    });

    const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter(Boolean);

    interface Ran {
        answer: Record<string, unknown> & { cloned: boolean; fingerprint: string | null; content: string | null };
        stderr: string;
    }
    /** The probe, run as the supervisor would run it; `inProcess: false` is the by-name shim of before. */
    const probe = (extra: Record<string, string> = {}, inProcess = true): Ran => {
        const ran = spawnSync(process.execPath, [join(SCRIPTS, 'git-probe.cjs')], {
            env: {
                ...process.env,
                REPO: fx.checkout(),
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_NOSYSTEM: '1',
                PATH: `${tools}${delimiter}${process.env.PATH ?? ''}`,
                SHIM_LOG: shimLog,
                REAL_LOG: realLog,
                GIT_HARDEN_REAL: join(tools, 'real-git'),
                ...(inProcess ? { GIT_HARDEN_MODULE: join(tools, 'git-harden.cjs') } : {}),
                ...extra,
            },
            encoding: 'utf8',
        });
        return { answer: JSON.parse(ran.stdout.trim().split('\n').filter(Boolean).pop()!), stderr: ran.stderr };
    };

    const synced = (): void => {
        expect(fx.sync().ok).toBe(true);
        // A runner's checkout is case-sensitive; git on a case-folding host turns ignorecase on, and the probe keys nothing then.
        git(fx.checkout(), 'config', 'core.ignorecase', 'false');
    };

    it('runs its own git calls in-process: no hardened-git process starts', () => {
        synced();

        const { answer } = probe();

        expect(answer.cloned).toBe(true);
        expect(answer.fingerprint).toMatch(/^[0-9a-f]{40}:[0-9a-f]{64}$/);
        expect(answer.content).not.toBeNull();
        expect(lines(shimLog)).toEqual([]);
        expect(lines(realLog).length).toBeGreaterThan(30);
    });

    it('reads the checkout’s config before every real git call, and runs each under the hardening prefix', () => {
        synced();

        probe();

        const log = lines(realLog);
        const works = log.filter((line) => !line.endsWith(CONFIG_READ));
        const reads = log.filter((line) => line.endsWith(CONFIG_READ));
        expect(reads).toHaveLength(works.length);
        log.forEach((line, i) => {
            if (line.endsWith(CONFIG_READ)) return;
            expect(line).toMatch(/^--no-pager -c core\.pager=/);
            expect(log[i - 1]?.endsWith(CONFIG_READ)).toBe(true);
        });
    });

    it('adopts a filter the checkout defines mid-probe and still runs none of it', () => {
        synced();
        const mark = join(fx.dir(), 'late-filter-ran');
        const config = join(fx.checkout(), '.git', 'config');
        const install = join(fx.dir(), 'install-late-filter.sh');
        writeFileSync(
            install,
            `cd '${fx.checkout()}' && printf '[filter "late"]\\n\\tclean = touch ${mark}; cat\\n' >> '${config}' && printf '* filter=late\\n' > .gitattributes\n`
        );

        const { answer } = probe({ BEFORE_STAGING: install });

        // The filter was installed after the last listing call, so the pins only exist if the read before `add` saw it.
        expect(existsSync(`${install}.done`)).toBe(true);
        expect(lines(realLog).some((line) => / add -A /.test(line))).toBe(true);
        expect(existsSync(mark)).toBe(false);
        expect(answer.cloned).toBe(true);
    });

    it('runs none of the checkout’s execution-capable config in-process', () => {
        synced();
        const fsmonitorMark = join(fx.dir(), 'fsmonitor-ran');
        const filterMark = join(fx.dir(), 'filter-ran');
        const hookScript = join(fx.dir(), 'fsmonitor.sh');
        writeFileSync(hookScript, `#!/bin/sh\n: > '${fsmonitorMark}'\nprintf '\\0'\n`, { mode: 0o755 });
        git(fx.checkout(), 'config', 'core.fsmonitor', hookScript);
        git(fx.checkout(), 'config', 'filter.evil.clean', `touch ${filterMark}; cat`);
        writeFileSync(join(fx.checkout(), '.gitattributes'), '*.txt filter=evil\n');
        writeFileSync(join(fx.checkout(), 'note.txt'), 'untracked\n');
        // Controls: the same config does run under a plain git, so an absent marker below is the hardening's doing.
        const index = join(fx.dir(), 'control-index');
        const control = {
            cwd: fx.checkout(),
            env: { ...process.env, GIT_INDEX_FILE: index },
            stdio: 'ignore',
        } as const;
        execFileSync(REAL, ['status'], control);
        execFileSync(REAL, ['add', '-A'], control);
        expect(existsSync(fsmonitorMark)).toBe(true);
        expect(existsSync(filterMark)).toBe(true);
        rmSync(fsmonitorMark);
        rmSync(filterMark);

        probe();

        expect(existsSync(fsmonitorMark)).toBe(false);
        expect(existsSync(filterMark)).toBe(false);
    });

    describe('answers exactly as the shim does', () => {
        const { runCall } = createRequire(import.meta.url)(join(SCRIPTS, 'git-harden.cjs')) as {
            runCall(args: string[], options: object): string;
        };
        const COMMANDS = [
            ['status', '--porcelain'],
            ['diff', 'HEAD', '--binary'],
            ['ls-files', '-z', '--others', '--exclude-standard'],
            ['check-attr', '-a', '--', 'README.md'],
            ['var', 'GIT_EDITOR'],
            ['config', '--get-all', 'credential.helper'],
        ];
        /** What each call prints: the by-name shim as a process, and the call run in-process, over one checkout. */
        const bothWays = (args: string[]): { shim: unknown; inProcess: unknown } => {
            const env = {
                ...process.env,
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_HARDEN_REAL: REAL,
                // The environment the hardening strips: an external diff that does not exist.
                GIT_EXTERNAL_DIFF: join(fx.dir(), 'no-such-diff'),
            };
            const shim = spawnSync(join(tools, 'git'), args, {
                cwd: fx.checkout(),
                env: { ...env, SHIM_LOG: shimLog },
                encoding: 'utf8',
            });
            let inProcess: unknown;
            try {
                inProcess = { status: 0, stdout: runCall(args, { cwd: fx.checkout(), env, encoding: 'utf8' }) };
            } catch (error) {
                inProcess = { status: (error as { status: number }).status, stdout: '' };
            }
            return { shim: { status: shim.status, stdout: shim.stdout }, inProcess };
        };
        const cases: Array<[string, (checkout: string) => void]> = [
            ['a synced checkout', () => undefined],
            ['a dirty one', (c) => writeFileSync(join(c, 'WIP.md'), 'work\n')],
            [
                'one with a trusted credential helper and a checkout-named one',
                (c) => {
                    git(c, 'config', 'credential.helper', '!touch credential-ran');
                    git(c, 'config', 'credential.https://example.test.helper', '!touch credential-ran');
                },
            ],
            [
                'one with a named filter family',
                (c) => {
                    git(c, 'config', 'filter.late.clean', 'cat');
                    writeFileSync(join(c, '.gitattributes'), '*.md filter=late\n');
                },
            ],
            [
                'one with a nested repository',
                (c) => {
                    mkdirSync(join(c, 'nested'));
                    git(join(c, 'nested'), 'init');
                    writeFileSync(join(c, 'nested', 'f.txt'), 'x\n');
                },
            ],
            [
                'one with a tracked edit under an external diff in the environment',
                (c) => writeFileSync(join(c, 'README.md'), 'edit\n'),
            ],
        ];
        it.each(cases)('over %s', (_name, arrange) => {
            synced();
            arrange(fx.checkout());

            for (const args of COMMANDS) {
                const { shim, inProcess } = bothWays(args);
                expect(inProcess, args.join(' ')).toEqual(shim);
            }
        });

        it('over a config that names a command: both refuse the same way, with no real git work run', () => {
            synced();
            git(fx.checkout(), 'config', 'remote.origin.uploadpack', 'touch uploadpack-ran');

            const inProcess = probe();
            const refusedLog = lines(realLog);
            writeFileSync(realLog, '');
            const viaShim = probe({}, false);

            expect(inProcess.answer.cloned).toBe(false);
            expect(inProcess.answer).toEqual(viaShim.answer);
            expect(inProcess.stderr).toMatch(/^git: refused, the checkout's config sets .*uploadpack/m);
            expect(inProcess.stderr).toBe(viaShim.stderr);
            expect(refusedLog.every((line) => line.endsWith(CONFIG_READ))).toBe(true);
            expect(lines(realLog)).toEqual(refusedLog);
        });

        it('over a config git cannot parse', () => {
            synced();
            writeFileSync(join(fx.checkout(), '.git', 'config'), '[core\n\tbare = false\n');

            const inProcess = probe();
            const viaShim = probe({}, false);

            expect(inProcess.answer.cloned).toBe(false);
            expect(inProcess.answer).toEqual(viaShim.answer);
            expect(inProcess.stderr).toMatch(/^git: refused, git config could not be read/m);
            expect(inProcess.stderr).toBe(viaShim.stderr);
        });
    });

    describe('the in-process call keeps the shim’s refusal contract', () => {
        const call = (
            args: string[],
            env: Record<string, string>
        ): { status: number | null; stderr: string; out: string } => {
            const ran = spawnSync(
                process.execPath,
                [
                    '-e',
                    `try { process.stdout.write(String(require(process.env.GIT_HARDEN_MODULE).runCall(JSON.parse(process.env.ARGS), { cwd: process.env.CWD, encoding: 'utf8' }))); } catch (e) { process.exitCode = 40; process.stdout.write('status=' + e.status); }`,
                ],
                {
                    env: {
                        ...process.env,
                        GIT_CONFIG_GLOBAL: '/dev/null',
                        GIT_CONFIG_NOSYSTEM: '1',
                        ARGS: JSON.stringify(args),
                        CWD: fx.checkout(),
                        REAL_LOG: realLog,
                        GIT_HARDEN_MODULE: join(tools, 'git-harden.cjs'),
                        ...env,
                    },
                    encoding: 'utf8',
                }
            );
            return { status: ran.status, stderr: ran.stderr, out: ran.stdout };
        };

        it('exits 126 with the shim’s line for a refused config, and never runs the work command', () => {
            synced();
            git(fx.checkout(), 'config', 'core.sshCommand', 'touch ssh-ran');
            git(fx.checkout(), 'config', 'remote.origin.uploadpack', 'touch uploadpack-ran');

            const ran = call(['status'], { GIT_HARDEN_REAL: join(tools, 'real-git') });

            expect(ran.out).toBe('status=126');
            expect(ran.stderr).toMatch(
                /^git: refused, the checkout's config sets .*uploadpack.*which names a command to run\n$/
            );
            expect(lines(realLog).every((line) => line.endsWith(CONFIG_READ))).toBe(true);
        });

        it('exits 126 when the config cannot be read, and when the real git does not start', () => {
            synced();
            writeFileSync(join(fx.checkout(), '.git', 'config'), '[core\n');
            const unreadable = call(['status'], { GIT_HARDEN_REAL: join(tools, 'real-git') });
            const missing = call(['status'], { GIT_HARDEN_REAL: join(tools, 'no-such-git') });

            for (const ran of [unreadable, missing]) {
                expect(ran.out).toBe('status=126');
                expect(ran.stderr).toMatch(/^git: refused, git config could not be read/);
            }
        });

        it('has no real git to run without GIT_HARDEN_REAL', () => {
            const ran = call(['status'], { GIT_HARDEN_REAL: '' });

            expect(ran.out).toBe('status=126');
            expect(ran.stderr).toBe('git: the hardened git has no real git to run\n');
        });
    });

    describe('when the module cannot load', () => {
        it('runs the shim at its absolute path: the module file missing', () => {
            const moved = join(fx.dir(), 'no-module');
            mkdirSync(moved);
            writeFileSync(join(moved, 'git'), readFileSync(join(tools, 'git')), { mode: 0o755 });
            // Not a checkout: the first call is refused by git itself, so the shim is reached once and the run stays short.
            const elsewhere = { REPO: fx.dir() };

            const viaShim = probe(elsewhere, false);
            writeFileSync(shimLog, '');
            const { answer, stderr } = probe({ ...elsewhere, GIT_HARDEN_MODULE: join(moved, 'git-harden.cjs') });

            expect(answer).toEqual(viaShim.answer);
            expect(stderr).toBe(viaShim.stderr);
            expect(lines(shimLog)).toEqual(['rev-parse --is-inside-work-tree']);
        });

        it('refuses with 126, not a bare `git`: the whole directory missing', () => {
            synced();
            const trap = join(fx.dir(), 'trap');
            mkdirSync(trap);
            writeFileSync(
                join(trap, 'git'),
                `#!/bin/sh\n: > '${join(fx.dir(), 'by-name-git-ran')}'\nexec '${REAL}' "$@"\n`,
                { mode: 0o755 }
            );

            const { answer, stderr } = probe({
                GIT_HARDEN_MODULE: join(fx.dir(), 'gone', 'git-harden.cjs'),
                PATH: `${trap}${delimiter}${process.env.PATH ?? ''}`,
            });

            expect(answer.cloned).toBe(false);
            expect(stderr).toMatch(/^git: .*ENOENT/m);
            expect(existsSync(join(fx.dir(), 'by-name-git-ran'))).toBe(false);
        });
    });

    it('trusts only what the supervisor wrote: a private directory, a read-only module', () => {
        expect(statSync(tools).mode & 0o777).toBe(0o700);
        expect(statSync(join(tools, 'git-harden.cjs')).mode & 0o777).toBe(0o644);
    });
});
