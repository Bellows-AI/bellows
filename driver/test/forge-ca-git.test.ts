import { execFile, execFileSync, type ExecFileOptions } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { gateForgeScript, gateShellScript } from '../src/container-scripts.js';
import { GATE_FORGE_CA_ENV, gateForgeCa } from '../src/forge-ca.js';
import { MAILBOX_FILES, MAILBOXES, SUPERVISOR_ENV } from '../src/supervisor-contract.js';
import { boardJob } from './fixtures/board-job.js';
import {
    bareRepo,
    hermeticGitEnv,
    mintPrivateCa,
    type GitHttpsRemote,
    startGitHttpsRemote,
} from './fixtures/private-ca.js';
import { REPO_ROOT } from './fixtures/repo-files.js';
import { liveSupervisors, stopSupervisors, superviseTracked } from './fixtures/supervisor-tracker.js';

/*
 * The forge CA against a REAL git and a self-managed forge behind a private CA (fixtures/private-ca.ts): without the
 * CA every git call fails its TLS verify; with it the gate (gate-shell.sh), a supervised forge step (supervisor.cjs,
 * through the hardened git) and the agent (both executor entrypoints) clone, fetch and push — trusting the CA for the
 * forge's host alone, never by turning verification off, and never printing the chain.
 */
process.env.SUPERVISOR_NO_MAIN = '1';
const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as {
    supervise(env: Record<string, string>, log: (line: string) => void): Promise<number>;
};

const HANG_GUARD_MS = 25_000;
const SPAWN_TIMEOUT_MS = 60_000;
const TLS_FAILURE = /certificate|SSL/i;

let root: string;
let caPem: string;
let remote: GitHttpsRemote;
/** A line of the chain's body: what must never show up in an output, a log or a ledger. */
let pemBody: string;

beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'forge-ca-'));
    const ca = mintPrivateCa(join(root, 'ca'));
    caPem = ca.caPem;
    pemBody = caPem.split('\n')[1] ?? '';
    remote = await startGitHttpsRemote(ca, bareRepo(join(root, 'origin')));
}, SPAWN_TIMEOUT_MS);

afterAll(async () => {
    await remote.close();
    rmSync(root, { recursive: true, force: true });
});

/**
 * A process run to its end, never synchronously: the remote answers from this same event loop.
 */
const run = (file: string, args: string[], options: ExecFileOptions) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) =>
            resolve({ status: error ? ((error as { code?: unknown }).code as number | null) : 0, stdout, stderr })
        );
    });

const scratch = (name: string): string => mkdtempSync(join(root, `${name}-`));
const gitlabJob = (): BoardJob =>
    ({
        ...boardJob(),
        repo: { forge: 'gitlab', host: remote.host, path: 'group/project' },
        forgeCa: caPem,
    }) as BoardJob;

describe('the private-CA remote', { timeout: SPAWN_TIMEOUT_MS }, () => {
    it('is refused by a git that does not trust the CA: its TLS verify fails', async () => {
        const ran = await run('git', ['ls-remote', remote.url], { env: hermeticGitEnv(scratch('plain')) });
        expect(ran.status).not.toBe(0);
        expect(ran.stderr).toMatch(TLS_FAILURE);
    });
});

describe('the gate shell', { timeout: SPAWN_TIMEOUT_MS }, () => {
    const gate = async (command: string, env: Record<string, string>) => {
        const home = scratch('gate');
        return {
            home,
            ran: await run('sh', ['-c', gateShellScript, 'gate', command], {
                cwd: home,
                env: { ...hermeticGitEnv(home), TMPDIR: home, ...env },
            }),
        };
    };

    it('fails its TLS verify without FACTORY_FORGE_CA', async () => {
        const { ran } = await gate(`git ls-remote ${remote.url}`, { FACTORY_FORGE_HOSTS: remote.host });
        expect(ran.status).not.toBe(0);
        expect(ran.stderr).toMatch(TLS_FAILURE);
    });

    it('trusts the CA for the forge host, from a file in its own tmp, and keeps the env’s own GIT_CONFIG pairs', async () => {
        const line = gateForgeCa(gitlabJob()) ?? '';
        const { ran, home } = await gate(
            `git ls-remote ${remote.url} && git clone -q ${remote.url} clone && git config user.name && env`,
            {
                FACTORY_FORGE_HOSTS: remote.host,
                [GATE_FORGE_CA_ENV]: line,
                GIT_CONFIG_COUNT: '1',
                GIT_CONFIG_KEY_0: 'user.name',
                GIT_CONFIG_VALUE_0: 'kept',
            }
        );
        expect(ran.stderr).toBe('');
        expect(ran.status).toBe(0);
        expect(ran.stdout).toContain('refs/heads/main');
        expect(ran.stdout).toContain('kept\n');
        expect(ran.stdout).toContain(`GIT_CONFIG_KEY_1=http.https://${remote.host}/.sslCAInfo`);
        // The chain is not left in the command's env, and git trusts it by file, never by turning verification off.
        expect(ran.stdout).not.toContain(pemBody);
        expect(ran.stdout).not.toMatch(/sslVerify|GIT_SSL_NO_VERIFY/i);
        expect(readFileSync(join(home, 'factory-forge-ca', 'ca.pem'), 'utf8')).toBe(caPem);
    });
});

/** The driver's endpoint: hands out queued steps and records their answers. */
async function startDriver() {
    const answers = new Map<string, (body: string) => void>();
    const answered = new Map<string, Promise<string>>();
    const driver = { url: '', queue: [] as unknown[], bodies: [] as string[], answered };
    const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
        let body = '';
        request.on('data', (chunk: Buffer) => (body += chunk.toString()));
        request.on('end', () => {
            const send = (payload: unknown) => {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify(payload));
            };
            const url = request.url ?? '';
            if (url === '/control') return send({ stop: false, kill: false });
            if (url.startsWith('/step?')) {
                const next = driver.queue.shift();
                return next ? send({ step: next }) : setTimeout(() => send({}), 20);
            }
            if (url.startsWith('/step/')) {
                driver.bodies.push(body);
                answers.get(decodeURIComponent(url.slice('/step/'.length)))?.(body);
                return send({ ok: true });
            }
            return send({});
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    driver.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const answerOf = (id: string): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
        new Promise((resolve, reject) => {
            const guard = setTimeout(() => reject(new Error(`no answer for ${id}`)), HANG_GUARD_MS);
            answers.set(id, (text) => {
                clearTimeout(guard);
                resolve(JSON.parse(text) as { exitCode: number; stdout: string; stderr: string });
            });
        });
    return { driver, answerOf, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe('a supervised forge step', { timeout: SPAWN_TIMEOUT_MS }, () => {
    const closers: (() => Promise<unknown>)[] = [];
    afterEach(async () => {
        await stopSupervisors();
        for (const close of closers.splice(0)) await close();
    });
    afterAll(() => expect(liveSupervisors()).toBe(0));

    async function run(script: string, supervisorEnv: Record<string, string>, stepEnv: Record<string, string> = {}) {
        const { driver, answerOf, close } = await startDriver();
        closers.push(close);
        const volume = scratch('volume');
        const home = scratch('home');
        const logs: string[] = [];
        void superviseTracked(
            supervisor,
            {
                FACTORY_CTL_ROOT: volume,
                SUPERVISOR_TICK_MS: '10',
                SUPERVISOR_CONTROL_MS: '10',
                SUPERVISOR_AGENTLESS: '1',
                SUPERVISOR_CONTROL_URL: driver.url,
                SUPERVISOR_CONTROL_TOKEN: 'control-secret',
                [SUPERVISOR_ENV.forgeHelper]: gateForgeScript,
                ...supervisorEnv,
            },
            (line) => logs.push(line)
        );
        const answer = answerOf('sync-1');
        driver.queue.push({
            id: 'sync-1',
            invocation: 'i-1',
            kind: 'sync',
            argv: ['sh', '-c', script],
            cwd: home,
            env: { ...hermeticGitEnv(home), ...stepEnv },
            timeoutMs: 20_000,
            forgeHost: remote.host,
        });
        const ended = await answer;
        const ledgerDir = join(volume, MAILBOXES.supervisor.path.split('/').pop()!, MAILBOX_FILES.steps);
        const ledger = readdirSync(ledgerDir)
            .map((name) => readFileSync(join(ledgerDir, name), 'utf8'))
            .join('\n');
        return { ended, ledger, logs, bodies: driver.bodies.join('\n') };
    }

    const push = () =>
        [
            `git clone -q ${remote.url} c`,
            'cd c',
            // A checkout that names another CA file for the host is outranked: the supervisor's pair is command scope.
            `git config http.https://${remote.host}/.sslCAInfo /nonexistent.pem`,
            'git checkout -q -b step-branch',
            'git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m step',
            'git push -q origin step-branch',
            'git fetch -q origin',
            'command -v git',
            'git config user.name',
        ].join(' && ');

    it('fails its TLS verify when the supervisor holds no CA', async () => {
        const { ended } = await run(`git ls-remote ${remote.url}`, {});
        expect(ended.exitCode).not.toBe(0);
        expect(ended.stderr).toMatch(TLS_FAILURE);
    });

    it('clones, pushes and fetches through the hardened git, trusting the CA for the step’s host alone', async () => {
        const { ended, ledger, logs, bodies } = await run(
            push(),
            { [SUPERVISOR_ENV.forgeCa]: caPem },
            { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'kept' }
        );
        expect(ended.stderr).toBe('');
        expect(ended.exitCode).toBe(0);
        // The step's git is the supervisor's hardened shim, and the step's own GIT_CONFIG pair still applies.
        expect(ended.stdout).toMatch(/factory-git-[^/]+\/git\n/);
        expect(ended.stdout).toContain('kept\n');
        expect(remote.requests).toContain('POST /group/project.git/git-receive-pack');
        for (const text of [ledger, logs.join('\n'), bodies]) expect(text).not.toContain(pemBody);
    });
});

describe('the agent’s entrypoints', { timeout: SPAWN_TIMEOUT_MS }, () => {
    const IMAGES = ['claude', 'opencode'] as const;
    const FORGE_CREDENTIAL = join(REPO_ROOT, 'docker/executor-common/forge-credential.cjs');
    /** The CA block of an entrypoint: from its directory to the unset, with the image's own name taken out. */
    const block = (image: (typeof IMAGES)[number]) => {
        const text = readFileSync(join(REPO_ROOT, `docker/${image}-executor/entrypoint.sh`), 'utf8');
        const start = text.indexOf('FORGE_CA_DIR=');
        const end = text.indexOf('unset RUNNER_FORGE_CA', start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        return text.slice(start, end + 'unset RUNNER_FORGE_CA'.length).replaceAll(`${image}-executor`, 'IMAGE');
    };

    it('install the CA with the same logic in both images', () => {
        expect(block('claude')).toBe(block('opencode'));
    });

    const entry = async (
        image: (typeof IMAGES)[number],
        env: Record<string, string>,
        after: string,
        home = scratch(`agent-${image}`)
    ) => {
        const dir = join(home, 'forge-ca');
        const script = [
            'set -eu',
            `FORGE_CREDENTIAL='${FORGE_CREDENTIAL}'`,
            block(image).replaceAll('/tmp/.factory-forge-ca', dir),
            after,
        ].join('\n');
        const ran = await run('/bin/sh', ['-c', script], {
            cwd: home,
            env: { ...hermeticGitEnv(home), RUNNER_FORGE_HOSTS: remote.host, ...env },
        });
        return { ran, home, dir };
    };

    it.each(IMAGES)('%s: without RUNNER_FORGE_CA git fails its TLS verify', async (image) => {
        const { ran } = await entry(image, {}, `git ls-remote ${remote.url}`);
        expect(ran.status).not.toBe(0);
        expect(ran.stderr).toMatch(TLS_FAILURE);
    });

    it.each(IMAGES)(
        '%s: writes a 0644 file per forge host, trusts it per host, and unsets the chain',
        async (image) => {
            const { ran, home, dir } = await entry(
                image,
                { RUNNER_FORGE_CA: caPem },
                `git ls-remote ${remote.url} && git clone -q ${remote.url} clone && env`
            );
            expect(ran.stderr).toBe('');
            expect(ran.status).toBe(0);
            expect(ran.stdout).toContain('refs/heads/main');
            expect(ran.stdout).not.toContain('RUNNER_FORGE_CA');
            expect(ran.stdout).not.toContain(pemBody);
            const file = join(dir, `${remote.host}.pem`);
            expect(readFileSync(file, 'utf8')).toBe(caPem);
            expect(statSync(file).mode & 0o777).toBe(0o644);
            expect(readdirSync(dir)).toEqual([`${remote.host}.pem`]);
            const config = execFileSync('git', ['config', '--global', '--list'], {
                env: hermeticGitEnv(home),
                encoding: 'utf8',
            });
            expect(config).toContain(`http.https://${remote.host}/.sslcainfo=${file}`);
            expect(config).not.toMatch(/github\.com|sslverify/i);
        }
    );

    it.each(IMAGES)('%s: refuses a CA directory that is not its own, and still starts', async (image) => {
        const home = scratch(`agent-${image}-link`);
        mkdirSync(join(home, 'elsewhere'));
        writeFileSync(join(home, 'elsewhere', 'keep'), '');
        symlinkSync(join(home, 'elsewhere'), join(home, 'forge-ca'));
        const { ran } = await entry(image, { RUNNER_FORGE_CA: caPem }, 'echo started', home);
        expect(ran.status).toBe(0);
        expect(ran.stdout).toBe('started\n');
        expect(ran.stderr).toMatch(/forge CA/);
        expect(readdirSync(join(home, 'elsewhere'))).toEqual(['keep']);
    });
});
