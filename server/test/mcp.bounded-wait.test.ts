import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { Caller } from '../src/auth/store.js';
import type { Bridge, BridgeOutcome } from '../src/mcp/bridge.js';
import {
    WAIT_BUDGET_DEFAULT_S,
    WAIT_BUDGET_MAX_S,
    boundedWait,
    holdSecondsLeft,
    type Hold,
} from '../src/mcp/bounded-wait.js';
import { registerTools, type ToolRuntime } from '../src/mcp/registry.js';
import { waitTask } from '../src/mcp/tools/task-wait.js';
import { memoryAuthStore } from './helpers.js';

const SECOND = 1000;
const TASK = '11111111-1111-4111-8111-111111111111';

/** `terminalOutcome` of `cli/src/run.ts`, copied: the CLI imports nothing from the server, so the server pins a copy. */
const CLI_TERMINAL_OUTCOME = {
    succeeded: 'succeeded',
    failed: 'failed',
    dead: 'failed',
    stopped: 'cancelled',
} as const;
/** `runWait` of the same file: a parked head is `needsAttention`, a spent budget is `timeout`. */
const CLI_PARKED_OUTCOME = 'needs_attention';
const CLI_TIMEOUT_OUTCOME = 'timeout';

describe('boundedWait', () => {
    const idle = new AbortController().signal;

    it('holds the whole seconds the budget leaves after the headroom, never past it', () => {
        expect(holdSecondsLeft(45 * SECOND, 0)).toBe(42);
        expect(holdSecondsLeft(100 * SECOND, 0)).toBe(60);
        expect(holdSecondsLeft(3.9 * SECOND, 0)).toBe(0);
        expect(holdSecondsLeft(4 * SECOND, 0)).toBe(1);
        expect(holdSecondsLeft(5.9 * SECOND, 0)).toBe(2);
        expect(holdSecondsLeft(0, 0)).toBe(0);
        expect(holdSecondsLeft(0, SECOND)).toBe(0);
    });

    it('asks for nothing when the budget cannot hold a second', async () => {
        // Settling on a call makes a loop that starts a hold it should not fail the test, not spin on the frozen clock.
        const hold = vi.fn(async (): Promise<Hold<string>> => ({ kind: 'settled', value: 'started' }));
        const end = await boundedWait({ budgetSeconds: 3.99, now: () => 0, signal: idle, hold });
        expect(end).toEqual({ kind: 'timeout' });
        expect(hold).not.toHaveBeenCalled();
    });

    it('is generic over what settles: it returns the value the hold settled on', async () => {
        let t = 0;
        const asked: number[] = [];
        const end = await boundedWait<{ batch: string }>({
            budgetSeconds: 30,
            now: () => t,
            signal: idle,
            hold: async (seconds) => {
                asked.push(seconds);
                t += 10 * SECOND;
                return asked.length < 2 ? { kind: 'open' } : { kind: 'settled', value: { batch: 'done' } };
            },
        });
        expect(end).toEqual({ kind: 'settled', value: { batch: 'done' } });
        expect(asked).toEqual([27, 17]);
    });

    it('never sends a progress value that does not exceed the last one', async () => {
        let t = 0;
        const sent: number[] = [];
        const spends = [0, 400, 0, 600, 0];
        await boundedWait<string>({
            budgetSeconds: 45,
            now: () => t,
            signal: idle,
            hold: async () => {
                t += spends.shift() ?? 0;
                return spends.length > 0 ? { kind: 'open' } : { kind: 'settled', value: 'x' };
            },
            progress: async (elapsed) => void sent.push(elapsed),
        });
        expect(sent.length).toBeGreaterThan(0);
        for (let i = 1; i < sent.length; i++) expect(sent[i]!).toBeGreaterThan(sent[i - 1]!);
        expect(sent).toEqual([0.4, 1]);
    });

    it('is ended by the client leaving while a hold is in flight', async () => {
        const stop = new AbortController();
        const pending = boundedWait<string>({
            budgetSeconds: 45,
            now: () => 0,
            signal: stop.signal,
            hold: (_seconds) =>
                new Promise((resolve) => stop.signal.addEventListener('abort', () => resolve({ kind: 'open' }))),
        });
        stop.abort();
        expect(await pending).toEqual({ kind: 'aborted' });
    });

    it('ends on a stopped hold and on an abort, starting no further hold', async () => {
        const stop = new AbortController();
        const hold = vi.fn(async (): Promise<Hold<string>> => {
            stop.abort();
            // A loop that ignores the abort would spin forever on a frozen clock; settle it so the test fails instead.
            return hold.mock.calls.length > 3 ? { kind: 'settled', value: 'runaway' } : { kind: 'open' };
        });
        expect(await boundedWait({ budgetSeconds: 45, now: () => 0, signal: stop.signal, hold })).toEqual({
            kind: 'aborted',
        });
        expect(hold).toHaveBeenCalledTimes(1);
    });
});

// --- wait_task through the registry wrapper, a fake clock and a fake bridge ---

type Handler = (
    args: Record<string, unknown>,
    ctx: ServerContext
    // biome-ignore lint/suspicious/noExplicitAny: structured content is asserted field by field
) => Promise<{ isError?: boolean; content?: unknown; structuredContent?: Record<string, any> }>;

const capture = () => {
    const handlers = new Map<string, Handler>();
    const server = { registerTool: (name: string, _c: unknown, handler: Handler) => handlers.set(name, handler) };
    return { server: server as unknown as McpServer, handlers };
};

const caller: Caller = { ...memoryAuthStore().seedMember('org-a', 'octocat', 'admin'), scopes: 'all' };

const run = (overrides: Record<string, unknown> = {}) => ({
    id: TASK,
    rootJobId: TASK,
    command: 'task',
    status: 'running',
    repo: 'acme/web',
    executor: null,
    mode: 'objective',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: null,
    exitCode: null,
    failureKind: null,
    failureCause: null,
    summary: null,
    output: null,
    gates: null,
    waitReason: null,
    publication: null,
    author: { login: 'octocat' },
    questions: [],
    integrationRequirements: [],
    ...overrides,
});

const QUESTION = {
    id: 'q1',
    attempt: 1,
    questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'a' }] }],
    status: 'pending',
    answerable: true,
    answers: null,
    answeredBy: null,
    askedAt: '2026-01-01T00:01:00.000Z',
    answeredAt: null,
};

interface Rig {
    /** What a hold answers, in order; the clock moves by `spend` seconds first, as a long-poll would. */
    holds: {
        spend: number | 'hold';
        outcome: BridgeOutcome | ((url: string, signal?: AbortSignal) => BridgeOutcome | Promise<BridgeOutcome>);
    }[];
    /** What the thread re-read answers. */
    /** What the thread re-read answers; a list answers one per read, the last one repeating. */
    thread: BridgeOutcome | BridgeOutcome[];
}

const json = (body: unknown, status = 200): BridgeOutcome => ({ kind: 'response', status, body });
const settle = (result: string, headStatus: string, extra: Record<string, unknown> = {}) =>
    json({
        result,
        rootJobId: TASK,
        headJobId: TASK,
        headStatus,
        waitReason: null,
        job: run({ status: headStatus }),
        ...extra,
    });
const threadOf = (...jobs: ReturnType<typeof run>[]) => json({ jobs });

function rig(spec: Rig) {
    let t = 1_700_000_000_000;
    const urls: string[] = [];
    const holdsAt: { at: number; seconds: number }[] = [];
    const start = t;
    const bridge: Bridge = {
        call: async (_c, request, { signal }) => {
            urls.push(request.url);
            if (signal?.aborted) return { kind: 'inconclusive', reason: 'aborted' };
            if (request.url.includes('waitFor=')) {
                const seconds = Number(new URL(request.url, 'http://x').searchParams.get('timeout'));
                if (!(seconds >= 1)) throw new Error(`a hold of ${seconds}s was started`);
                holdsAt.push({ at: t - start, seconds });
                const step = spec.holds.shift();
                if (!step) throw new Error('an unscripted hold was started');
                t += (step.spend === 'hold' ? seconds : step.spend) * SECOND;
                return typeof step.outcome === 'function' ? step.outcome(request.url, signal) : step.outcome;
            }
            if (!Array.isArray(spec.thread)) return spec.thread;
            return (spec.thread.length > 1 ? spec.thread.shift() : spec.thread[0]) as BridgeOutcome;
        },
    };
    const runtime: ToolRuntime = { bridge, deadlineMs: 55 * SECOND, active: new Map(), now: () => t };
    const { server, handlers } = capture();
    registerTools(server, caller, runtime, [waitTask]);
    const notify = vi.fn(async () => undefined);
    const call = (args: Record<string, unknown> = {}, opts: { token?: string; signal?: AbortSignal } = {}) =>
        handlers.get('wait_task')!({ taskId: TASK, ...args }, {
            mcpReq: {
                signal: opts.signal ?? new AbortController().signal,
                _meta: opts.token === undefined ? undefined : { progressToken: opts.token },
                notify,
            },
        } as unknown as ServerContext);
    return { call, urls, holdsAt, notify, at: () => t - start };
}

const holdUrls = (urls: string[]) => urls.filter((u) => u.includes('waitFor='));

describe('wait_task', () => {
    it('settles inside the budget with the head re-read after the wait', async () => {
        const { call, urls, holdsAt } = rig({
            holds: [
                { spend: 10, outcome: settle('timeout', 'running') },
                { spend: 5, outcome: settle('terminal', 'succeeded') },
            ],
            thread: threadOf(run({ status: 'succeeded', finishedAt: '2026-01-01T00:02:00.000Z', summary: 'done' })),
        });
        const out = await call();
        expect(out.isError).toBeUndefined();
        expect(out.structuredContent).toMatchObject({
            result: 'succeeded',
            state: 'succeeded',
            taskId: TASK,
            summary: 'done',
            budgetSeconds: WAIT_BUDGET_DEFAULT_S,
        });
        expect(holdsAt).toEqual([
            { at: 0, seconds: 42 },
            { at: 10 * SECOND, seconds: 32 },
        ]);
        expect(urls.at(-1)).toBe(`/api/jobs/${TASK}/thread`);
    });

    it('ends in timeout when the budget runs out, starting no hold past it', async () => {
        const { call, holdsAt, at } = rig({
            holds: [{ spend: 42, outcome: settle('timeout', 'running') }],
            thread: threadOf(run()),
        });
        const out = await call();
        expect(out.isError).toBeUndefined();
        expect(out.structuredContent).toMatchObject({ result: 'timeout', status: 'running', budgetSeconds: 45 });
        expect(holdsAt).toHaveLength(1);
        for (const { at: when, seconds } of holdsAt) expect(when + seconds * SECOND).toBeLessThanOrEqual(45 * SECOND);
        expect(at()).toBe(42 * SECOND);
    });

    it('caps the budget at the maximum', async () => {
        const { call, holdsAt } = rig({
            holds: [{ spend: 52, outcome: settle('timeout', 'running') }],
            thread: threadOf(run()),
        });
        const out = await call({ budgetSeconds: 500 });
        expect(out.structuredContent).toMatchObject({ result: 'timeout', budgetSeconds: WAIT_BUDGET_MAX_S });
        expect(holdsAt).toEqual([{ at: 0, seconds: 52 }]);
    });

    it.each([0.5, 3.99, 4, 4.5, 5.9, 7.2, 10.999, 44.5])(
        'a fractional budget of %s never sends timeout=0 or a fractional timeout',
        async (budget) => {
            const holds = Array.from({ length: 20 }, () => ({
                spend: 'hold' as const,
                outcome: settle('timeout', 'running'),
            }));
            const { call, urls, holdsAt } = rig({ holds, thread: threadOf(run()) });
            const out = await call({ budgetSeconds: budget });
            expect(out.structuredContent).toMatchObject({ result: 'timeout' });
            for (const url of holdUrls(urls)) expect(url).toMatch(/[?&]timeout=[1-9]\d*(&|$)/);
            for (const { at, seconds } of holdsAt) expect(at + seconds * SECOND).toBeLessThanOrEqual(budget * SECOND);
        }
    );

    it('starts no hold at all when the budget cannot hold one second', async () => {
        const { call, urls } = rig({ holds: [], thread: threadOf(run()) });
        const out = await call({ budgetSeconds: 2 });
        expect(out.structuredContent).toMatchObject({ result: 'timeout', taskId: TASK });
        expect(urls).toEqual([]);
        // It returned at once: the text must not claim a wait of the whole budget.
        expect(JSON.stringify(out.content)).not.toMatch(/after \d+s/);
    });

    it('maps the head status exactly as bellows job wait does', async () => {
        const seen: Record<string, unknown> = {};
        for (const [status, expected] of Object.entries(CLI_TERMINAL_OUTCOME)) {
            const { call } = rig({
                holds: [{ spend: 1, outcome: settle('terminal', status) }],
                thread: threadOf(run({ status })),
            });
            seen[status] = (await call()).structuredContent?.result;
            expect(seen[status], status).toBe(expected);
        }
        expect(seen).toEqual(CLI_TERMINAL_OUTCOME);
        const parked = rig({
            holds: [{ spend: 1, outcome: settle('parked', 'succeeded', { waitReason: 'pr_review' }) }],
            thread: threadOf(run({ status: 'succeeded' })),
        });
        const out = await parked.call();
        expect(out.structuredContent).toMatchObject({ result: CLI_PARKED_OUTCOME, waitReason: 'pr_review' });
        const spent = rig({ holds: [{ spend: 42, outcome: settle('timeout', 'running') }], thread: threadOf(run()) });
        expect((await spent.call()).structuredContent?.result).toBe(CLI_TIMEOUT_OUTCOME);
    });

    it.each(['queued', 'running'])(
        'answers needs_attention on a parked poll whatever the head status (%s), after exactly one hold',
        async (status) => {
            const { call, holdsAt } = rig({
                holds: [{ spend: 1, outcome: settle('parked', status, { waitReason: 'pr_review' }) }],
                thread: threadOf(run({ status })),
            });
            const out = await call();
            expect(out.structuredContent).toMatchObject({ result: 'needs_attention', waitReason: 'pr_review', status });
            expect(holdsAt).toHaveLength(1);
        }
    );

    it('treats a status that is only on the object prototype as unknown, never as settled', async () => {
        const { call } = rig({
            holds: [{ spend: 1, outcome: settle('terminal', 'running') }],
            thread: threadOf(run({ status: 'toString' })),
        });
        const out = await call();
        expect(out.isError).toBe(true);
        expect(out.structuredContent).toMatchObject({ outcome: 'inconclusive' });
        expect(JSON.stringify(out.structuredContent)).toContain('the settled head reads toString');
    });

    it('keeps the CLI mapping on a head with an open question or requirement, and reports it beside', async () => {
        const REQUIREMENT = { provider: 'jira', label: 'Jira', reason: 'missing', source: 'runtime' };
        for (const [status, expected] of Object.entries(CLI_TERMINAL_OUTCOME)) {
            for (const open of [{ questions: [QUESTION] }, { integrationRequirements: [REQUIREMENT] }]) {
                const { call } = rig({
                    holds: [{ spend: 1, outcome: settle('terminal', status) }],
                    thread: threadOf(run({ status, ...open })),
                });
                const out = (await call()).structuredContent;
                expect(out?.result, `${status} ${Object.keys(open)}`).toBe(expected);
                expect(out?.state, status).toBe(status === 'stopped' ? 'cancelled' : 'needs_attention');
                if (status !== 'stopped') {
                    expect(out?.attention, status).toMatchObject({
                        openQuestions: 'questions' in open ? 1 : 0,
                        integrationRequirements:
                            'questions' in open ? [] : [expect.objectContaining({ provider: 'jira' })],
                    });
                }
            }
        }
    });

    it('takes every field of the answer from the head re-read, never from the poll that settled', async () => {
        const raced = rig({
            holds: [{ spend: 42, outcome: settle('terminal', 'failed') }],
            thread: threadOf(run({ status: 'failed' }), run({ id: 'run-2', status: 'queued' })),
        });
        const retried = (await raced.call()).structuredContent;
        expect(retried).toMatchObject({ result: 'timeout', taskId: TASK, runId: 'run-2', status: 'queued' });

        const flipped = rig({
            holds: [{ spend: 1, outcome: settle('terminal', 'succeeded') }],
            thread: threadOf(run({ status: 'succeeded' }), run({ id: 'run-2', status: 'failed', failureKind: 'gate' })),
        });
        expect((await flipped.call()).structuredContent).toMatchObject({
            result: 'failed',
            runId: 'run-2',
            status: 'failed',
            error: { kind: 'gate' },
        });
    });

    it('keeps waiting on the new head while budget remains when the head moved after the poll settled', async () => {
        const queued = threadOf(run({ status: 'failed' }), run({ id: 'run-2', status: 'queued' }));
        const done = threadOf(
            run({ status: 'failed' }),
            run({ id: 'run-2', status: 'succeeded', summary: 'second try' })
        );
        const { call, holdsAt } = rig({
            holds: [
                { spend: 1, outcome: settle('terminal', 'failed') },
                { spend: 1, outcome: settle('terminal', 'succeeded', { headJobId: 'run-2' }) },
            ],
            thread: [queued, done],
        });
        const out = (await call()).structuredContent;
        expect(out).toMatchObject({ result: 'succeeded', runId: 'run-2', status: 'succeeded', summary: 'second try' });
        expect(holdsAt).toHaveLength(2);
    });

    it('keeps a task nobody claimed as timeout, never failed', async () => {
        const holds = [{ spend: 42, outcome: settle('timeout', 'queued') }];
        const { call } = rig({ holds, thread: threadOf(run({ status: 'queued', startedAt: null })) });
        const out = await call();
        expect(out.isError).toBeUndefined();
        expect(out.structuredContent).toMatchObject({ result: 'timeout', status: 'queued' });
    });

    it.each([
        ['a transport failure', { kind: 'inconclusive', reason: 'transport' } as BridgeOutcome],
        ['a 500', json({ error: 'boom' }, 500)],
        ['a 200 that is not a wait', json({ nope: true })],
        [
            'a 200 with an unknown result',
            json({ result: 'bogus', rootJobId: 'a', headJobId: 'b', headStatus: 'running' }),
        ],
        ['an empty body', { kind: 'response', status: 200, body: undefined } as BridgeOutcome],
    ])('%s on the hold is inconclusive, never failed', async (_name, outcome) => {
        const { call } = rig({ holds: [{ spend: 1, outcome }], thread: threadOf(run()) });
        const out = await call();
        expect(out.isError).toBe(true);
        expect(out.structuredContent).toMatchObject({ outcome: 'inconclusive' });
        expect(JSON.stringify(out.structuredContent)).not.toContain('"failed"');
    });

    it.each([
        ['a 500', json({ error: 'boom' }, 500)],
        ['a payload with no runs', json({ jobs: [] })],
        ['a status the board does not define', threadOf(run({ status: 'exploded' }))],
        ['a transport failure', { kind: 'inconclusive', reason: 'transport' } as BridgeOutcome],
    ])('%s on the head re-read is inconclusive, never failed', async (_name, thread) => {
        const { call } = rig({ holds: [{ spend: 1, outcome: settle('terminal', 'failed') }], thread });
        const out = await call();
        expect(out.isError).toBe(true);
        expect(out.structuredContent).toMatchObject({ outcome: 'inconclusive' });
    });

    it('surfaces the board refusing the task (another organization, unknown id) without a hold loop', async () => {
        const { call, urls } = rig({
            holds: [{ spend: 0, outcome: json({ error: 'job not found', code: 'not_found' }, 404) }],
            thread: threadOf(run()),
        });
        const out = await call();
        expect(out.isError).toBe(true);
        expect(out.structuredContent).toMatchObject({ outcome: 'refused', code: 'not_found', status: 404 });
        expect(holdUrls(urls)).toHaveLength(1);
    });

    it('sends progress between holds if and only if the request carried a token', async () => {
        const script = () => ({
            holds: [
                { spend: 10, outcome: settle('timeout', 'running') },
                { spend: 10, outcome: settle('terminal', 'succeeded') },
            ],
            thread: threadOf(run({ status: 'succeeded' })),
        });
        const withToken = rig(script());
        await withToken.call({}, { token: 'tok' });
        expect(withToken.notify).toHaveBeenCalledTimes(1);
        expect(withToken.notify).toHaveBeenCalledWith({
            method: 'notifications/progress',
            params: expect.objectContaining({ progressToken: 'tok', progress: 10, total: 45 }),
        });
        const without = rig(script());
        await without.call();
        expect(without.notify).not.toHaveBeenCalled();
    });

    it('resolves a hold that is in flight when the client leaves', async () => {
        const stop = new AbortController();
        const { call, urls } = rig({
            holds: [
                {
                    spend: 1,
                    outcome: (_url, signal) =>
                        new Promise((resolve) =>
                            signal?.addEventListener('abort', () =>
                                resolve({ kind: 'inconclusive', reason: 'aborted' })
                            )
                        ),
                },
            ],
            thread: threadOf(run()),
        });
        const pending = call({}, { signal: stop.signal });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(holdUrls(urls)).toHaveLength(1);
        stop.abort();
        const out = await pending;
        expect(out.structuredContent).toMatchObject({ outcome: 'inconclusive' });
        expect(holdUrls(urls)).toHaveLength(1);
    });

    it('stops the loop when the client leaves: no further hold, no verdict', async () => {
        const stop = new AbortController();
        const { call, urls } = rig({
            holds: [
                {
                    spend: 1,
                    outcome: () => {
                        stop.abort();
                        return { kind: 'inconclusive', reason: 'aborted' };
                    },
                },
            ],
            thread: threadOf(run()),
        });
        const out = await call({}, { signal: stop.signal });
        expect(out.isError).toBe(true);
        expect(out.structuredContent).toMatchObject({ outcome: 'inconclusive' });
        expect(holdUrls(urls)).toHaveLength(1);
        const before = rig({ holds: [], thread: threadOf(run()) });
        stop.abort();
        const gone = await before.call({}, { signal: stop.signal });
        expect(gone.structuredContent).toMatchObject({ outcome: 'inconclusive' });
        expect(before.urls).toEqual([]);
    });
});
