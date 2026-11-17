import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * The runner's one board-call path (docker/executor-common/board-call.cjs): every helper that presents the
 * attempt pair to a lease-gated board route reaches the board through it. The real module against a fake
 * clock, sleep, pair and fetch; the guard walks every file the runner images ship to agents.
 */
const MODULE = join(ROOT, 'docker/executor-common/board-call.cjs');
const require_ = createRequire(import.meta.url);

type Env = Record<string, string | undefined>;
type Pair = { jobId: string; leaseToken: string };
type Answer = { status: number; headers: Headers; json: unknown };
type Verdict = { done: unknown } | { retry: true; waitMs?: number | null };
interface Budget {
    start: number;
    end: number;
    remaining: () => number;
}
interface Deps {
    env: Env;
    now: () => number;
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    pair: (env: Env, options?: { deadlineMs?: number }) => Promise<Pair>;
    signal?: (ms: number) => AbortSignal;
}
interface Call {
    method: string;
    path: string;
    body?: unknown;
    classify: (answer: Answer) => Verdict;
    once?: boolean;
    requestTimeoutMs?: number;
    backoffMs?: number;
    backoffMaxMs?: number;
}
type Result = { ok: true; value: unknown; pair: Pair } | { ok: false; reason: string; lastWaitMs?: number };
const boardCalls = require_(MODULE) as {
    createBudget: (options: { now: () => number; baseMs: number; start?: number; pendingWindowMs?: number }) => Budget;
    boardCall: (deps: Deps, budget: Budget, call: Call) => Promise<Result>;
};
/** The pending window (`LEASE_PENDING_WINDOW_MS`): a kubernetes Secret refresh plus a control poll, from the call's start. */
const WINDOW_MS = 120_000;

const JOB = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const ENV: Env = { FACTORY_STATS_URL: 'http://board.test/', RUNNER_JOB_ID: JOB, RUNNER_LEASE_TOKEN: LEASE };
const START = 1_000_000;
const BASE_MS = 30_000;

type Reply = Response | Error | (() => Response);

/** A fake board on a clock the test owns: every sleep advances it; each request is recorded with its timeout. */
function rig(reply: (n: number) => Reply, env: Env = ENV) {
    let now = START;
    const requests: { url: string; init: RequestInit; timeoutMs: number; at: number }[] = [];
    const pairReads: number[] = [];
    const sleeps: number[] = [];
    let timeoutMs = 0;
    const deps: Deps = {
        env,
        now: () => now,
        signal: (ms) => {
            timeoutMs = ms;
            return new AbortController().signal;
        },
        fetch: (async (url: string, init: RequestInit) => {
            requests.push({ url, init, timeoutMs, at: now });
            const next = reply(requests.length);
            if (next instanceof Error) throw next;
            return typeof next === 'function' ? next() : next;
        }) as unknown as typeof fetch,
        sleep: async (ms) => {
            sleeps.push(ms);
            now += ms;
        },
        pair: async (from, options) => {
            pairReads.push(options?.deadlineMs ?? Number.NaN);
            return { jobId: from.RUNNER_JOB_ID ?? '', leaseToken: from.RUNNER_LEASE_TOKEN ?? '' };
        },
    };
    const budget = boardCalls.createBudget({ now: () => now, baseMs: BASE_MS });
    return {
        deps,
        budget,
        requests,
        pairReads,
        sleeps,
        advance: (ms: number) => (now += ms),
        elapsed: () => now - START,
    };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });
/** 200 → the body, anything else a retry: the shape every helper's classify takes. */
const okOrRetry = (answer: Answer): Verdict => (answer.status === 200 ? { done: answer.json } : { retry: true });
const call = (classify: Call['classify'] = okOrRetry, extra: Partial<Call> = {}): Call => ({
    method: 'POST',
    path: '/credentials/github',
    classify,
    ...extra,
});

/** A body that sends one chunk and then dies before its end. */
const cutOff = () =>
    new Response(
        new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"code":"LEASE_'));
                controller.error(new Error('socket hang up'));
            },
        }),
        { status: 503 }
    );

describe('board-call: one request path for the attempt pair', () => {
    it('presents the pair it reads on the job route and returns the classified answer with that pair', async () => {
        const r = rig(() => json(200, { token: 't' }));
        const result = await boardCalls.boardCall(r.deps, r.budget, call(okOrRetry, { body: { a: 1 } }));
        expect(result).toEqual({ ok: true, value: { token: 't' }, pair: { jobId: JOB, leaseToken: LEASE } });
        expect(r.requests).toHaveLength(1);
        expect(r.requests[0]!.url).toBe(`http://board.test/api/jobs/${JOB}/credentials/github`);
        expect(r.requests[0]!.init).toMatchObject({
            method: 'POST',
            redirect: 'manual',
            body: '{"a":1}',
            headers: {
                'x-factory-job-id': JOB,
                'x-factory-job-lease-token': LEASE,
                'content-type': 'application/json',
            },
        });
    });

    it('re-reads the pair on every try and makes no request without one', async () => {
        const r = rig((n) => (n < 3 ? json(502, {}) : json(200, { ok: 1 })));
        expect(await boardCalls.boardCall(r.deps, r.budget, call())).toMatchObject({ ok: true });
        expect(r.pairReads).toHaveLength(3);
        for (const bare of [
            { ...ENV, FACTORY_STATS_URL: undefined },
            { ...ENV, RUNNER_LEASE_TOKEN: '' },
        ]) {
            const none = rig(() => json(200, {}), bare);
            expect(await boardCalls.boardCall(none.deps, none.budget, call())).toEqual({
                ok: false,
                reason: 'no_pair',
            });
            expect(none.requests).toEqual([]);
        }
    });

    // pin: a 503 that is not LEASE_PENDING is an ordinary retry under the base budget.
    it('a 503 that is not LEASE_PENDING keeps the base budget', async () => {
        const replies: (() => Response)[] = [
            () => json(503, { code: 'UNAVAILABLE' }),
            () => new Response('not json', { status: 503 }),
            cutOff,
        ];
        for (const reply of replies) {
            const r = rig(reply);
            const result = await boardCalls.boardCall(r.deps, r.budget, call());
            expect(result).toMatchObject({ ok: false, reason: 'deadline' });
            expect(r.elapsed()).toBeLessThanOrEqual(BASE_MS);
            expect(r.requests.length).toBeGreaterThan(1);
            for (const request of r.requests) expect(request.at).toBeLessThan(START + BASE_MS);
        }
    });

    // pin: 401/403 are no special case here; each helper's classify makes them terminal.
    it('hands 401/403 to classify at once', async () => {
        for (const status of [401, 403]) {
            const r = rig(() => json(status, { error: 'refused', code: 'UNAUTHENTICATED' }));
            const seen: number[] = [];
            const result = await boardCalls.boardCall(
                r.deps,
                r.budget,
                call((answer) => {
                    seen.push(answer.status);
                    return answer.status === 200 ? { done: answer.json } : { done: 'refused' };
                })
            );
            expect(result).toMatchObject({ ok: true, value: 'refused' });
            expect(r.requests).toHaveLength(1);
            expect(seen).toEqual([status]);
        }
    });

    // pin: only the board's own answer reaches classify; a 4xx with no `code` (a route miss, a proxy page) is a retry.
    it('retries a 4xx without the board code, never handing it to classify', async () => {
        const replies: (() => Response)[] = [
            () => json(404, { message: 'Route POST:/x not found', error: 'Not Found', statusCode: 404 }),
            () => new Response('<html>403</html>', { status: 403 }),
            () => json(409, { error: 'conflict' }),
        ];
        for (const reply of replies) {
            const r = rig(reply);
            const seen: number[] = [];
            const result = await boardCalls.boardCall(
                r.deps,
                r.budget,
                call((answer) => {
                    seen.push(answer.status);
                    return { done: 'refused' };
                })
            );
            expect(result).toMatchObject({ ok: false, reason: 'deadline' });
            expect(seen).toEqual([]);
            expect(r.requests.length).toBeGreaterThan(1);
        }
    });

    // pin: the board's coded 4xx and a 429 still reach classify.
    it('hands a coded 4xx, and a 429, to classify', async () => {
        for (const reply of [() => json(404, { code: 'NOT_FOUND' }), () => json(429, {})]) {
            const r = rig(reply);
            const result = await boardCalls.boardCall(
                r.deps,
                r.budget,
                call(() => ({ done: 'answered' }))
            );
            expect(result).toMatchObject({ ok: true, value: 'answered' });
        }
    });

    // pin: the pair read and the request never outlast the budget.
    it('a pair read and a request are clamped to the remaining budget', async () => {
        const r = rig((n) => (n === 1 ? new Error('connect ECONNRESET') : json(200, {})));
        r.advance(BASE_MS - 1500);
        expect(await boardCalls.boardCall(r.deps, r.budget, call())).toMatchObject({ ok: true });
        expect(r.pairReads).toEqual([1500, 1000]);
        expect(r.requests.map((request) => request.timeoutMs)).toEqual([1500, 1000]);
        const capped = rig(() => json(200, {}));
        await boardCalls.boardCall(capped.deps, capped.budget, call(okOrRetry, { requestTimeoutMs: 15_000 }));
        expect(capped.pairReads).toEqual([2000]);
        expect(capped.requests[0]!.timeoutMs).toBe(15_000);
        const fresh = rig(() => json(200, {}));
        await boardCalls.boardCall(fresh.deps, fresh.budget, call());
        expect(fresh.requests[0]!.timeoutMs).toBe(10_000);
    });

    // pin: an oversize body is no answer.
    it('a body over 64 KB is a wire failure, not an answer', async () => {
        const big = JSON.stringify({ pad: 'x'.repeat(64 * 1024) });
        const r = rig((n) => (n === 1 ? new Response(big, { status: 200 }) : json(200, { small: true })));
        const seen: unknown[] = [];
        const result = await boardCalls.boardCall(
            r.deps,
            r.budget,
            call((answer) => {
                seen.push(answer.json);
                return okOrRetry(answer);
            })
        );
        expect(result).toMatchObject({ ok: true, value: { small: true } });
        expect(seen).toEqual([{ small: true }]);
        expect(r.requests).toHaveLength(2);
    });

    it('a hinted wait past the budget ends rate_limited; backoff past it ends deadline', async () => {
        const r = rig(() => json(429, {}, { 'retry-after': '60' }));
        const hinted = await boardCalls.boardCall(
            r.deps,
            r.budget,
            call((answer) => ({ retry: true, waitMs: Number(answer.headers.get('retry-after')) * 1000 }))
        );
        expect(hinted).toEqual({ ok: false, reason: 'rate_limited', lastWaitMs: 60_000 });
        expect(r.requests).toHaveLength(1);
        expect(r.sleeps).toEqual([]);
        const backoff = rig(() => json(502, {}));
        await boardCalls.boardCall(backoff.deps, backoff.budget, call());
        expect(backoff.sleeps.slice(0, 5)).toEqual([500, 1000, 2000, 4000, 4000]);
        const slow = rig(() => json(502, {}));
        await boardCalls.boardCall(slow.deps, slow.budget, call(okOrRetry, { backoffMs: 250, backoffMaxMs: 2000 }));
        expect(slow.sleeps.slice(0, 5)).toEqual([250, 500, 1000, 2000, 2000]);
    });

    it('once makes one request whatever the answer', async () => {
        const r = rig(() => new Error('connect ECONNREFUSED'));
        expect(await boardCalls.boardCall(r.deps, r.budget, call(okOrRetry, { once: true }))).toMatchObject({
            ok: false,
            reason: 'deadline',
        });
        expect(r.requests).toHaveLength(1);
        expect(r.sleeps).toEqual([]);
    });

    it('never rejects: a fetch that throws synchronously is a wire failure', async () => {
        const r = rig(() => {
            throw new TypeError('bad init');
        });
        expect(await boardCalls.boardCall(r.deps, r.budget, call())).toMatchObject({ ok: false, reason: 'deadline' });
    });
});

describe('board-call: a pair the task held answers LEASE_PENDING until the new lease arrives', () => {
    const NEW = '33333333-3333-4333-8333-333333333333';
    const pending = () => json(503, { error: 'moved', code: 'LEASE_PENDING', retryable: true }, { 'retry-after': '1' });

    it('waits out LEASE_PENDING past the base budget, re-reading the pair each try, and returns the classified answer once the newer pair is presented', async () => {
        const r = rig(() => pending());
        // The relayed lease reaches the container 75 s in (a kubelet Secret refresh, observed 60-90 s).
        r.deps.pair = async (from, options) => {
            r.pairReads.push(options?.deadlineMs ?? Number.NaN);
            return { jobId: JOB, leaseToken: r.elapsed() >= 75_000 ? NEW : (from.RUNNER_LEASE_TOKEN ?? '') };
        };
        r.deps.fetch = (async (url: string, init: RequestInit) => {
            r.requests.push({ url, init, timeoutMs: 0, at: START + r.elapsed() });
            const lease = (init.headers as Record<string, string>)['x-factory-job-lease-token'];
            return lease === NEW ? json(200, { token: 'adopted' }) : pending();
        }) as unknown as typeof fetch;
        const result = await boardCalls.boardCall(r.deps, r.budget, call());
        expect(result).toEqual({ ok: true, value: { token: 'adopted' }, pair: { jobId: JOB, leaseToken: NEW } });
        expect(r.elapsed()).toBeGreaterThanOrEqual(75_000);
        expect(r.elapsed()).toBeLessThan(WINDOW_MS);
        expect(r.pairReads).toHaveLength(r.requests.length);
    });

    it('ends pending at start + window, never past it', async () => {
        const r = rig(() => pending());
        const result = await boardCalls.boardCall(r.deps, r.budget, call());
        expect(result).toMatchObject({ ok: false, reason: 'pending' });
        expect(r.elapsed()).toBeLessThanOrEqual(WINDOW_MS);
        for (const request of r.requests) expect(request.at).toBeLessThan(START + WINDOW_MS);
        // Every sleep ended inside the window: the clock moves only by sleeps here.
        expect(r.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(WINDOW_MS);
        expect(r.requests.length).toBeGreaterThan(BASE_MS / 1000);
    });

    it('a nested call shares the outer budget', async () => {
        const r = rig(() => pending());
        const outer = boardCalls.createBudget({ now: r.deps.now, baseMs: 60_000 });
        r.advance(50_000);
        const result = await boardCalls.boardCall(r.deps, outer, call());
        expect(result).toMatchObject({ ok: false, reason: 'pending' });
        // The window runs from the outer budget's start, never from the nested call's.
        expect(r.elapsed()).toBeLessThanOrEqual(WINDOW_MS);
        expect(r.elapsed()).toBeGreaterThan(60_000);
        for (const request of r.requests) expect(request.at).toBeLessThan(START + WINDOW_MS);
    });

    it('a window a budget names for itself is its ceiling (a revoke stays inside its cap)', async () => {
        const r = rig(() => pending());
        const capped = boardCalls.createBudget({ now: r.deps.now, baseMs: 3000, pendingWindowMs: 3000 });
        expect(await boardCalls.boardCall(r.deps, capped, call())).toMatchObject({ ok: false, reason: 'pending' });
        expect(r.elapsed()).toBeLessThanOrEqual(3000);
    });
});

/*
 * Every file the runner images hand an agent or run for it: the shared executor files, the skills and the
 * agent-home guides. The pair rides a board request only from board-call.cjs (and is printed only by
 * attempt-pair.cjs, which reads it), so a new helper cannot bypass the one call path.
 */
const SHIPPED = [
    'docker/executor-common',
    'docker/skills',
    'docker/claude-executor/claude-home',
    'docker/opencode-executor/opencode-home',
];
const EXTENSIONS = ['.cjs', '.js', '.mjs', '.sh', '.md'];
const OWNERS = ['board-call.cjs', 'attempt-pair.cjs'];
/**
 * branch-reporter.cjs: a periodic fire-and-forget sample of /api/sessions/branch, re-sent every tick with its
 * answer ignored, so it has nothing to wait out and no verdict to classify.
 */
const EXEMPT = ['branch-reporter.cjs'];
const PAIR_READ = /\bcurrentPair\(|\bdeps\.pair\(|attempt-pair\.cjs[^\n]*\|\s*curl\b/;

function shippedFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else if (EXTENSIONS.some((ext) => name.endsWith(ext))) files.push(path);
        }
    };
    for (const dir of SHIPPED) walk(join(ROOT, dir));
    return files;
}

describe('every runner board call goes through board-call.cjs', () => {
    it('keeps the exemption list exactly branch-reporter.cjs', () => {
        expect(EXEMPT).toEqual(['branch-reporter.cjs']);
    });

    it('no shipped file but board-call.cjs puts the pair on a request or reads it to send', () => {
        const files = shippedFiles();
        expect(files.length).toBeGreaterThan(10);
        const offenders: string[] = [];
        for (const file of files) {
            const name = basename(file);
            if (OWNERS.includes(name) || EXEMPT.includes(name)) continue;
            const text = readFileSync(file, 'utf8');
            const rel = relative(ROOT, file);
            if (text.includes('x-factory-job-lease-token')) {
                offenders.push(
                    `${rel} builds the lease header: route it through docker/executor-common/board-call.cjs`
                );
            }
            if (PAIR_READ.test(text)) {
                offenders.push(
                    `${rel} reads the attempt pair to send it: route it through docker/executor-common/board-call.cjs`
                );
            }
        }
        expect(offenders).toEqual([]);
    });
});
