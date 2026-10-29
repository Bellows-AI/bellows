import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { CREDENTIAL_CACHE_DIR, envFileBody, gateEnvBody, TOOL_UID } from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import { dockerArgs } from '../src/docker/docker.js';
import { runnerJobSpec } from '../src/k8s/k8s-podspec.js';
import { AGENT_CONTAINER } from '../src/supervisor-contract.js';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * The runner's credential broker client (docs/connections.md), shared by the GitHub front end and
 * the library export a connection helper (BEL-61) calls: the per-attempt, per-key memory cache, one
 * wall-clock deadline over every retry, the typed stops, and the revoking `clear`. Driven in process
 * with a fake clock and a fake board; the process-level channel pins live in github-credential.test.ts.
 */

const BROKER = join(ROOT, 'docker/claude-executor/credential-broker.cjs');
const FRONT_END = join(ROOT, 'docker/claude-executor/github-credential.cjs');

interface Pair {
    jobId: string;
    leaseToken: string;
}
interface Deps {
    env: Record<string, string | undefined>;
    dir: string;
    now: () => number;
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    signal: (ms: number) => AbortSignal;
    stderr: (line: string) => void;
    deadlineMs?: number;
    pair: (env: Record<string, string | undefined>) => Promise<Pair>;
}
type Result = {
    ok: boolean;
    token?: string;
    expiresAt?: string | null;
    scopes?: string[];
    resource?: unknown;
    reason?: string;
    outcome?: unknown;
};
const require_ = createRequire(import.meta.url);
const broker = require_(BROKER) as {
    obtain: (deps: Deps, key: string) => Promise<Result>;
    connectionCredential: (id: string, deps: Deps) => Promise<Result>;
    clear: (deps: Deps) => Promise<number>;
    erase: (deps: Deps, key: string) => void;
    exitCodeOf: (result: Result) => number;
    GITHUB_KEY: string;
    connectionKey: (id: string) => string;
    CACHE_DIR: string;
    RENEW_SKEW_MS: number;
    DEADLINE_MS: number;
    REQUEST_TIMEOUT_MS: number;
    NULL_EXPIRY_CAP_MS: number;
    REVOKE_DEADLINE_MS: number;
    EXIT_INTEGRATION_REQUIRED: number;
};
const frontEnd = require_(FRONT_END) as {
    main: (
        argv: string[],
        deps: Deps & { stdin: () => Promise<string>; stdout: (text: string) => void }
    ) => Promise<number>;
};

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const START = Date.parse('2026-10-29T12:00:00.000Z');
const JOB = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const PAIR_ENV = { FACTORY_STATS_URL: 'http://board.test/', RUNNER_JOB_ID: JOB, RUNNER_LEASE_TOKEN: LEASE };
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const PERMISSION_BITS = 0o777;

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'credential-broker-'));
    dirs.push(dir);
    return dir;
};

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | Error | 'hang';
interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
    timeoutMs: number;
}

/** A fake board and a clock the test moves; every sleep advances it, a hung request advances it by its timeout. */
function rig(answer: (call: Call, n: number) => Answer, env: Record<string, string | undefined> = PAIR_ENV) {
    const relayed: { lease: string | null } = { lease: null };
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const stderr: string[] = [];
    let now = START;
    let timeoutMs = 0;
    const deps: Deps = {
        env,
        dir: join(scratch(), 'factory-credentials'),
        now: () => now,
        signal: (ms) => {
            timeoutMs = ms;
            return new AbortController().signal;
        },
        fetch: (async (url: string, init: RequestInit) => {
            const call: Call = {
                url,
                method: init.method ?? 'GET',
                headers: init.headers as Record<string, string>,
                body: init.body as string | undefined,
                timeoutMs,
            };
            calls.push(call);
            const next = answer(call, calls.length);
            if (next === 'hang') {
                now += call.timeoutMs;
                throw new Error('The operation was aborted due to timeout');
            }
            if (next instanceof Error) throw next;
            return new Response(JSON.stringify(next.body ?? {}), {
                status: next.status,
                ...(next.headers ? { headers: next.headers } : {}),
            });
        }) as unknown as typeof fetch,
        sleep: async (ms) => {
            sleeps.push(ms);
            now += ms;
        },
        stderr: (line) => stderr.push(line),
        pair: async (from) => ({
            jobId: from.RUNNER_JOB_ID ?? '',
            leaseToken: relayed.lease ?? from.RUNNER_LEASE_TOKEN ?? '',
        }),
    };
    return { deps, calls, sleeps, stderr, relayed, advance: (ms: number) => (now += ms), elapsed: () => now - START };
}

const minted = (token: string, lifetimeMs: number | null = HOUR_MS, from = START): Answer => ({
    status: 200,
    body: { token, expiresAt: lifetimeMs === null ? null : new Date(from + lifetimeMs).toISOString() },
});
const connectionAnswer = (token: string): Answer => ({
    status: 200,
    body: {
        token,
        expiresAt: new Date(START + HOUR_MS).toISOString(),
        scopes: ['read:jira-work'],
        resource: { site: 'example' },
        refreshable: true,
        revocable: true,
    },
});
const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

describe('the cache: per attempt and per key, memory-backed files', () => {
    it('writes one 0600 entry per key in a 0700 directory, and serves each only to its own key', async () => {
        const r = rig((call) =>
            call.url.endsWith('/credentials/github') ? minted('ghs_github_secret') : connectionAnswer('jira_secret')
        );
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ ok: true, token: 'ghs_github_secret' });
        expect(await broker.connectionCredential(CONNECTION, r.deps)).toMatchObject({ ok: true, token: 'jira_secret' });
        expect(statSync(r.deps.dir).mode & PERMISSION_BITS).toBe(DIR_MODE);
        const files = entries(r.deps.dir);
        expect(files).toHaveLength(2);
        for (const file of files) expect(statSync(join(r.deps.dir, file)).mode & PERMISSION_BITS).toBe(FILE_MODE);
        // Both are now cached: neither key is served from the other's entry, and neither asks again.
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ token: 'ghs_github_secret' });
        expect(await broker.connectionCredential(CONNECTION, r.deps)).toMatchObject({ token: 'jira_secret' });
        expect(r.calls.map((call) => call.url)).toEqual([
            `http://board.test/api/jobs/${JOB}/credentials/github`,
            `http://board.test/api/jobs/${JOB}/credentials/connections/${CONNECTION}`,
        ]);
    });

    it('never reads an entry another pair wrote, and drops one a rotated lease replaced', async () => {
        const mine = rig(() => minted('ghs_mine_secret'));
        const theirs = rig(() => minted('ghs_theirs_secret'), { ...PAIR_ENV, RUNNER_LEASE_TOKEN: 'other-lease' });
        theirs.deps.dir = mine.deps.dir;
        await broker.obtain(theirs.deps, broker.GITHUB_KEY);
        expect(await broker.obtain(mine.deps, broker.GITHUB_KEY)).toMatchObject({ token: 'ghs_mine_secret' });
        expect(mine.calls).toHaveLength(1);
    });

    it('names the key and attempt in the entry, never in the file name', async () => {
        const r = rig(() => minted('ghs_named_secret'));
        await broker.obtain(r.deps, broker.GITHUB_KEY);
        const [file] = entries(r.deps.dir);
        expect(file).toMatch(/^[0-9a-f]{64}\.json$/);
        expect(file).not.toContain(JOB);
    });
});

describe('expiry and renewal', () => {
    it('renews at expiresAt minus the skew, never earlier and never later', async () => {
        const r = rig((_call, n) =>
            n === 1 ? minted('ghs_a_secret') : minted('ghs_b_secret', HOUR_MS, START + HOUR_MS)
        );
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ token: 'ghs_a_secret' });
        r.advance(HOUR_MS - broker.RENEW_SKEW_MS - 1);
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ token: 'ghs_a_secret' });
        expect(r.calls).toHaveLength(1);
        r.advance(2);
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ token: 'ghs_b_secret' });
        expect(r.calls).toHaveLength(2);
    });

    it('caches a token without an expiry for at most the cap', async () => {
        const r = rig((_call, n) => (n === 1 ? minted('ghs_open_secret', null) : minted('ghs_next_secret')));
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({
            token: 'ghs_open_secret',
            expiresAt: null,
        });
        r.advance(broker.NULL_EXPIRY_CAP_MS - broker.RENEW_SKEW_MS - 1);
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ token: 'ghs_open_secret' });
        r.advance(2);
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ token: 'ghs_next_secret' });
        expect(broker.NULL_EXPIRY_CAP_MS).toBeLessThanOrEqual(10 * MINUTE_MS);
    });

    it('erase drops the GitHub entry so the next ask renews, and leaves other keys alone', async () => {
        const r = rig((call, n) =>
            call.url.endsWith('/github') ? minted(`ghs_${n}_secret`) : connectionAnswer('jira_secret')
        );
        await broker.obtain(r.deps, broker.GITHUB_KEY);
        await broker.connectionCredential(CONNECTION, r.deps);
        broker.erase(r.deps, broker.GITHUB_KEY);
        expect(entries(r.deps.dir)).toHaveLength(1);
        expect(await broker.connectionCredential(CONNECTION, r.deps)).toMatchObject({ token: 'jira_secret' });
        expect(r.calls).toHaveLength(2);
    });
});

describe('one wall-clock deadline', () => {
    it('ends an outage that never answers at the deadline, bounded by time and not by a count', async () => {
        const r = rig(() => 'hang');
        const result = await broker.obtain(r.deps, broker.GITHUB_KEY);
        expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
        expect(r.elapsed()).toBeLessThanOrEqual(broker.DEADLINE_MS);
        for (const call of r.calls) expect(call.timeoutMs).toBeLessThanOrEqual(broker.REQUEST_TIMEOUT_MS);
    });

    it('keeps asking while the deadline allows, more than the old three tries', async () => {
        const r = rig(() => new Error('connect ECONNREFUSED'));
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ ok: false, reason: 'unreachable' });
        expect(r.calls.length).toBeGreaterThan(3);
        expect(r.elapsed()).toBeLessThanOrEqual(broker.DEADLINE_MS);
    });

    it('takes the budget a helper passes, never a fresh one (BEL-61)', async () => {
        const r = rig(() => 'hang');
        const budget = 4000;
        expect(await broker.connectionCredential(CONNECTION, { ...r.deps, deadlineMs: budget })).toMatchObject({
            ok: false,
            reason: 'unreachable',
        });
        expect(r.elapsed()).toBeLessThanOrEqual(budget);
    });

    it('caps each request at what is left of the deadline', async () => {
        const r = rig(() => 'hang');
        await broker.obtain(r.deps, broker.GITHUB_KEY);
        let spent = 0;
        for (const call of r.calls) {
            expect(call.timeoutMs).toBeLessThanOrEqual(broker.DEADLINE_MS - spent);
            spent += call.timeoutMs;
            // The fake clock moved by the timeout, then by any backoff the helper slept.
        }
        const last = r.calls.at(-1)!;
        expect(last.timeoutMs).toBeGreaterThan(0);
    });

    it('rides out a board error and a malformed answer, then answers the token the retry brings', async () => {
        const answers: Answer[] = [
            { status: 503 },
            { status: 200, body: 'not json' },
            { status: 200, body: {} },
            minted('ghs_retried_secret'),
        ];
        const r = rig((_call, n) => answers[n - 1]!);
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ ok: true, token: 'ghs_retried_secret' });
        expect(r.calls).toHaveLength(4);
    });

    it('treats a 200 with a malformed expiry as no answer, never as no credential', async () => {
        const answers: Answer[] = [
            { status: 200, body: { token: 'ghs_x_secret', expiresAt: 42 } },
            minted('ghs_good_secret'),
        ];
        const r = rig((_call, n) => answers[n - 1]!);
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ token: 'ghs_good_secret' });
    });

    it('waits out a Retry-After that fits the deadline', async () => {
        const answers: Answer[] = [{ status: 429, headers: { 'retry-after': '3' } }, minted('ghs_waited_secret')];
        const r = rig((_call, n) => answers[n - 1]!);
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ token: 'ghs_waited_secret' });
        expect(r.sleeps).toContain(3 * SECOND_MS);
    });

    it('gives up at once on a Retry-After beyond the deadline: rate_limited, no sleep past it', async () => {
        const r = rig(() => ({ status: 429, headers: { 'retry-after': '120' } }));
        const result = await broker.obtain(r.deps, broker.GITHUB_KEY);
        expect(result).toMatchObject({ ok: false, reason: 'rate_limited' });
        expect(r.calls).toHaveLength(1);
        expect(r.sleeps).toEqual([]);
        expect(r.elapsed()).toBe(0);
    });
});

describe('typed stops', () => {
    it('answers 409 INTEGRATION_REQUIRED with its outcome: no retry, no cache, exit code 3', async () => {
        const outcome = { kind: 'integration_required', reason: 'missing', provider: 'jira' };
        const r = rig(() => ({ status: 409, body: { code: 'INTEGRATION_REQUIRED', outcome } }));
        const result = await broker.connectionCredential(CONNECTION, r.deps);
        expect(result).toMatchObject({ ok: false, reason: 'integration_required', outcome });
        expect(r.calls).toHaveLength(1);
        expect(entries(r.deps.dir)).toEqual([]);
        expect(broker.exitCodeOf(result)).toBe(broker.EXIT_INTEGRATION_REQUIRED);
        expect(broker.EXIT_INTEGRATION_REQUIRED).toBe(3);
        expect(broker.exitCodeOf({ ok: false, reason: 'refused' })).toBe(1);
        expect(broker.exitCodeOf({ ok: true, token: 'x' })).toBe(0);
    });

    it.each([401, 403])('stops at a %s and never retries it', async (status) => {
        const r = rig(() => ({ status, body: { error: 'refused' } }));
        expect(await broker.connectionCredential(CONNECTION, r.deps)).toMatchObject({ ok: false, reason: 'refused' });
        expect(r.calls).toHaveLength(1);
        expect(entries(r.deps.dir)).toEqual([]);
    });

    it('stops at a GitHub 409 as no App, and names no connection outcome', async () => {
        const r = rig(() => ({ status: 409, body: { code: 'GITHUB_UNAVAILABLE' } }));
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ ok: false, reason: 'no_app' });
        expect(r.calls).toHaveLength(1);
    });

    it('refuses a connection id that is not a plain id, without asking the board', async () => {
        const r = rig(() => connectionAnswer('jira_secret'));
        expect(await broker.connectionCredential('../github', r.deps)).toMatchObject({
            ok: false,
            reason: 'bad_request',
        });
        expect(r.calls).toEqual([]);
    });

    it('says why there is no credential in a container without the attempt pair, asking nothing', async () => {
        const r = rig(() => minted('ghs_unused_secret'), {});
        expect(await broker.obtain(r.deps, broker.GITHUB_KEY)).toMatchObject({ ok: false, reason: 'no_pair' });
        expect(r.calls).toEqual([]);
    });

    it('returns the connection answer typed: token, expiry, scopes and resource', async () => {
        const r = rig(() => connectionAnswer('jira_secret'));
        expect(await broker.connectionCredential(CONNECTION, r.deps)).toEqual({
            ok: true,
            token: 'jira_secret',
            expiresAt: new Date(START + HOUR_MS).toISOString(),
            scopes: ['read:jira-work'],
            resource: { site: 'example' },
        });
        expect(r.calls[0]).toMatchObject({
            method: 'POST',
            headers: { 'x-factory-job-id': JOB, 'x-factory-job-lease-token': LEASE },
        });
    });
});

describe('clear revokes the cached GitHub token, then removes every entry', () => {
    const revokes = (r: ReturnType<typeof rig>) =>
        r.calls.filter((call) => call.url.endsWith('/credentials/github/revoke'));
    const answerAll = (call: Call): Answer =>
        call.url.endsWith('/revoke')
            ? { status: 204 }
            : call.url.endsWith('/github')
              ? minted('ghs_cached_secret')
              : connectionAnswer('jira_secret');

    it('makes exactly one revoke call with that token and the pair, then every entry is gone', async () => {
        const r = rig(answerAll);
        await broker.obtain(r.deps, broker.GITHUB_KEY);
        await broker.connectionCredential(CONNECTION, r.deps);
        expect(await broker.clear(r.deps)).toBe(0);
        const [revoke, ...rest] = revokes(r);
        expect(rest).toEqual([]);
        expect(revoke).toMatchObject({
            url: `http://board.test/api/jobs/${JOB}/credentials/github/revoke`,
            method: 'POST',
            headers: expect.objectContaining({ 'x-factory-job-id': JOB, 'x-factory-job-lease-token': LEASE }),
        });
        expect(JSON.parse(revoke!.body!)).toEqual({ token: 'ghs_cached_secret' });
        expect(entries(r.deps.dir)).toEqual([]);
    });

    it('makes no call when there is no cache', async () => {
        const r = rig(answerAll);
        expect(await broker.clear(r.deps)).toBe(0);
        expect(r.calls).toEqual([]);
    });

    it('makes no call for an unreadable cache, still removes it, and says so on stderr with a non-zero exit', async () => {
        const r = rig(answerAll);
        await broker.obtain(r.deps, broker.GITHUB_KEY);
        r.calls.length = 0;
        const [file] = entries(r.deps.dir);
        writeFileSync(join(r.deps.dir, file!), '{not json');
        expect(await broker.clear(r.deps)).not.toBe(0);
        expect(r.calls).toEqual([]);
        expect(entries(r.deps.dir)).toEqual([]);
        expect(r.stderr.join('\n')).toMatch(/unreadable/);
    });

    it('still clears when the revoke fails or times out, within the revoke cap', async () => {
        for (const failure of [{ status: 502 }, 'hang', new Error('connect ECONNREFUSED')] as Answer[]) {
            const r = rig((call) => (call.url.endsWith('/revoke') ? failure : minted('ghs_cached_secret')));
            await broker.obtain(r.deps, broker.GITHUB_KEY);
            const before = r.elapsed();
            await broker.clear(r.deps);
            expect(entries(r.deps.dir)).toEqual([]);
            expect(revokes(r)).toHaveLength(1);
            expect(revokes(r)[0]!.timeoutMs).toBeLessThanOrEqual(broker.REVOKE_DEADLINE_MS);
            expect(r.elapsed() - before).toBeLessThanOrEqual(broker.REVOKE_DEADLINE_MS);
        }
        expect(broker.REVOKE_DEADLINE_MS).toBeLessThanOrEqual(3 * SECOND_MS);
    });

    it('presents the lease the supervisor names now, and skips the call where the pair is gone', async () => {
        const r = rig(answerAll);
        await broker.obtain(r.deps, broker.GITHUB_KEY);
        r.relayed.lease = 'lease-after-takeover';
        await broker.clear(r.deps);
        expect(revokes(r)[0]!.headers['x-factory-job-lease-token']).toBe('lease-after-takeover');
        const bare = rig(answerAll, {});
        bare.deps.dir = r.deps.dir;
        await broker.obtain(r.deps, broker.GITHUB_KEY);
        await broker.clear(bare.deps);
        expect(bare.calls).toEqual([]);
        expect(entries(r.deps.dir)).toEqual([]);
    });
});

describe('no token on stdout or stderr, in any mode', () => {
    const SECRETS = ['ghs_leak_secret', 'jira_leak_secret'];
    const front = (r: ReturnType<typeof rig>) => {
        const stdout: string[] = [];
        return {
            deps: {
                ...r.deps,
                stdin: async () => 'protocol=https\nhost=github.com\n\n',
                stdout: (t: string) => stdout.push(t),
            },
            stdout,
        };
    };

    it('keeps tokens off stderr for refusals, outages, rate limits and a revoke, and stdout carries only what git and gh read', async () => {
        const modes: string[][] = [['git', 'get'], ['git', 'erase'], ['git', 'store'], ['token'], ['clear']];
        const boards: ((call: Call) => Answer)[] = [
            () => ({ status: 403, body: { token: SECRETS[0] } }),
            () => ({ status: 409, body: { token: SECRETS[0], code: 'GITHUB_UNAVAILABLE' } }),
            () => ({ status: 429, headers: { 'retry-after': '999' }, body: { token: SECRETS[0] } }),
            () => 'hang',
            (call) =>
                call.url.endsWith('/revoke') ? { status: 502, body: { token: SECRETS[0] } } : minted(SECRETS[0]!),
        ];
        for (const answer of boards) {
            for (const mode of modes) {
                const r = rig(answer);
                const f = front(r);
                await frontEnd.main(mode, f.deps);
                for (const secret of SECRETS) {
                    expect(r.stderr.join('\n'), `${mode.join(' ')} stderr`).not.toContain(secret);
                    if (mode[0] === 'clear' || mode[1] === 'erase' || mode[1] === 'store') {
                        expect(f.stdout.join(''), `${mode.join(' ')} stdout`).not.toContain(secret);
                    }
                }
            }
        }
    });

    it('offers no connection mode on the command line: the usage lists git, token and clear only', async () => {
        const r = rig(() => connectionAnswer(SECRETS[1]!));
        const f = front(r);
        expect(await frontEnd.main(['connection', CONNECTION], f.deps)).toBe(2);
        expect(await frontEnd.main(['connections', CONNECTION], f.deps)).toBe(2);
        expect(r.calls).toEqual([]);
        expect(f.stdout).toEqual([]);
        expect(r.stderr.join('\n')).toContain('usage: github-credential.cjs git <get|store|erase> | token | clear');
        expect(r.stderr.join('\n')).not.toMatch(/connection/i);
    });

    it('exports connectionCredential from the library and prints nothing from it', async () => {
        const run = promisify(execFile);
        const script = `const b = require(${JSON.stringify(BROKER)}); process.stdout.write(typeof b.connectionCredential + typeof b.obtain)`;
        const out = await run(process.execPath, ['-e', script]);
        expect(out.stdout).toBe('functionfunction');
        // Required as a module it runs nothing: the broker has no command line of its own.
        expect(readFileSync(BROKER, 'utf8')).not.toContain('require.main');
    });
});

describe('F1: the credential mount and the attempt pair are the agent container’s alone', () => {
    const USER = '44444444-4444-4444-8444-444444444444';
    const job = {
        id: JOB,
        command: 'push the fix',
        rootCommand: 'push the fix',
        attempts: 1,
        maxAttempts: 1,
        lastAttempt: false,
        claimSeq: 1,
        leaseToken: LEASE,
        leaseExpiresAt: '2026-10-29T12:05:00.000Z',
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
        repo: 'Bellows-AI/factory',
        env: { MEMBER_VAR: 'member' },
    } as BoardJob;
    const SESSION = { id: '55555555-5555-4555-8555-555555555555', resume: false };

    it('is the one path the image helper writes', () => {
        expect(CREDENTIAL_CACHE_DIR).toBe('/run/factory-credentials');
        expect(CREDENTIAL_CACHE_DIR).toBe(broker.CACHE_DIR);
    });

    it('docker: the agent mounts the memory tmpfs and carries the pair; aux env files carry neither', () => {
        const config = loadDriverConfig({});
        const args = dockerArgs(config, job, SESSION, { envFile: '/tmp/agent.env' });
        const at = args.indexOf('--tmpfs');
        expect(args[at + 1]).toBe(`${CREDENTIAL_CACHE_DIR}:rw,noexec,nosuid,size=1m,mode=0700,uid=${TOOL_UID}`);
        expect(args.filter((arg) => arg === '--tmpfs')).toHaveLength(1);
        expect(envFileBody(job, config)).toMatch(/^RUNNER_JOB_ID=/m);
        for (const aux of [envFileBody(job), gateEnvBody(job, 'ghs_gate_secret')]) {
            expect(aux).not.toMatch(/^RUNNER_(JOB_ID|LEASE_TOKEN)=/m);
        }
    });

    it('kubernetes: the Memory emptyDir is mounted in the agent container alone, and only it names the pair', () => {
        const spec = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), job, SESSION).spec.template.spec;
        expect(spec.volumes).toContainEqual({
            name: 'credential-cache',
            emptyDir: { medium: 'Memory', sizeLimit: '1Mi' },
        });
        const mounting = spec.containers
            .filter((c) => c.volumeMounts.some((m) => m.mountPath === CREDENTIAL_CACHE_DIR))
            .map((c) => c.name);
        expect(mounting).toEqual([AGENT_CONTAINER]);
        const naming = spec.containers
            .filter((c) => JSON.stringify(c.env ?? []).includes('RUNNER_JOB_ID'))
            .map((c) => c.name);
        expect(naming).toEqual([AGENT_CONTAINER]);
    });
});
