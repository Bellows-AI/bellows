import { spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gateForgeScript } from '../src/container-scripts.js';

/*
 * The forge helper (`scripts/gate-forge.sh`), run for real against a scratch mailbox with the test playing
 * the supervisor: it writes `answers/<pid>` for each `asks/<pid>` the helper makes, and keeps what each ask said.
 */
const dirs: string[] = [];
const timers: NodeJS.Timeout[] = [];
afterEach(() => {
    for (const timer of timers.splice(0)) clearInterval(timer);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'ghs_helper_token';

function rig() {
    const dir = mkdtempSync(join(tmpdir(), 'gate-forge-'));
    dirs.push(dir);
    const run = join(dir, 'run');
    const bin = join(dir, 'bin');
    const real = join(dir, 'real');
    for (const path of [join(run, 'asks'), join(run, 'answers'), bin, real]) mkdirSync(path, { recursive: true });
    writeFileSync(join(bin, 'gh'), gateForgeScript);
    chmodSync(join(bin, 'gh'), 0o700);
    const asked: string[] = [];
    const said: string[] = [];
    /** Plays the supervisor: answers each ask with `reply(n)`, written the way the supervisor writes it. */
    const supervisor = (reply: (n: string) => string | null) => {
        timers.push(
            setInterval(() => {
                for (const n of readdirSync(join(run, 'asks'))) {
                    if (n.startsWith('.') || asked.includes(n)) continue;
                    asked.push(n);
                    said.push(readFileSync(join(run, 'asks', n), 'utf8'));
                    const text = reply(n);
                    if (text === null) continue;
                    writeFileSync(join(run, 'answers', `${n}.tmp`), text);
                    renameSync(join(run, 'answers', `${n}.tmp`), join(run, 'answers', n));
                }
            }, 10)
        );
    };
    const fakeGh = (body: string) => {
        writeFileSync(join(real, 'gh'), `#!/bin/sh\n${body}\n`);
        chmodSync(join(real, 'gh'), 0o755);
    };
    return { dir, run, bin, real, asked, said, supervisor, fakeGh };
}

interface Ran {
    status: number | null;
    stdout: string;
    stderr: string;
    ms: number;
}
const exec = (shell: string, args: string[], env: Record<string, string>, stdin = ''): Promise<Ran> =>
    new Promise((resolve, reject) => {
        const started = Date.now();
        const child = spawn(shell, args, { env: { ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }));
        // The helper may exit without reading its request (another host, store, erase): the pipe it closed is an
        // outcome under test, not a harness failure. Any other stdin error still fails the case.
        child.stdin.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EPIPE') reject(error);
        });
        child.stdin.end(stdin);
    });

const GITHUB = 'protocol=https\nhost=github.com\n\n';
const GITLAB_HOST = 'gitlab.example.com';
const GITLAB = `protocol=https\nhost=${GITLAB_HOST}\n\n`;
const SHELLS = ['/bin/sh', ...(existsSync('/bin/dash') ? ['/bin/dash'] : [])];

describe('the exec harness', () => {
    it('reports a child that exits without reading its stdin, never an unhandled EPIPE', async () => {
        // Far past a pipe's buffer, so the write is still in flight when the child is gone.
        const ran = await exec('/bin/sh', ['-c', 'exit 0'], { PATH: '/usr/bin:/bin' }, 'x'.repeat(1 << 20));
        expect(ran.status).toBe(0);
    });
});

describe.each(SHELLS)('the forge helper under %s', (shell) => {
    const credential = (r: ReturnType<typeof rig>, op: string, stdin: string, extra: Record<string, string> = {}) =>
        exec(
            shell,
            [join(r.bin, 'gh'), op],
            { PATH: '/usr/bin:/bin', FACTORY_GATE_RUN: r.run, FACTORY_GATE_MODE: 'credential', ...extra },
            stdin
        );

    it('answers git’s get for github.com with the granted token', async () => {
        const r = rig();
        r.supervisor(() => `token ${TOKEN}\n`);
        const ran = await credential(r, 'get', GITHUB);
        expect(ran.status).toBe(0);
        expect(ran.stdout).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
        expect(r.asked).toHaveLength(1);
        expect(r.said).toEqual(['ask github.com\n']);
        // The answer is read and gone; the staging file never lingers.
        expect(readdirSync(join(r.run, 'answers'))).toEqual([]);
        expect(readdirSync(join(r.run, 'asks')).filter((name) => name.startsWith('.'))).toEqual([]);
    });

    it('asks nothing for another host, another protocol, or store and erase', async () => {
        const r = rig();
        r.supervisor(() => `token ${TOKEN}\n`);
        for (const [op, stdin] of [
            ['get', 'protocol=https\nhost=example.com\n\n'],
            ['get', 'protocol=http\nhost=github.com\n\n'],
            ['store', GITHUB],
            ['erase', GITHUB],
        ] as const) {
            const ran = await credential(r, op, stdin);
            expect(ran.status, `${op} ${stdin}`).toBe(0);
            expect(ran.stdout).toBe('');
        }
        expect(r.asked).toEqual([]);
    });

    it('answers a host FACTORY_FORGE_HOSTS lists as oauth2, asking for that host', async () => {
        const r = rig();
        r.supervisor(() => `token ${TOKEN}\n`);
        const ran = await credential(r, 'get', GITLAB, { FACTORY_FORGE_HOSTS: `other.example.com,${GITLAB_HOST}` });
        expect(ran.status).toBe(0);
        expect(ran.stdout).toBe(`username=oauth2\npassword=${TOKEN}\n`);
        expect(r.said).toEqual([`ask ${GITLAB_HOST}\n`]);
    });

    it('normalizes the host git names: lowercase, no :443', async () => {
        const r = rig();
        r.supervisor(() => `token ${TOKEN}\n`);
        const extra = { FACTORY_FORGE_HOSTS: GITLAB_HOST };
        const gitlab = await credential(r, 'get', 'protocol=https\nhost=GitLab.Example.COM:443\n\n', extra);
        expect(gitlab.stdout).toBe(`username=oauth2\npassword=${TOKEN}\n`);
        const github = await credential(r, 'get', 'protocol=https\nhost=GitHub.com:443\n\n', extra);
        expect(github.stdout).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
        expect(r.said).toEqual([`ask ${GITLAB_HOST}\n`, 'ask github.com\n']);
    });

    it('answers github.com whatever FACTORY_FORGE_HOSTS lists', async () => {
        const r = rig();
        r.supervisor(() => `token ${TOKEN}\n`);
        const ran = await credential(r, 'get', GITHUB, { FACTORY_FORGE_HOSTS: GITLAB_HOST });
        expect(ran.stdout).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    });

    it('asks nothing for a host it is not configured for, nor for a foreign or malformed one', async () => {
        const r = rig();
        r.supervisor(() => `token ${TOKEN}\n`);
        for (const [stdin, extra] of [
            [GITLAB, {}],
            ['protocol=https\nhost=evil.example.com\n\n', { FACTORY_FORGE_HOSTS: GITLAB_HOST }],
            [`protocol=http\nhost=${GITLAB_HOST}\n\n`, { FACTORY_FORGE_HOSTS: GITLAB_HOST }],
            [`protocol=https\nhost=${GITLAB_HOST}:8443\n\n`, { FACTORY_FORGE_HOSTS: GITLAB_HOST }],
            ['protocol=https\nhost=a b\n\n', { FACTORY_FORGE_HOSTS: 'a b' }],
            ['protocol=https\nhost=*\n\n', { FACTORY_FORGE_HOSTS: '*' }],
        ] as const) {
            const ran = await credential(r, 'get', stdin, extra);
            expect(ran.status, stdin).toBe(0);
            expect(ran.stdout, stdin).toBe('');
            expect(ran.stderr, stdin).toBe('');
        }
        expect(r.asked).toEqual([]);
    });

    it('says on stderr alone that the token is waited on, never printing a password', async () => {
        const r = rig();
        r.supervisor(() => 'none waiting\n');
        const ran = await credential(r, 'get', GITLAB, { FACTORY_FORGE_HOSTS: GITLAB_HOST });
        expect(ran.status).toBe(1);
        expect(ran.stdout).toBe('');
        expect(ran.stderr).toMatch(/^gate-forge: no token \(waiting[^\n]*\)\n$/);
    });

    it('fails with no output when the ask is refused, naming the reason', async () => {
        const r = rig();
        r.supervisor(() => 'none refused\n');
        const ran = await credential(r, 'get', GITHUB);
        expect(ran.status).toBe(1);
        expect(ran.stdout).toBe('');
        expect(ran.stderr).toContain('refused');
    });

    it('keeps waiting through a garbled answer for a good one', async () => {
        const r = rig();
        let tries = 0;
        r.supervisor(() => (++tries === 1 ? 'garbage\n' : `token ${TOKEN}\n`));
        // The first answer is garbled and stays in place; the answer file is replaced by the second ask only.
        const ran = await credential(r, 'get', GITHUB, { FACTORY_GATE_ASK_SECONDS: '1' });
        expect(ran.stdout).toBe('');
        expect(ran.status).not.toBe(0);
    });

    it('gives up on an ask nobody answers within its wall-clock bound, with nothing on stdout', async () => {
        const r = rig();
        r.supervisor(() => null);
        const ran = await credential(r, 'get', GITHUB, { FACTORY_GATE_ASK_SECONDS: '1' });
        expect(ran.status).not.toBe(0);
        expect(ran.stdout).toBe('');
        expect(ran.stderr).toContain('unanswered');
        expect(ran.stderr).not.toContain('password');
        expect(ran.ms).toBeGreaterThanOrEqual(900);
        expect(ran.ms).toBeLessThan(5_000);
    });

    it('fails without a mailbox rather than printing an empty password', async () => {
        const r = rig();
        const ran = await exec(
            shell,
            [join(r.bin, 'gh'), 'get'],
            { PATH: '/usr/bin:/bin', FACTORY_GATE_MODE: 'credential' },
            GITHUB
        );
        expect(ran.status).toBe(1);
        expect(ran.stdout).toBe('');
    });

    describe('as the gh shim', () => {
        const shim = (r: ReturnType<typeof rig>, args: string[], extra: Record<string, string> = {}) =>
            exec(shell, [join(r.bin, 'gh'), ...args], {
                PATH: `${r.bin}:${r.real}:/usr/bin:/bin`,
                FACTORY_GATE_RUN: r.run,
                ...extra,
            });

        it('runs the image’s gh with the granted token, which wins over an inherited one, its argv and exit status kept', async () => {
            const r = rig();
            r.supervisor(() => `token ${TOKEN}\n`);
            r.fakeGh('echo "token=$GH_TOKEN args=$*"; exit 5');
            const ran = await shim(r, ['pr', 'view'], { GITHUB_TOKEN: 'ghs_inherited', GH_TOKEN: 'ghs_inherited_too' });
            expect(ran.status).toBe(5);
            expect(ran.stdout).toBe(`token=${TOKEN} args=pr view\n`);
            expect(ran.stderr).toBe('');
        });

        it('skips its own directory on PATH to find the real gh, so it never recurses into itself', async () => {
            const r = rig();
            r.supervisor(() => `token ${TOKEN}\n`);
            r.fakeGh('echo "the real gh"');
            const ran = await shim(r, [], { FACTORY_FORGE_HOSTS: GITLAB_HOST });
            expect(ran.stdout).toBe('the real gh\n');
            expect(r.said).toEqual(['ask github.com\n']);
        });

        it('runs gh with no token from it, and says so on stderr, when the ask fails', async () => {
            const r = rig();
            r.supervisor(() => 'none refused\n');
            r.fakeGh('echo "token=[$GH_TOKEN]"');
            const ran = await shim(r, []);
            expect(ran.stdout).toBe('token=[]\n');
            expect(ran.stderr.trim().split('\n')).toHaveLength(1);
            expect(ran.stderr).toContain('refused');
        });

        it('answers 127 when the image has no gh of its own', async () => {
            const r = rig();
            r.supervisor(() => `token ${TOKEN}\n`);
            // No system dirs on PATH: a CI host may ship its own gh in /usr/bin.
            const ran = await shim(r, [], { PATH: `${r.bin}:${r.real}` });
            expect(ran.status).toBe(127);
            expect(ran.stderr).toContain('gh: not found');
        });
    });
});

describe('the forge helper’s script', () => {
    it('parses as POSIX sh and uses no bashism', () => {
        expect(spawnSync('sh', ['-n'], { input: gateForgeScript }).status).toBe(0);
        for (const bashism of ['[[', 'function ', 'local ', "$'", 'source ', '==', '<<<', 'declare ', '${!']) {
            expect(gateForgeScript, bashism).not.toContain(bashism);
        }
    });

    it('runs its own tools by absolute path, so the gate command’s PATH can never reach them', () => {
        const code = gateForgeScript
            .split('\n')
            .filter((line) => !/^\s*#/.test(line))
            .join('\n');
        for (const tool of ['mv', 'cat', 'rm', 'sleep', 'mkdir', 'date']) {
            expect(code, tool).not.toMatch(new RegExp(`(^|[\\s;|&(])${tool}\\s`, 'm'));
        }
        expect(existsSync(join(tmpdir()))).toBe(true);
        expect(readFileSync(new URL('../src/scripts/gate-forge.sh', import.meta.url), 'utf8')).toBe(gateForgeScript);
    });

    it('has no trailing whitespace on any line', () => {
        for (const line of gateForgeScript.split('\n')) expect(line).toBe(line.trimEnd());
    });
});
