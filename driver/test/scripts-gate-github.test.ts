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
import { gateGithubScript } from '../src/container-scripts.js';

/*
 * The gate's GitHub helper (`scripts/gate-github.sh`), run for real against a scratch mailbox with the
 * test playing the supervisor: it writes `answers/<pid>` for each `asks/<pid>` the helper makes.
 */
const dirs: string[] = [];
const timers: NodeJS.Timeout[] = [];
afterEach(() => {
    for (const timer of timers.splice(0)) clearInterval(timer);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'ghs_helper_token';

function rig() {
    const dir = mkdtempSync(join(tmpdir(), 'gate-github-'));
    dirs.push(dir);
    const run = join(dir, 'run');
    const bin = join(dir, 'bin');
    const real = join(dir, 'real');
    for (const path of [join(run, 'asks'), join(run, 'answers'), bin, real]) mkdirSync(path, { recursive: true });
    writeFileSync(join(bin, 'gh'), gateGithubScript);
    chmodSync(join(bin, 'gh'), 0o700);
    const asked: string[] = [];
    /** Plays the supervisor: answers each ask with `reply(n)`, written the way the supervisor writes it. */
    const supervisor = (reply: (n: string) => string | null) => {
        timers.push(
            setInterval(() => {
                for (const n of readdirSync(join(run, 'asks'))) {
                    if (n.startsWith('.') || asked.includes(n)) continue;
                    asked.push(n);
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
    return { dir, run, bin, real, asked, supervisor, fakeGh };
}

interface Ran {
    status: number | null;
    stdout: string;
    stderr: string;
    ms: number;
}
const exec = (shell: string, args: string[], env: Record<string, string>, stdin = ''): Promise<Ran> =>
    new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(shell, args, { env: { ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }));
        child.stdin.end(stdin);
    });

const GITHUB = 'protocol=https\nhost=github.com\n\n';
const SHELLS = ['/bin/sh', ...(existsSync('/bin/dash') ? ['/bin/dash'] : [])];

describe.each(SHELLS)('the gate GitHub helper under %s', (shell) => {
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
            const ran = await shim(r, []);
            expect(ran.stdout).toBe('the real gh\n');
            expect(r.asked).toHaveLength(1);
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

describe('the gate GitHub helper’s script', () => {
    it('parses as POSIX sh and uses no bashism', () => {
        expect(spawnSync('sh', ['-n'], { input: gateGithubScript }).status).toBe(0);
        for (const bashism of ['[[', 'function ', 'local ', "$'", 'source ', '==', '<<<', 'declare ', '${!']) {
            expect(gateGithubScript, bashism).not.toContain(bashism);
        }
    });

    it('runs its own tools by absolute path, so the gate command’s PATH can never reach them', () => {
        const code = gateGithubScript
            .split('\n')
            .filter((line) => !/^\s*#/.test(line))
            .join('\n');
        for (const tool of ['mv', 'cat', 'rm', 'sleep', 'mkdir', 'date']) {
            expect(code, tool).not.toMatch(new RegExp(`(^|[\\s;|&(])${tool}\\s`, 'm'));
        }
        expect(existsSync(join(tmpdir()))).toBe(true);
        expect(readFileSync(new URL('../src/scripts/gate-github.sh', import.meta.url), 'utf8')).toBe(gateGithubScript);
    });
});
