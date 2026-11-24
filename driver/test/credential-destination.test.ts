import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import type { Runner } from '../src/runner.js';
import type { StepRequest, StepResult } from '../src/supervisor-contract.js';
import type { StepSink } from '../src/step-control.js';
import { fakePullRequests } from './fixtures/fake-pull-requests.js';
import { dockerRunner, job as dockerJob, labelDaemon } from './fixtures/docker-suite.js';
import { GIT_FIXTURE_CONFIG, hasGit, makeOrigin, SCRIPT_IDENTITY } from './fixtures/git-worktree-support.js';
import { fakeRequest, job as k8sJob, runner as k8sRunner, SESSION } from './fixtures/k8s-suite.js';
import { githubRef } from './fixtures/repo-ref.js';
import { hasOpenssl } from './fixtures/scripts-support.js';

/** Runs a command to its end without blocking this loop, which also serves the foreign host the command may reach. */
function runToEnd(
    file: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv; input?: string }
): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.input ?? '');
    });
}

/**
 * Amendment A1 through both executors: the credential goes only to the host the claim names (github.com).
 * The real driver modules run — each executor's runner, the supervised steps, the shipped checkout script,
 * the shipped credential helper, real git — and only the outermost boundary is faked: the supervisor
 * channel answers each submitted step by running it on this host, with `/task` mapped to a temp directory,
 * and the "foreign host" is a loopback https server that records every request it receives. A destination
 * the claim does not name must receive no Authorization header, whichever git operation reached it.
 */
const TOKEN = 'ghs_foreign_probe_token';
/** Each case starts real node and git processes; a loaded gate container needs more than the 30s default. */
const SPAWN_TIMEOUT_MS = 120_000;
const SESSION_OF = { id: SESSION, resume: false };
const FETCH_REFUSAL = /claim host/;

/** A supervisor channel that runs each step for real under `root`, answering as the supervisor would. */
function localSteps(root: string, foreign: { env: Record<string, string> }) {
    const submitted: StepRequest[] = [];
    const onHost = (text: string): string => (text.startsWith('/task/') ? join(root, text) : text);
    const run = async (step: StepRequest): Promise<StepResult> => {
        const [file, ...args] = step.argv;
        const ran = await runToEnd(file!, args, {
            cwd: step.cwd ? onHost(step.cwd) : root,
            env: {
                ...process.env,
                ...SCRIPT_IDENTITY,
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_TERMINAL_PROMPT: '0',
                // The loopback certificate is self-signed: the suite is about the credential, not the chain.
                GIT_SSL_NO_VERIFY: '1',
                ...Object.fromEntries(Object.entries(step.env).map(([name, value]) => [name, onHost(value)])),
                ...foreign.env,
            },
        });
        return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr, timedOut: false };
    };
    const sink: StepSink = {
        submit: async (_token, step) => {
            submitted.push(step);
            return run(step);
        },
        awaitReport: () => new Promise(() => undefined),
        agentEnded: () => undefined,
        contacted: () => true,
        release: () => undefined,
        attach: () => undefined,
        cancel: () => undefined,
    };
    return { sink, submitted };
}

interface Executor {
    name: string;
    job: BoardJob;
    runner: (steps: StepSink) => Runner;
}

const EXECUTORS: Executor[] = [
    {
        name: 'docker',
        job: dockerJob,
        runner: (steps) => dockerRunner(labelDaemon().exec, { steps }),
    },
    {
        name: 'kubernetes',
        job: k8sJob,
        runner: (steps) => k8sRunner(fakeRequest().request, {}, undefined, steps),
    },
];

describe.skipIf(!hasGit() || !hasOpenssl())(
    'the credential goes only to the claim host, through both executors',
    { timeout: SPAWN_TIMEOUT_MS },
    () => {
        let dir: string;
        let server: Server;
        let foreignUrl: string;
        let received: { url: string; authorization: string | undefined }[];

        beforeEach(async () => {
            dir = mkdtempSync(join(tmpdir(), 'cred-dest-'));
            received = [];
            const key = join(dir, 'key.pem');
            const cert = join(dir, 'cert.pem');
            execFileSync(
                'openssl',
                [
                    'req',
                    '-x509',
                    '-newkey',
                    'rsa:2048',
                    '-keyout',
                    key,
                    '-out',
                    cert,
                    '-days',
                    '2',
                    '-nodes',
                    '-subj',
                    '/CN=127.0.0.1',
                ],
                { stdio: 'ignore' }
            );
            // The 401-everything remote: the first unauthenticated request is what sends git looking for a credential.
            server = createHttpsServer(
                { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') },
                (req, res) => {
                    received.push({ url: req.url ?? '', authorization: req.headers.authorization });
                    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="foreign"' });
                    res.end('no');
                }
            );
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            foreignUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}/o/n.git`;
        });

        afterEach(async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        });

        const noCredentialReceived = () => {
            expect(received.filter((request) => request.authorization !== undefined)).toEqual([]);
        };

        /** The retained checkout `/task/bellows` of a thread, cloned from a local bare repository. */
        const retainedCheckout = (): string => {
            mkdirSync(join(dir, 'task'), { recursive: true });
            const { bare } = makeOrigin(dir, 'retained');
            const tree = join(dir, 'task', 'bellows');
            execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', '-q', `file://${bare}`, tree], { stdio: 'ignore' });
            return tree;
        };
        const gitIn = (tree: string, ...args: string[]) =>
            execFileSync('git', [...GIT_FIXTURE_CONFIG, '-C', tree, ...args], { encoding: 'utf8' }).trim();

        describe.each(EXECUTORS)('$name', ({ job: base, runner: runnerOf }) => {
            const claim: BoardJob = {
                ...base,
                command: '/fix https://github.com/Bellows-AI/bellows/issues/10',
                repo: githubRef('Bellows-AI/bellows'),
                env: {},
            };
            const start = (env: Record<string, string> = {}) => {
                const steps = localSteps(dir, { env });
                return { ...steps, runner: runnerOf(steps.sink) };
            };

            it.each(['origin', 'push URL'])(
                'fetch: refuses a retained checkout whose %s names another host, and sends no credential',
                async (which) => {
                    const tree = retainedCheckout();
                    const own = 'https://github.com/Bellows-AI/bellows.git';
                    gitIn(tree, 'remote', 'set-url', 'origin', which === 'origin' ? foreignUrl : own);
                    if (which === 'push URL') gitIn(tree, 'remote', 'set-url', '--push', 'origin', foreignUrl);
                    const { runner, submitted } = start();

                    const result = await runner.syncCheckout(claim, undefined, SESSION_OF, TOKEN);

                    expect(result.ok).toBe(false);
                    expect(result.reason).toMatch(FETCH_REFUSAL);
                    // The shipped helper rode the step, so the refusal is the checkout's, not an absent credential.
                    expect(submitted.find((step) => step.kind === 'sync')?.env).toHaveProperty('CRED_HELPER');
                    expect(received).toEqual([]);
                }
            );

            // The destination spellings git hands the helper unchanged: the guard (`new URL`) and the helper must agree.
            const SPELLINGS: [string, boolean][] = [
                ['github.com', true],
                ['GitHub.com', true],
                ['github.com:443', true],
                ['GITHUB.COM:443', true],
                ['github.com:8443', false],
            ];

            it.each(SPELLINGS)(
                'credential helper: the executor-shipped helper answers host %s: %s',
                async (host, answered) => {
                    const { runner, submitted } = start();
                    retainedCheckout();
                    await runner.syncCheckout(claim, undefined, SESSION_OF, TOKEN);
                    const helper = submitted.find((step) => step.kind === 'sync')?.env.CRED_HELPER;
                    expect(helper).toBeDefined();

                    const filled = await runToEnd('git', ['-c', `credential.helper=${helper}`, 'credential', 'fill'], {
                        env: {
                            ...process.env,
                            GIT_CONFIG_GLOBAL: '/dev/null',
                            GIT_CONFIG_NOSYSTEM: '1',
                            GIT_TERMINAL_PROMPT: '0',
                            GITHUB_TOKEN: TOKEN,
                        },
                        input: `protocol=https\nhost=${host}\n\n`,
                    });

                    expect(filled.stdout.includes(`password=${TOKEN}`)).toBe(answered);
                }
            );

            /** A `git` first on PATH that refuses to touch the network: it records the fetch it was asked for. */
            const shimmed = () => {
                const shim = join(dir, 'shim');
                mkdirSync(shim, { recursive: true });
                const log = join(dir, 'shim.log');
                const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
                writeFileSync(
                    join(shim, 'git'),
                    `#!/bin/sh\nfor a in "$@"; do case $a in fetch|clone|ls-remote) echo "$*" >> '${log}'; echo 'fatal: shimmed' >&2; exit 128;; esac; done\nexec '${real}' "$@"\n`,
                    { mode: 0o755 }
                );
                return { env: { PATH: `${shim}:${process.env.PATH ?? ''}` }, log };
            };

            it.each(SPELLINGS)(
                'fetch: a retained origin spelled %s is the claim host: %s, so the credentialed fetch runs or is refused',
                async (host, isClaimHost) => {
                    const tree = retainedCheckout();
                    gitIn(tree, 'remote', 'set-url', 'origin', `https://${host}/Bellows-AI/bellows.git`);
                    const shim = shimmed();
                    const { runner } = start(shim.env);

                    const result = await runner.syncCheckout(claim, undefined, SESSION_OF, TOKEN);

                    if (isClaimHost) {
                        expect(result.reason ?? '').not.toMatch(FETCH_REFUSAL);
                        // The guard let it through: the fetch ran under the credential helper (against the shim).
                        expect(readFileSync(shim.log, 'utf8')).toContain('credential.helper=');
                    } else {
                        expect(result.ok).toBe(false);
                        expect(result.reason).toMatch(FETCH_REFUSAL);
                    }
                }
            );

            it('lazy fetch: a promisor remote pointed at another host gets no credential from the helper the executor ships', async () => {
                retainedCheckout();
                const { runner, submitted } = start();
                await runner.syncCheckout(claim, undefined, SESSION_OF, TOKEN);
                const helper = submitted.find((step) => step.kind === 'sync')?.env.CRED_HELPER;
                expect(helper).toBeDefined();
                // A partial clone whose blob is missing, then its promisor remote moves to the foreign host.
                const { bare } = makeOrigin(dir, 'promisor');
                execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowFilter', 'true']);
                execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
                const partial = join(dir, 'partial');
                execFileSync(
                    'git',
                    [
                        ...GIT_FIXTURE_CONFIG,
                        'clone',
                        '-q',
                        '--filter=blob:none',
                        '--no-checkout',
                        `file://${bare}`,
                        partial,
                    ],
                    {
                        stdio: 'ignore',
                    }
                );
                gitIn(partial, 'remote', 'set-url', 'origin', foreignUrl);
                const read = await runToEnd(
                    'git',
                    ['-C', partial, '-c', `credential.helper=${helper}`, 'cat-file', '-p', 'HEAD:README.md'],
                    {
                        env: {
                            ...process.env,
                            GIT_CONFIG_GLOBAL: '/dev/null',
                            GIT_CONFIG_NOSYSTEM: '1',
                            GIT_TERMINAL_PROMPT: '0',
                            GIT_SSL_NO_VERIFY: '1',
                            GITHUB_TOKEN: TOKEN,
                        },
                    }
                );
                expect(read.status).not.toBe(0);
                expect(received.length).toBeGreaterThan(0);
                noCredentialReceived();
            });

            it('push and reconciliation: a checkout redirected to another host mid-run fails the publish and sends no credential', async () => {
                const tree = retainedCheckout();
                const { runner, submitted } = start();
                // The checkout is synced from its own origin; the destination changes while the agent works.
                gitIn(tree, 'remote', 'set-url', 'origin', foreignUrl);
                writeFileSync(join(tree, 'WORK.md'), 'work\n');

                const result = await runner.publishGit(claim, TOKEN, { pullRequests: fakePullRequests().port });

                expect(result.ok).toBe(false);
                expect(result.published).toBe(false);
                expect(result.reason).toBeTruthy();
                expect(JSON.stringify(result)).not.toContain(TOKEN);
                // The push ran under the helper, so the foreign server was reached and answered 401, once the
                // helper had been asked and answered nothing; and the reconciliation read ran after the failed push.
                expect(submitted.some((step) => step.argv.includes('push'))).toBe(true);
                expect(submitted.some((step) => step.argv.includes('ls-remote'))).toBe(true);
                expect(received.length).toBeGreaterThan(0);
                noCredentialReceived();
            });
        });
    }
);
