import { execFile, execFileSync } from 'node:child_process';
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGit } from './fixtures/git-worktree-support.js';

/*
 * The driver's git over a checkout the agent's tool uid wrote (`scripts/git-harden.cjs`, the `git`
 * every supervised step resolves to). One case per execution-capable setting: it is planted in a real
 * repository, the unhardened control must RUN it (a marker file appears: otherwise the case proves
 * nothing), and the same argv through the supervisor's own step runner must NOT.
 */
process.env.SUPERVISOR_NO_MAIN = '1';

interface Supervisor {
    settingsOf(env: Record<string, string>): unknown;
    spawnStep(
        run: unknown,
        step: { argv: string[]; cwd: string; env: Record<string, string>; timeoutMs: number }
    ): Promise<{ result: { exitCode: number; stdout: string; stderr: string } }>;
}
interface Harden {
    hardeningPairs(entries: { scope: string; key: string; value: string }[]): [string, string][];
    parseList(buffer: Buffer): { scope: string; key: string; value: string }[];
}

const CASE_TIMEOUT_MS = 180_000;

describe.skipIf(!hasGit())('the driver git over agent-written checkout config', () => {
    const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as Supervisor;
    const harden = createRequire(import.meta.url)('../src/scripts/git-harden.cjs') as Harden;
    let root: string;
    let server: Server;
    let serverUrl: string;
    let n = 0;

    /** What would let the harness's own environment answer for a setting the case plants. */
    const OVERRIDES = [
        'GIT_EDITOR',
        'GIT_SEQUENCE_EDITOR',
        'GIT_PAGER',
        'GIT_ASKPASS',
        'GIT_EXTERNAL_DIFF',
        'GIT_PROXY_COMMAND',
        'GIT_SSH',
        'GIT_SSH_COMMAND',
        'GIT_ALLOW_PROTOCOL',
        'SSH_ASKPASS',
        'EDITOR',
        'VISUAL',
        'PAGER',
    ];
    const saved: Record<string, string | undefined> = {};

    beforeAll(async () => {
        for (const name of OVERRIDES) {
            saved[name] = process.env[name];
            delete process.env[name];
        }
        root = realpathSync(mkdtempSync(join(tmpdir(), 'git-harden-')));
        server = createServer((_request, response) => {
            response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end();
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        buildFixture(join(root, 'template'));
        serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/r.git`;
    }, CASE_TIMEOUT_MS);
    afterAll(async () => {
        for (const name of OVERRIDES) {
            if (saved[name] === undefined) delete process.env[name];
            else process.env[name] = saved[name];
        }
        await new Promise((resolve) => server.close(resolve));
        rmSync(root, { recursive: true, force: true });
    });

    /** The environment both runs share: a global config of our own, no system one, no terminal. */
    const baseEnv = (dir: string): Record<string, string> => ({
        GIT_CONFIG_GLOBAL: join(dir, 'global.gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
    });

    const sh = (cwd: string, ...args: string[]): string =>
        execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...baseEnv(join(cwd, '..')) } });

    interface Case {
        dir: string;
        repo: string;
        /** The path a planted command writes: its existence is the execution. */
        marker: string;
        /** An executable that writes `marker`, with the given extra shell. */
        script(name: string, body?: string): string;
        config(key: string, value: string): void;
    }

    /** A repository with a remote, two commits, a divergent branch and attributes naming a driver of every kind. */
    const buildFixture = (dir: string): void => {
        mkdirSync(join(dir, 'markers'), { recursive: true });
        writeFileSync(
            join(dir, 'global.gitconfig'),
            '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n'
        );
        const bare = join(dir, 'bare.git');
        execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...baseEnv(dir) } });
        const repo = join(dir, 'repo');
        execFileSync('git', ['clone', '-q', bare, repo], { env: { ...process.env, ...baseEnv(dir) }, stdio: 'ignore' });
        writeFileSync(join(repo, 'f'), 'base\n');
        sh(repo, 'add', 'f');
        sh(repo, 'commit', '-qm', 'base');
        writeFileSync(join(repo, '.gitattributes'), 'f filter=x diff=y merge=z\n');
        sh(repo, 'add', '.gitattributes');
        sh(repo, 'commit', '-qm', 'attributes');
        sh(repo, 'push', '-q', 'origin', 'main');
        sh(repo, 'branch', 'other', 'HEAD~1');
        sh(repo, 'switch', '-q', 'other');
        writeFileSync(join(repo, 'f'), 'other\n');
        sh(repo, 'commit', '-qam', 'other');
        sh(repo, 'switch', '-q', 'main');
        writeFileSync(join(repo, 'f'), 'mine\n');
        sh(repo, 'commit', '-qam', 'mine');
    };

    /** The fixture, copied: building one costs a dozen git runs, and a case needs a fresh one. */
    const makeCase = (): Case => {
        n += 1;
        const dir = join(root, `case-${n}`);
        cpSync(join(root, 'template'), dir, { recursive: true });
        const repo = join(dir, 'repo');
        sh(repo, 'remote', 'set-url', 'origin', join(dir, 'bare.git'));
        const marker = join(dir, 'markers', 'ran');
        return {
            dir,
            repo,
            marker,
            script(name, body = '') {
                const file = join(dir, name);
                writeFileSync(file, `#!/bin/sh\n: >> '${marker}'\n${body}\n`);
                chmodSync(file, 0o755);
                return file;
            },
            config: (key, value) => void sh(repo, 'config', key, value),
        };
    };

    const dirty = (c: Case): void => writeFileSync(join(c.repo, 'f'), 'changed\n');

    /** The step runner of the supervisor, over the same environment as the control. */
    const hardened = async (c: Case, argv: string[]): Promise<{ exitCode: number; stderr: string; stdout: string }> => {
        const env = baseEnv(c.dir);
        const run = {
            settings: supervisor.settingsOf({ ...process.env, ...env } as Record<string, string>),
            stop: new AbortController(),
            inflight: null,
        };
        const { result } = await supervisor.spawnStep(run, { argv, cwd: c.repo, env, timeoutMs: 30_000 });
        return result;
    };

    const run = hardened;

    /** The same argv through the real git, as a driver step would run it unhardened. */
    const control = (c: Case, argv: string[]): Promise<void> =>
        new Promise((resolve) => {
            const [exe, ...args] = argv;
            // A planted command usually breaks the call; the marker is what the control is about.
            execFile(exe!, args, { cwd: c.repo, env: { ...process.env, ...baseEnv(c.dir) }, timeout: 30_000 }, () =>
                resolve()
            );
        });

    interface Vector {
        name: string;
        /** Plants the setting; may stage or dirty the tree the argv needs. */
        plant(c: Case): void;
        argv: string[];
    }

    const vectors: Vector[] = [
        {
            name: 'core.fsmonitor',
            plant: (c) => {
                dirty(c);
                c.config('core.fsmonitor', c.script('fsm', 'echo'));
            },
            argv: ['git', 'status', '--porcelain'],
        },
        {
            name: 'core.hooksPath',
            plant: (c) => {
                dirty(c);
                mkdirSync(join(c.dir, 'hooks'));
                writeFileSync(join(c.dir, 'hooks', 'pre-commit'), `#!/bin/sh\n: >> '${c.marker}'\n`, { mode: 0o755 });
                c.config('core.hooksPath', join(c.dir, 'hooks'));
            },
            argv: ['git', 'commit', '-qam', 'x'],
        },
        {
            name: '.git/hooks',
            plant: (c) => {
                dirty(c);
                writeFileSync(join(c.repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n: >> '${c.marker}'\n`, {
                    mode: 0o755,
                });
            },
            argv: ['git', 'commit', '-qam', 'x'],
        },
        {
            name: 'a hook of a push',
            plant: (c) => {
                writeFileSync(join(c.repo, '.git', 'hooks', 'pre-push'), `#!/bin/sh\n: >> '${c.marker}'\n`, {
                    mode: 0o755,
                });
            },
            argv: ['git', 'push', 'origin', 'HEAD:refs/heads/pushed'],
        },
        {
            name: 'core.sshCommand',
            plant: (c) => {
                sh(c.repo, 'remote', 'add', 'sshr', 'ssh://example.invalid/x');
                c.config('core.sshCommand', c.script('ssh', 'exit 1'));
            },
            argv: ['git', 'ls-remote', 'sshr'],
        },
        {
            name: 'core.editor',
            plant: (c) => {
                dirty(c);
                sh(c.repo, 'add', 'f');
                c.config('core.editor', c.script('editor', 'exit 1'));
            },
            argv: ['git', 'commit'],
        },
        {
            name: 'sequence.editor',
            plant: (c) => c.config('sequence.editor', c.script('seq', 'exit 1')),
            argv: ['git', 'rebase', '-i', 'HEAD~1'],
        },
        {
            name: 'diff.external',
            plant: (c) => {
                dirty(c);
                c.config('diff.external', c.script('ext'));
            },
            argv: ['git', 'diff'],
        },
        {
            name: 'diff.<driver>.textconv',
            plant: (c) => {
                dirty(c);
                c.config('diff.y.textconv', c.script('textconv', 'cat "$1"'));
            },
            argv: ['git', 'diff'],
        },
        {
            name: 'diff.<driver>.command',
            plant: (c) => {
                dirty(c);
                c.config('diff.y.command', c.script('driver'));
            },
            argv: ['git', 'diff'],
        },
        {
            name: 'filter.<driver>.clean',
            plant: (c) => {
                dirty(c);
                c.config('filter.x.clean', `${c.script('clean')}; cat`);
            },
            argv: ['git', 'add', '-A'],
        },
        {
            name: 'filter.<driver>.clean, required',
            plant: (c) => {
                dirty(c);
                c.config('filter.x.clean', `${c.script('clean')}; cat`);
                c.config('filter.x.required', 'true');
            },
            argv: ['git', 'add', '-A'],
        },
        {
            name: 'filter.<driver>.smudge',
            plant: (c) => {
                dirty(c);
                c.config('filter.x.smudge', `${c.script('smudge')}; cat`);
            },
            argv: ['git', 'checkout', '--', 'f'],
        },
        {
            name: 'filter.<driver>.process',
            plant: (c) => {
                dirty(c);
                c.config('filter.x.process', c.script('process', 'exit 1'));
            },
            argv: ['git', 'add', '-A'],
        },
        {
            name: 'merge.<driver>.driver',
            plant: (c) => c.config('merge.z.driver', `${c.script('merge')} %O %A %B`),
            argv: ['git', 'merge', '--no-edit', 'other'],
        },
        {
            name: 'a filter defined by an include',
            plant: (c) => {
                dirty(c);
                writeFileSync(join(c.dir, 'extra'), `[filter "x"]\n\tclean = ${c.script('clean')}; cat\n`);
                c.config('include.path', join(c.dir, 'extra'));
            },
            argv: ['git', 'add', '-A'],
        },
        {
            name: 'core.fsmonitor defined by an includeIf',
            plant: (c) => {
                dirty(c);
                writeFileSync(join(c.dir, 'extra'), `[core]\n\tfsmonitor = ${c.script('fsm', 'echo')}\n`);
                c.config(`includeIf.gitdir:${c.repo}/.git.path`, join(c.dir, 'extra'));
            },
            argv: ['git', 'status', '--porcelain'],
        },
        {
            name: 'gpg.program',
            plant: (c) => {
                dirty(c);
                c.config('commit.gpgsign', 'true');
                c.config('gpg.program', c.script('gpg', 'exit 1'));
            },
            argv: ['git', 'commit', '-qam', 'x'],
        },
        {
            name: 'remote.<name>.uploadpack',
            plant: (c) => c.config('remote.origin.uploadpack', `${c.script('up')}; git-upload-pack`),
            argv: ['git', 'fetch', 'origin'],
        },
        {
            name: 'remote.<name>.receivepack',
            plant: (c) => c.config('remote.origin.receivepack', `${c.script('rp')}; git-receive-pack`),
            argv: ['git', 'push', 'origin', 'HEAD:refs/heads/pushed'],
        },
        {
            name: 'an ext:: remote with its protocol allowed',
            plant: (c) => {
                sh(c.repo, 'remote', 'add', 'extr', `ext::${c.script('ext-remote', 'exit 1')}`);
                c.config('protocol.ext.allow', 'always');
            },
            argv: ['git', 'ls-remote', 'extr'],
        },
        {
            name: 'core.gitProxy',
            plant: (c) => {
                sh(c.repo, 'remote', 'add', 'gitr', 'git://example.invalid/x');
                c.config('core.gitProxy', c.script('proxy', 'exit 1'));
            },
            argv: ['git', 'ls-remote', 'gitr'],
        },
        {
            name: 'core.askPass',
            plant: (c) => {
                sh(c.repo, 'remote', 'add', 'httpr', serverUrl);
                c.config('core.askPass', c.script('askpass', 'echo x'));
            },
            argv: ['git', 'ls-remote', 'httpr'],
        },
        {
            name: 'trailer.<token>.command',
            plant: (c) => {
                writeFileSync(join(c.dir, 'message'), 'subject\n');
                c.config('trailer.x.command', `${c.script('trailer')}; echo v`);
            },
            argv: ['git', 'interpret-trailers', '--trailer', 'x', join('..', 'message')],
        },
    ];

    for (const vector of vectors) {
        it.concurrent(`${vector.name}: run by the unhardened control, not by the driver's git`, {
            timeout: CASE_TIMEOUT_MS,
        }, async () => {
            const c = makeCase();
            vector.plant(c);

            await control(c, vector.argv);
            expect(existsSync(c.marker), 'the control must execute the planted setting').toBe(true);
            rmSync(c.marker);

            await hardened(c, vector.argv);
            expect(existsSync(c.marker)).toBe(false);
        });
    }

    it('leaves the executor images’ own plumbing reads (branch reporter, entrypoints) nothing to run', async () => {
        // Those run as the CLI's uid with the stock git, outside the supervisor: they stay safe only
        // while they are reads that execute no configured command. Every setting planted at once.
        const c = makeCase();
        dirty(c);
        mkdirSync(join(c.dir, 'hooks'));
        c.config('core.fsmonitor', c.script('fsm', 'echo'));
        c.config('core.hooksPath', join(c.dir, 'hooks'));
        c.config('core.pager', c.script('pager'));
        c.config('core.sshCommand', c.script('ssh'));
        c.config('filter.x.clean', c.script('clean'));
        c.config('diff.y.textconv', c.script('textconv', 'cat "$1"'));
        c.config('credential.helper', c.script('credential'));
        c.config('gpg.program', c.script('gpg'));
        sh(c.repo, 'remote', 'add', 'sshr', 'ssh://example.invalid/x');
        const reads = [
            ['remote', 'get-url', 'origin'],
            ['rev-parse', '--is-inside-work-tree'],
            ['rev-parse', '--abbrev-ref', 'HEAD'],
            ['rev-parse', 'HEAD'],
            ['rev-parse', '--path-format=absolute', '--git-common-dir'],
            ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
            ['var', 'GIT_COMMITTER_IDENT'],
        ];

        for (const read of reads) await control(c, ['git', ...read]);

        expect(existsSync(c.marker)).toBe(false);
    });

    it('keeps the submodule diff the tree fingerprint hashes: diff.external is pinned only where the checkout sets it', async () => {
        const c = makeCase();
        const sub = join(c.dir, 'sub');
        mkdirSync(sub);
        sh(sub, 'init', '-q');
        writeFileSync(join(sub, 's'), 'one\n');
        sh(sub, 'add', 's');
        sh(sub, 'commit', '-qm', 's');
        sh(c.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendored');
        sh(c.repo, 'commit', '-qm', 'submodule');
        writeFileSync(join(c.repo, 'vendored', 's'), 'two\n');

        const diff = await run(c, ['git', 'diff', 'HEAD', '--binary', '--submodule=diff']);

        expect(diff.stdout).toContain('+two');
        expect(Object.fromEntries(harden.hardeningPairs([]))).not.toHaveProperty('diff.external');
        expect(
            Object.fromEntries(harden.hardeningPairs([{ scope: 'local', key: 'diff.external', value: 'x' }]))
        ).toMatchObject({ 'diff.external': 'true' });
    });

    describe('credential helpers', () => {
        const approve = [
            'sh',
            '-c',
            'printf "protocol=https\\nhost=example.test\\nusername=u\\npassword=secret\\n\\n" | git credential approve',
        ];

        it.each(['credential.helper', 'credential.https://example.test.helper'])(
            'a checkout-defined %s is handed the token by the control and never by the driver git',
            async (key) => {
                const c = makeCase();
                c.config(key, `!cat >> '${c.marker}'; true`);

                await control(c, approve);
                expect(existsSync(c.marker) && readFileSync(c.marker, 'utf8')).toContain('password=secret');
                rmSync(c.marker);

                await hardened(c, approve);
                expect(existsSync(c.marker)).toBe(false);
            }
        );

        it('keeps the trusted helpers and the one the caller names, and drops the checkout’s', async () => {
            const c = makeCase();
            const trusted = join(c.dir, 'trusted');
            const caller = join(c.dir, 'caller');
            writeFileSync(
                join(c.dir, 'global.gitconfig'),
                `[user]\n\tname = T\n\temail = t@e\n[credential]\n\thelper = "!cat >> '${trusted}'; true"\n`
            );
            c.config('credential.helper', `!cat >> '${c.marker}'; true`);

            await hardened(c, [
                'sh',
                '-c',
                `printf "protocol=https\\nhost=example.test\\nusername=u\\npassword=secret\\n\\n" | git -c credential.helper='!cat >> ${caller}; true' credential approve`,
            ]);

            expect(existsSync(c.marker)).toBe(false);
            expect(readFileSync(trusted, 'utf8')).toContain('password=secret');
            expect(readFileSync(caller, 'utf8')).toContain('password=secret');
        });
    });

    it('still runs a driver the TRUSTED config defines, even when the checkout redefines it', async () => {
        const c = makeCase();
        const trusted = join(c.dir, 'trusted');
        writeFileSync(
            join(c.dir, 'global.gitconfig'),
            `[user]\n\tname = T\n\temail = t@e\n[filter "x"]\n\tclean = ": >> '${trusted}'; cat"\n`
        );
        dirty(c);
        c.config('filter.x.clean', `${c.script('clean')}; cat`);

        const result = await hardened(c, ['git', 'add', '-A']);

        expect(result.exitCode).toBe(0);
        expect(existsSync(trusted)).toBe(true);
        expect(existsSync(c.marker)).toBe(false);
    });

    it('runs the commands it fronts with the caller’s result: output, exit status and a refusal of an unreadable config', async () => {
        const c = makeCase();
        dirty(c);
        const ok = await hardened(c, ['git', 'status', '--porcelain']);
        expect(ok.exitCode).toBe(0);
        expect(ok.stderr).toBe('');
        expect((await hardened(c, ['git', 'cat-file', '-e', 'deadbeef'])).exitCode).not.toBe(0);

        writeFileSync(join(c.repo, '.git', 'config'), '[core\n\tbroken\n');
        const refused = await hardened(c, ['git', 'status']);
        expect(refused.exitCode).toBe(126);
        expect(refused.stderr).toContain('refused');
    });

    it.each(['uploadpack', 'receivepack', 'vcs'])(
        'refuses every call of a checkout that sets remote.<name>.%s, which no command line can override',
        async (variable) => {
            const c = makeCase();
            c.config(`remote.origin.${variable}`, c.script('named'));

            const refused = await hardened(c, ['git', 'rev-parse', 'HEAD']);

            expect(refused.exitCode).toBe(126);
            expect(refused.stderr).toContain(`remote.origin.${variable}`);
            expect(existsSync(c.marker)).toBe(false);
        }
    );

    it('pins each variable of a family the checkout defines, to the trusted value or an inert one, with the subsection’s case', () => {
        const entries = harden.parseList(
            Buffer.from(
                'local\0filter.LFS.smudge\nrun it\0local\0pager.log\nless\0global\0filter.LFS.clean\ntrusted\0local\0filter.LFS.clean\nhostile\0'
            )
        );

        const pairs = Object.fromEntries(harden.hardeningPairs(entries));

        expect(pairs).toMatchObject({
            'filter.LFS.clean': 'trusted',
            'filter.LFS.smudge': '',
            'pager.log': 'false',
            'core.pager': 'cat',
            'core.hooksPath': '/dev/null',
            'core.fsmonitor': 'false',
        });
    });
});
