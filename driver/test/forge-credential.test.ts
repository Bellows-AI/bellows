import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import {
    envFileBody,
    CREDENTIAL_CACHE_DIR,
    FORGE_HOSTS_ENV,
    forgeHostsOf,
    RESERVED_ENV_NAMES,
    runnerClaimEnv,
    TOOL_UID,
} from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import { dockerArgs } from '../src/docker/docker.js';
import { runnerJobSpec } from '../src/k8s/k8s-podspec.js';
import { AGENT_CONTAINER } from '../src/supervisor-contract.js';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';
import { githubRef } from './fixtures/repo-ref.js';

/**
 * The runner's forge helper (docs/connections.md), shipped in both executor images: what it asks
 * the board for github.com and for a task's GitLab host, when it renews, how often it retries, where
 * it caches and what it says. Driven in process with a fake clock and a fake board, and once as a
 * real process to pin the channels: the token on stdout only, guidance on stderr only.
 */

const HELPER = join(ROOT, 'docker/executor-common/forge-credential.cjs');
interface Deps {
    env: Record<string, string | undefined>;
    dir: string;
    now: () => number;
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    signal: (ms: number) => AbortSignal;
    stdin: () => Promise<string>;
    stdout: (text: string) => void;
    stderr: (line: string) => void;
    pair: (env: Record<string, string | undefined>) => Promise<{ jobId: string; leaseToken: string }>;
}
const helper = createRequire(import.meta.url)(HELPER) as {
    main: (argv: string[], deps: Deps) => Promise<number>;
    obtain: (deps: Deps, host?: string) => Promise<string | null>;
    configuredHosts: (env: Record<string, string | undefined>) => string[];
    RENEW_SKEW_MS: number;
    CACHE_DIR: string;
};
const broker = createRequire(import.meta.url)(join(ROOT, 'docker/executor-common/credential-broker.cjs')) as {
    DEADLINE_MS: number;
    CACHE_DIR: string;
    EXIT_WAITING: number;
    EXIT_INTEGRATION_REQUIRED: number;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const START = Date.parse('2026-10-16T12:00:00.000Z');
const JOB = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const PAIR_ENV = { FACTORY_STATS_URL: 'http://board.test/', RUNNER_JOB_ID: JOB, RUNNER_LEASE_TOKEN: LEASE };
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const PERMISSION_BITS = 0o777;

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-credential-'));
    dirs.push(dir);
    return dir;
};

type Answer = { status: number; body?: unknown } | Error;

/** A fake board answering each ask in turn (the last answer repeats), and a clock the test moves. */
function rig(answers: Answer[], env: Record<string, string | undefined> = PAIR_ENV) {
    // The lease the supervisor names now; null while it names none, so the env's pair stands (`attempt-pair.cjs`).
    const relayed: { lease: string | null } = { lease: null };
    const asks: { url: string; headers: Record<string, string> }[] = [];
    const sleeps: number[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    let now = START;
    const deps: Deps = {
        env,
        dir: join(scratch(), 'factory-credentials'),
        now: () => now,
        fetch: (async (url: string, init: RequestInit) => {
            asks.push({ url, headers: init.headers as Record<string, string> });
            const answer = answers[Math.min(asks.length - 1, answers.length - 1)]!;
            if (answer instanceof Error) throw answer;
            return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
        }) as unknown as typeof fetch,
        sleep: async (ms) => {
            sleeps.push(ms);
            now += ms;
        },
        signal: () => new AbortController().signal,
        stdin: async () => 'protocol=https\nhost=github.com\n\n',
        stdout: (text) => stdout.push(text),
        stderr: (line) => stderr.push(line),
        pair: async (from) => ({
            jobId: from.RUNNER_JOB_ID ?? '',
            leaseToken: relayed.lease ?? from.RUNNER_LEASE_TOKEN ?? '',
        }),
    };
    return { deps, asks, sleeps, stdout, stderr, relayed, advance: (ms: number) => (now += ms) };
}

const minted = (token: string, lifetimeMs = HOUR_MS, from = START) => ({
    status: 200,
    body: { token, expiresAt: new Date(from + lifetimeMs).toISOString() },
});

describe('the runner forge helper for github.com', () => {
    it('asks the board with the attempt pair and answers git on stdout', async () => {
        const r = rig([minted('ghs_first_secret')]);
        expect(await helper.main(['git', 'get'], r.deps)).toBe(0);
        expect(r.asks).toEqual([
            {
                url: `http://board.test/api/jobs/${JOB}/credentials/github`,
                headers: { 'x-factory-job-id': JOB, 'x-factory-job-lease-token': LEASE },
            },
        ]);
        expect(r.stdout.join('')).toBe('username=x-access-token\npassword=ghs_first_secret\n');
        expect(r.stderr).toEqual([]);
    });

    it('serves the cache until the renewal skew, then renews before the token expires', async () => {
        const r = rig([minted('ghs_a_secret'), minted('ghs_b_secret', HOUR_MS, START + HOUR_MS)]);
        expect(await helper.obtain(r.deps)).toBe('ghs_a_secret');
        r.advance(HOUR_MS - helper.RENEW_SKEW_MS - 1);
        expect(await helper.obtain(r.deps)).toBe('ghs_a_secret');
        expect(r.asks).toHaveLength(1);
        // Inside the skew the cached token still has minutes left, and is renewed anyway.
        r.advance(2);
        expect(await helper.obtain(r.deps)).toBe('ghs_b_secret');
        expect(r.asks).toHaveLength(2);
    });

    it('keeps the cache 0600 in a 0700 directory, and clears it on exit', async () => {
        const r = rig([minted('ghs_cached_secret')]);
        await helper.obtain(r.deps);
        const [name] = readdirSync(r.deps.dir);
        const file = join(r.deps.dir, name!);
        expect(statSync(file).mode & PERMISSION_BITS).toBe(FILE_MODE);
        expect(statSync(r.deps.dir).mode & PERMISSION_BITS).toBe(DIR_MODE);
        expect(await helper.main(['clear'], r.deps)).toBe(0);
        expect(existsSync(file)).toBe(false);
        expect(readdirSync(r.deps.dir)).toEqual([]);
    });

    it('drops the cache when git reports the credential rejected, so the next ask renews', async () => {
        const r = rig([minted('ghs_old_secret'), minted('ghs_new_secret')]);
        await helper.obtain(r.deps);
        expect(await helper.main(['git', 'erase'], r.deps)).toBe(0);
        expect(await helper.obtain(r.deps)).toBe('ghs_new_secret');
    });

    describe('an erase whose outcome cannot be confirmed', () => {
        type Fs = typeof import('node:fs');
        const nodeFs = () => createRequire(import.meta.url)('node:fs') as Fs;
        const fault = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
        const SECRET_ERASE = 'could not be confirmed cleared';
        afterEach(() => vi.restoreAllMocks());

        it.each(['EIO', 'EACCES'])('is not a quiet success when the cache cannot be listed (%s)', async (code) => {
            const r = rig([minted('ghs_old_secret')]);
            await helper.obtain(r.deps);
            const real = nodeFs().readdirSync;
            vi.spyOn(nodeFs(), 'readdirSync').mockImplementation(((dir: unknown, ...rest: unknown[]) => {
                if (dir === r.deps.dir) throw fault(code);
                return (real as (...args: unknown[]) => unknown)(dir, ...rest);
            }) as never);
            expect(await helper.main(['git', 'erase'], r.deps)).toBe(1);
            expect(r.stderr.join('\n')).toContain(SECRET_ERASE);
        });

        it('is not a quiet success when an entry cannot be read or cannot be removed', async () => {
            const r = rig([minted('ghs_old_secret')]);
            await helper.obtain(r.deps);
            const fs = nodeFs();
            const read = fs.readFileSync;
            const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
                if (typeof file === 'string' && file.startsWith(r.deps.dir)) throw fault('EIO');
                return (read as (...args: unknown[]) => unknown)(file, ...rest);
            }) as never);
            expect(await helper.main(['git', 'erase'], r.deps)).toBe(1);
            spy.mockRestore();
            const rm = fs.rmSync;
            vi.spyOn(fs, 'rmSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
                if (typeof file === 'string' && file.startsWith(r.deps.dir)) throw fault('EACCES');
                return (rm as (...args: unknown[]) => unknown)(file, ...rest);
            }) as never);
            expect(await helper.main(['git', 'erase'], r.deps)).toBe(1);
        });

        it('is a success for an absent cache, and for one it dropped', async () => {
            const r = rig([minted('ghs_old_secret')]);
            expect(await helper.main(['git', 'erase'], r.deps)).toBe(0);
            await helper.obtain(r.deps);
            expect(await helper.main(['git', 'erase'], r.deps)).toBe(0);
            expect(r.stderr).toEqual([]);
        });
    });

    it('presents the lease the supervisor relays, not the one the container started with (#1045)', async () => {
        const r = rig([minted('ghs_adopted_secret')]);
        r.relayed.lease = 'lease-after-takeover';
        expect(await helper.obtain(r.deps)).toBe('ghs_adopted_secret');
        expect(r.asks.map((ask) => ask.headers)).toEqual([
            { 'x-factory-job-id': JOB, 'x-factory-job-lease-token': 'lease-after-takeover' },
        ]);
    });

    it('never serves a token minted under the lease an adoption has since replaced (#1045)', async () => {
        const r = rig([minted('ghs_before_secret'), minted('ghs_after_secret')]);
        expect(await helper.obtain(r.deps)).toBe('ghs_before_secret');
        r.relayed.lease = 'lease-after-takeover';
        expect(await helper.obtain(r.deps)).toBe('ghs_after_secret');
        expect(r.asks).toHaveLength(2);
        expect(await helper.obtain(r.deps)).toBe('ghs_after_secret');
        expect(r.asks).toHaveLength(2);
    });

    it('never reads a cache another attempt wrote', async () => {
        const r = rig([minted('ghs_mine_secret')]);
        const other = rig([minted('ghs_theirs_secret')], { ...PAIR_ENV, RUNNER_LEASE_TOKEN: 'other' });
        other.deps.dir = r.deps.dir;
        await helper.obtain(other.deps);
        expect(await helper.obtain(r.deps)).toBe('ghs_mine_secret');
        expect(r.asks).toHaveLength(1);
    });

    it('retries an unreachable board backing off until the wall-clock deadline, then says so', async () => {
        const r = rig([new Error('connect ECONNREFUSED')]);
        expect(await helper.main(['token'], r.deps)).toBe(1);
        expect(r.asks.length).toBeGreaterThan(3);
        expect(r.sleeps.slice(0, 3)).toEqual([500, 1000, 2000]);
        expect(r.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(broker.DEADLINE_MS);
        expect(r.stderr.join('\n')).toContain('did not issue a credential before its deadline');
        expect(r.stdout).toEqual([]);
    });

    it('rides out a board error and answers the token the retry brings', async () => {
        const r = rig([{ status: 503 }, minted('ghs_retried_secret')]);
        expect(await helper.obtain(r.deps)).toBe('ghs_retried_secret');
        expect(r.asks).toHaveLength(2);
    });

    it.each([401, 403])('stops at a %s with reconnect guidance, and never retries it', async (status) => {
        const r = rig([{ status, body: { error: 'refused', code: 'UNAUTHENTICATED' } }]);
        expect(await helper.main(['git', 'get'], r.deps)).toBe(1);
        expect(r.asks).toHaveLength(1);
        expect(r.stderr.join('\n')).toContain('the board refused this attempt a credential');
        expect(r.stdout).toEqual([]);
    });

    it('says the organization holds no App when the board answers 409', async () => {
        const r = rig([{ status: 409, body: { code: 'GITHUB_UNAVAILABLE' } }]);
        expect(await helper.main(['token'], r.deps)).toBe(1);
        expect(r.stderr.join('\n')).toContain('no GitHub App installation');
    });

    it('answers no host but github.com over https, and asks nothing for one', async () => {
        const r = rig([minted('ghs_unused_secret')]);
        r.deps.stdin = async () => 'protocol=https\nhost=example.com\n\n';
        expect(await helper.main(['git', 'get'], r.deps)).toBe(0);
        expect(r.stdout).toEqual([]);
        expect(r.asks).toEqual([]);
    });

    it('says why there is no token in a container without the attempt pair', async () => {
        const r = rig([minted('ghs_unused_secret')], {});
        expect(await helper.main(['token'], r.deps)).toBe(1);
        expect(r.stderr.join('\n')).toContain('no attempt credential');
        expect(r.asks).toEqual([]);
    });
});

describe('the runner forge helper for a task’s GitLab host', () => {
    const HOST = 'gitlab.example.com';
    const GITLAB_ENV = { ...PAIR_ENV, RUNNER_FORGE_HOSTS: 'GitLab.Example.com' };
    const asking =
        (host: string, protocol = 'https') =>
        async () =>
            `protocol=${protocol}\nhost=${host}\n\n`;
    const served = (token: string, lifetimeMs = HOUR_MS, from = START) => ({
        status: 200,
        body: {
            forge: `gitlab:${HOST}`,
            standing: 'live',
            token,
            expiresAt: new Date(from + lifetimeMs).toISOString(),
        },
    });

    it('answers github.com always, plus each valid host RUNNER_FORGE_HOSTS names, normalized', () => {
        expect(helper.configuredHosts({})).toEqual(['github.com']);
        expect(
            helper.configuredHosts({
                RUNNER_FORGE_HOSTS: ' GitLab.Example.com:443 , bad host,,a/b,gitlab.example.com,code.example.org:8443',
            })
        ).toEqual(['github.com', HOST, 'code.example.org:8443']);
    });

    it('asks the GitLab route with the pair and answers git as oauth2', async () => {
        const r = rig([served('glpat_first_secret')], GITLAB_ENV);
        r.deps.stdin = asking(HOST);
        expect(await helper.main(['git', 'get'], r.deps)).toBe(0);
        expect(r.asks).toEqual([
            {
                url: `http://board.test/api/jobs/${JOB}/credentials/gitlab`,
                headers: { 'x-factory-job-id': JOB, 'x-factory-job-lease-token': LEASE },
            },
        ]);
        expect(r.stdout.join('')).toBe('username=oauth2\npassword=glpat_first_secret\n');
        expect(r.stderr).toEqual([]);
    });

    it('serves the cache until the renewal skew, then asks again', async () => {
        const r = rig([served('glpat_a_secret'), served('glpat_b_secret', HOUR_MS, START + HOUR_MS)], GITLAB_ENV);
        expect(await helper.obtain(r.deps, HOST)).toBe('glpat_a_secret');
        r.advance(HOUR_MS - helper.RENEW_SKEW_MS - 1);
        expect(await helper.obtain(r.deps, `${HOST.toUpperCase()}:443`)).toBe('glpat_a_secret');
        expect(r.asks).toHaveLength(1);
        r.advance(2);
        expect(await helper.obtain(r.deps, HOST)).toBe('glpat_b_secret');
        expect(r.asks).toHaveLength(2);
    });

    it('prints the token alone for `token <host>`, and github.com’s for a bare `token`', async () => {
        const r = rig([served('glpat_token_secret'), minted('ghs_token_secret')], GITLAB_ENV);
        expect(await helper.main(['token', HOST], r.deps)).toBe(0);
        expect(await helper.main(['token'], r.deps)).toBe(0);
        expect(r.stdout).toEqual(['glpat_token_secret\n', 'ghs_token_secret\n']);
        expect(r.asks.map((ask) => ask.url.split('/').at(-1))).toEqual(['gitlab', 'github']);
    });

    it.each([
        ['a host the task names no GitLab repo on', 'gitlab.other.example', 'https', PAIR_ENV],
        ['a configured host over http', HOST, 'http', GITLAB_ENV],
        ['a GitLab host with no RUNNER_FORGE_HOSTS', HOST, 'https', PAIR_ENV],
    ])('declines %s silently, sending no pair', async (_name, host, protocol, env) => {
        const r = rig([served('glpat_unused_secret')], env);
        r.deps.stdin = asking(host, protocol);
        expect(await helper.main(['git', 'get'], r.deps)).toBe(0);
        expect(r.stdout).toEqual([]);
        expect(r.stderr).toEqual([]);
        expect(r.asks).toEqual([]);
    });

    it('asks nothing for `token` on an unconfigured host, and exits non-zero', async () => {
        const r = rig([served('glpat_unused_secret')], PAIR_ENV);
        expect(await helper.main(['token', HOST], r.deps)).not.toBe(0);
        expect(r.stdout).toEqual([]);
        expect(r.asks).toEqual([]);
    });

    it('keeps the github.com and GitLab tokens apart, and erases only the host git names', async () => {
        const r = rig([served('glpat_one_secret'), minted('ghs_one_secret'), served('glpat_two_secret')], GITLAB_ENV);
        expect(await helper.obtain(r.deps, HOST)).toBe('glpat_one_secret');
        expect(await helper.obtain(r.deps)).toBe('ghs_one_secret');
        expect(readdirSync(r.deps.dir)).toHaveLength(2);
        r.deps.stdin = asking(HOST);
        expect(await helper.main(['git', 'erase'], r.deps)).toBe(0);
        expect(readdirSync(r.deps.dir)).toHaveLength(1);
        expect(await helper.obtain(r.deps)).toBe('ghs_one_secret');
        expect(r.asks).toHaveLength(2);
        expect(await helper.obtain(r.deps, HOST)).toBe('glpat_two_secret');
        expect(r.asks).toHaveLength(3);
    });

    it.each([
        ['an unconfigured host', 'protocol=https\nhost=gitlab.other.example\n\n'],
        ['no host', 'protocol=https\n\n'],
        ['another protocol', `protocol=http\nhost=${HOST}\n\n`],
    ])('erases nothing for %s', async (_name, input) => {
        const r = rig([served('glpat_kept_secret'), minted('ghs_kept_secret')], GITLAB_ENV);
        await helper.obtain(r.deps, HOST);
        await helper.obtain(r.deps);
        r.deps.stdin = async () => input;
        expect(await helper.main(['git', 'erase'], r.deps)).toBe(0);
        expect(readdirSync(r.deps.dir)).toHaveLength(2);
    });

    it('stops at 409 FORGE_GRANT_REQUIRED: the task waits for the member to link GitLab again, exit non-zero', async () => {
        const connectUrl = 'https://board.test/connect/gitlab';
        const r = rig(
            [{ status: 409, body: { code: 'FORGE_GRANT_REQUIRED', standing: 'broken', waiting: true, connectUrl } }],
            GITLAB_ENV
        );
        r.deps.stdin = asking(HOST);
        expect(await helper.main(['git', 'get'], r.deps)).toBe(broker.EXIT_WAITING);
        expect(r.asks).toHaveLength(1);
        expect(r.stdout).toEqual([]);
        const said = r.stderr.join('\n');
        expect(said).toContain('links their GitLab account again');
        expect(said).not.toContain('GitHub App');
        expect(await helper.main(['token', HOST], r.deps)).toBe(broker.EXIT_WAITING);
    });

    it.each([401, 403])('stops at a GitLab %s as refused, never retried', async (status) => {
        const r = rig([{ status, body: { code: 'CONNECTION_NOT_AUTHORIZED' } }], GITLAB_ENV);
        r.deps.stdin = asking(HOST);
        expect(await helper.main(['git', 'get'], r.deps)).toBe(1);
        expect(r.asks).toHaveLength(1);
        expect(r.stderr.join('\n')).toContain('the board refused this attempt a credential');
    });

    it('clears a GitLab entry without asking the board: the member’s grant is shared', async () => {
        const r = rig([served('glpat_cleared_secret')], GITLAB_ENV);
        await helper.obtain(r.deps, HOST);
        expect(await helper.main(['clear'], r.deps)).toBe(0);
        expect(r.asks).toHaveLength(1);
        expect(readdirSync(r.deps.dir)).toEqual([]);
    });

    it('lists the configured hosts for the entrypoint’s git config, one per line', async () => {
        const r = rig([], { RUNNER_FORGE_HOSTS: `${HOST},not a host` });
        expect(await helper.main(['hosts'], r.deps)).toBe(0);
        expect(r.stdout.join('')).toBe(`github.com\n${HOST}\n`);
    });
});

/** A board on a loopback port answering each credential ask in turn. */
async function board(answers: { status: number; body: unknown }[]): Promise<{ url: string; server: Server }> {
    let call = 0;
    const server = createServer((request: IncomingMessage, response) => {
        const answer = answers[Math.min(call, answers.length - 1)]!;
        call += 1;
        request.resume();
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const run = promisify(execFile);

describe('the runner forge helper as a process', () => {
    const servers: Server[] = [];
    afterEach(async () => {
        for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
    });

    // A real process caches at the image's constant path, which exists inside a runner: a fresh job id per run keeps
    // one case's entry from answering the next, and every rerun.
    const spawnHelper = (args: string[], url: string) =>
        run(process.execPath, [HELPER, ...args], {
            env: {
                PATH: process.env.PATH,
                FACTORY_STATS_URL: url,
                RUNNER_JOB_ID: randomUUID(),
                RUNNER_LEASE_TOKEN: LEASE,
            },
        }).then(
            (out) => ({ code: 0, ...out }),
            (error: { code: number; stdout: string; stderr: string }) => error
        );

    it('prints the token on stdout and nothing on stderr', async () => {
        const fake = await board([
            {
                status: 200,
                body: { token: 'ghs_process_secret', expiresAt: new Date(Date.now() + HOUR_MS).toISOString() },
            },
        ]);
        servers.push(fake.server);
        const out = await spawnHelper(['token'], fake.url);
        expect(out.code).toBe(0);
        expect(out.stdout).toBe('ghs_process_secret\n');
        expect(out.stderr).toBe('');
    });

    it('presents the lease a relay socket serves, not the one in its env (#1045)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'forge-credential-relay-'));
        const socket = join(dir, 'control.sock');
        const relay = createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ leaseToken: 'lease-relayed' }));
        });
        await new Promise<void>((resolve) => relay.listen(socket, resolve));
        servers.push(relay);
        const seen: string[] = [];
        const fake = await board([{ status: 200, body: { token: 'ghs_relay_secret', expiresAt: null } }]);
        fake.server.on('request', (request: IncomingMessage) => {
            seen.push(String(request.headers['x-factory-job-lease-token']));
        });
        servers.push(fake.server);
        try {
            const out = await run(process.execPath, [HELPER, 'token'], {
                env: {
                    PATH: process.env.PATH,
                    FACTORY_STATS_URL: fake.url,
                    FACTORY_CONTROL_SOCKET: socket,
                    RUNNER_JOB_ID: randomUUID(),
                    RUNNER_LEASE_TOKEN: LEASE,
                },
            });
            expect(out.stdout).toBe('ghs_relay_secret\n');
            expect(seen).toEqual(['lease-relayed']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('prints guidance on stderr, no token anywhere, and exits non-zero on a refusal', async () => {
        const fake = await board([
            { status: 403, body: { error: 'refused', code: 'CONNECTION_NOT_AUTHORIZED', token: 'ghs_never_secret' } },
        ]);
        servers.push(fake.server);
        const out = await spawnHelper(['token'], fake.url);
        expect(out.code).not.toBe(0);
        expect(out.stdout).toBe('');
        expect(out.stderr).toContain('A later turn may succeed');
        expect(out.stderr).not.toContain('Do not retry');
        expect(out.stderr).not.toContain('ghs_never_secret');
    });
});

describe('the gh wrapper and the helper in both images', () => {
    it('leaves no copy of the GitHub-only helper behind', () => {
        expect(existsSync(join(ROOT, 'docker/executor-common/github-credential.cjs'))).toBe(false);
    });

    const IMAGES = ['docker/claude-executor', 'docker/opencode-executor'];
    const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

    it('ships one shared copy of the helper and the wrapper', () => {
        for (const file of ['forge-credential.cjs', 'credential-broker.cjs', 'gh-wrapper.sh']) {
            expect(read(`docker/executor-common/${file}`), file).toBeTruthy();
            for (const dir of IMAGES) expect(existsSync(join(ROOT, dir, file)), `${dir}/${file}`).toBe(false);
        }
    });

    it.each(IMAGES)('%s installs the real gh in libexec and the wrapper as /usr/local/bin/gh', (dir) => {
        const dockerfile = read(`${dir}/Dockerfile`);
        expect(dockerfile).toMatch(/mv "[^"]*\/bin\/gh" \/usr\/local\/libexec\/gh/);
        expect(dockerfile).toMatch(/^COPY --from=common gh-wrapper\.sh \/usr\/local\/bin\/gh$/m);
        expect(dockerfile).toMatch(
            /^COPY --from=common forge-credential\.cjs \/usr\/local\/bin\/forge-credential\.cjs$/m
        );
        expect(dockerfile).toMatch(
            /^COPY --from=common credential-broker\.cjs \/usr\/local\/bin\/credential-broker\.cjs$/m
        );
        expect(dockerfile).toMatch(/chmod 0755 [^\n]*\/usr\/local\/bin\/credential-broker\.cjs/);
        expect(dockerfile).toMatch(/chmod 0755 \/usr\/local\/bin\/gh \/usr\/local\/bin\/forge-credential\.cjs /);
        expect(dockerfile).not.toContain('github-credential');
    });

    it('hands gh the helper token only when no token is already set', async () => {
        const wrapper = read('docker/executor-common/gh-wrapper.sh');
        expect(wrapper).toMatch(/^if \[ -z "\$\{GH_TOKEN:-\}" \] && \[ -z "\$\{GITHUB_TOKEN:-\}" \]; then$/m);
        expect(wrapper).toContain('GH_TOKEN="$(node /usr/local/bin/forge-credential.cjs token)"');
        expect(wrapper.trimEnd().split('\n').at(-1)).toBe('exec /usr/local/libexec/gh "$@"');
        // POSIX sh: the images ship dash.
        await expect(run('sh', ['-n', join(ROOT, 'docker/executor-common/gh-wrapper.sh')])).resolves.toBeDefined();
    });

    describe('the agent never opens or edits the task’s pull request with gh', () => {
        const WRAPPER = join(ROOT, 'docker/executor-common/gh-wrapper.sh');
        const REFUSAL =
            'the board opens and edits this task’s pull request as the member who started it: ask it with `factory-control publish`; do not run gh pr create or gh pr edit';
        /** The wrapper on the host with an empty environment: a refusal exits before any absolute path or token ask. */
        const wrapped = (args: string[], env: Record<string, string> = {}) =>
            run('sh', [WRAPPER, ...args], { env }).then(
                (out) => ({ code: 0, ...out }),
                (error: { code: number; stdout: string; stderr: string }) => error
            );

        it.each([
            ['pr', 'create', '--title', 't'],
            ['pr', 'new', '--title', 't'],
            ['pr', 'edit', '3', '--title', 't'],
        ])('refuses gh %s %s with exit 2 and the board publish as the way', async (...args) => {
            const out = await wrapped(args);
            expect(out.code).toBe(2);
            expect(out.stdout).toBe('');
            expect(out.stderr.trim()).toBe(REFUSAL);
        });

        // The guard fails closed: `pr` followed anywhere later by create, new or edit is refused, whatever the flags
        // between them are and whether they take a value, so no flag grammar is known to it.
        it.each([
            ['--repo', 'o/r', 'pr', 'create'],
            ['-R', 'o/r', 'pr', 'new', '--title', 't'],
            ['--repo=o/r', 'pr', 'edit', '3'],
            ['-Ro/r', 'pr', 'create'],
            ['pr', '--repo', 'o/r', 'edit', '3'],
            ['pr', '-R', 'o/r', 'create'],
            ['pr', '--repo=o/r', 'new'],
            ['--repo', 'o/r', 'pr', '--repo', 'o/r', 'create'],
            ['--title', 't', 'pr', 'create'],
            ['pr', '--body', 'b', 'new'],
            ['pr', '--title', 't', 'edit', '3'],
            ['--some-unknown-flag', 'value', 'pr', '--other', 'x', 'create'],
            // The accepted false refusal: a value that is exactly the word is indistinguishable from the command.
            ['pr', 'comment', '1', '--body', 'edit'],
        ])('refuses gh %s however the flags are placed', async (...args) => {
            const out = await wrapped(args);
            expect(out.code).toBe(2);
            expect(out.stderr.trim()).toBe(REFUSAL);
        });

        it.each([
            ['pr', 'view', '3'],
            ['--repo', 'o/r', 'pr', 'list'],
            ['pr', '--repo', 'o/r', 'view', '1'],
            ['-R', 'o/r', 'issue', 'create', '--title', 'pr'],
            ['issue', 'create'],
            ['api', 'repos/o/r/issues'],
        ])('still reaches the real gh for gh %s', async (...args) => {
            const out = await wrapped(args, { GH_TOKEN: 'ghs_x' });
            expect(out.code).not.toBe(2);
            expect(out.stderr).not.toContain('factory-control publish');
        });

        it('refuses even when a token is already set: the block is not about credentials', async () => {
            const out = await wrapped(['pr', 'create'], { GH_TOKEN: 'ghs_x' });
            expect(out.code).toBe(2);
            expect(out.stderr).not.toContain('/usr/local/libexec/gh');
        });

        it.each([
            ['pr', 'view', '1'],
            ['pr', 'comment', '1', '--body', 'x'],
        ])('still reaches the real gh for gh %s %s', async (...args) => {
            const out = await wrapped(args, { GH_TOKEN: 'ghs_x' });
            // Whatever the real gh answers on this host, it is not the wrapper's refusal.
            expect(out.code).not.toBe(2);
            expect(out.stderr).not.toContain('factory-control publish');
        });

        it('has no trailing whitespace on any line', () => {
            for (const line of read('docker/executor-common/gh-wrapper.sh').split('\n')) {
                expect(line).toBe(line.trimEnd());
            }
        });
    });

    it('needs no write to anything but the cache directory it is given', () => {
        // The cache path is a constant, never an env name a member could point at a shared volume.
        const source = read('docker/executor-common/credential-broker.cjs');
        expect(source).toContain("const CACHE_DIR = '/run/factory-credentials';");
        expect(source).not.toMatch(/process\.env\.[A-Z_]*DIR/);
    });
});

describe('the token cache and the runner env, on both executors', () => {
    const USER = '44444444-4444-4444-8444-444444444444';
    const MEMBER_TOKEN = 'ghp_member_value_never_forwarded';
    const runnerJob = {
        id: JOB,
        command: 'push the fix',
        rootCommand: 'push the fix',
        attempts: 1,
        maxAttempts: 1,
        lastAttempt: false,
        claimSeq: 1,
        leaseToken: LEASE,
        ingestToken: '33333333-3333-4333-8333-333333333333',
        leaseExpiresAt: '2026-10-16T12:05:00.000Z',
        executorType: 'claude-code',
        executorRefusal: null,
        planRefusal: null,
        skillRefusal: null,
        masterPrompt:
            'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone',
        resumeSessionId: null,
        followUp: false,
        ownSession: false,
        continuesInterrupted: false,
        userId: USER,
        workspacePath: `bellows/${USER}`,
        repo: githubRef('Bellows-AI/bellows'),
        // A board that still sent one: both names are reserved, so neither may reach a runner.
        env: { GITHUB_TOKEN: MEMBER_TOKEN, GH_TOKEN: MEMBER_TOKEN, MEMBER_VAR: 'member' },
    } as BoardJob;
    const SESSION = { id: '33333333-3333-4333-8333-333333333333', resume: false };

    it("caches where the image's helper writes", () => {
        expect(CREDENTIAL_CACHE_DIR).toBe(helper.CACHE_DIR);
        expect(CREDENTIAL_CACHE_DIR).toBe(broker.CACHE_DIR);
    });

    it('docker mounts a 0700 memory tmpfs over the cache in the agent container', () => {
        const args = dockerArgs(loadDriverConfig({}), runnerJob, SESSION, { envFile: '/tmp/agent.env' });
        const at = args.indexOf('--tmpfs');
        // The tool uid's: git and gh run as it.
        expect(args[at + 1]).toBe(`${CREDENTIAL_CACHE_DIR}:rw,noexec,nosuid,size=1m,mode=0700,uid=${TOOL_UID}`);
        expect(args.join(' ')).not.toContain(MEMBER_TOKEN);
        expect(envFileBody(runnerJob, loadDriverConfig({}))).not.toMatch(/^(GITHUB_TOKEN|GH_TOKEN)=/m);
    });

    it('kubernetes mounts a Memory emptyDir over the cache in the agent container alone', () => {
        const spec = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), runnerJob, SESSION).spec.template.spec;
        expect(spec.volumes).toContainEqual({
            name: 'credential-cache',
            emptyDir: { medium: 'Memory', sizeLimit: '1Mi' },
        });
        const mounting = spec.containers
            .filter((c) => c.volumeMounts.some((m) => m.mountPath === CREDENTIAL_CACHE_DIR))
            .map((c) => c.name);
        expect(mounting).toEqual([AGENT_CONTAINER]);
        // No GitHub value rides the pod spec or the Secret's claim half.
        expect(JSON.stringify(spec)).not.toContain(MEMBER_TOKEN);
        expect(runnerClaimEnv(runnerJob)).toEqual({ MEMBER_VAR: 'member' });
    });

    describe('RUNNER_FORGE_HOSTS: the GitLab host the agent’s helper answers', () => {
        const gitlabJob = {
            ...runnerJob,
            repo: { forge: 'gitlab', host: 'GitLab.Example.com', path: 'group/sub/project' },
            env: { MEMBER_VAR: 'member', [FORGE_HOSTS_ENV]: 'evil.example' },
        } as BoardJob;
        const agentEnvOf = (job: BoardJob) =>
            runnerJobSpec(
                loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                job,
                SESSION
            ).spec.template.spec.containers.find((c) => c.name === AGENT_CONTAINER)!.env;

        it('names the host of a GitLab repo, lowercased, and nothing for a GitHub one', () => {
            expect(FORGE_HOSTS_ENV).toBe('RUNNER_FORGE_HOSTS');
            expect(forgeHostsOf(gitlabJob)).toEqual(['gitlab.example.com']);
            expect(forgeHostsOf(runnerJob)).toEqual([]);
            expect(forgeHostsOf({ ...runnerJob, repo: null } as BoardJob)).toEqual([]);
        });

        it('docker sets it on the agent for a GitLab task, and not for a GitHub one', () => {
            const args = dockerArgs(loadDriverConfig({}), gitlabJob, SESSION, { envFile: '/tmp/agent.env' });
            expect(args).toContain(`${FORGE_HOSTS_ENV}=gitlab.example.com`);
            expect(args.join(' ')).not.toContain('evil.example');
            const github = dockerArgs(loadDriverConfig({}), runnerJob, SESSION, { envFile: '/tmp/agent.env' });
            expect(github.join(' ')).not.toContain(FORGE_HOSTS_ENV);
        });

        it('kubernetes sets it on the agent container for a GitLab task, and not for a GitHub one', () => {
            expect(agentEnvOf(gitlabJob)).toContainEqual({ name: FORGE_HOSTS_ENV, value: 'gitlab.example.com' });
            expect(JSON.stringify(agentEnvOf(runnerJob))).not.toContain(FORGE_HOSTS_ENV);
        });

        it('is the driver’s alone: a claim value is dropped, and RUNNER_ENV may not forward it', () => {
            expect(RESERVED_ENV_NAMES).toContain(FORGE_HOSTS_ENV);
            expect(runnerClaimEnv(gitlabJob)).toEqual({ MEMBER_VAR: 'member' });
            expect(envFileBody(gitlabJob, loadDriverConfig({}))).not.toContain('evil.example');
            expect(() => loadDriverConfig({ RUNNER_ENV: FORGE_HOSTS_ENV })).toThrow(
                /RUNNER_ENV must not name RUNNER_FORGE_HOSTS/
            );
        });
    });
});

describe('the stated limit of a gate environment’s token', () => {
    it('is in docs/connections.md: no GitHub token in a gate env, an ask through the mailbox that is never an empty token', () => {
        const docs = readFileSync(join(ROOT, 'docs/connections.md'), 'utf8').replace(/\s+/g, ' ');
        expect(docs).toContain(
            'A gate gets no `GITHUB_TOKEN`/`GH_TOKEN` in its env: git and gh get a token through the gate helper, and a gate script reading `$GITHUB_TOKEN` itself gets nothing.'
        );
        expect(docs).toContain(
            'A gate asks through its mailbox, answered only while its step runs under the live lease; an unanswered ask is no verdict, never an empty token.'
        );
    });
});
