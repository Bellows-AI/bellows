import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { Caller } from '../src/auth/store.js';
import type { Bridge, BridgeOutcome } from '../src/mcp/bridge.js';
import { WAIT_BUDGET_DEFAULT_S, WAIT_BUDGET_MAX_S } from '../src/mcp/bounded-wait.js';
import { registerTools, type ToolRuntime } from '../src/mcp/registry.js';
import { waitBatch } from '../src/mcp/tools/batch-wait.js';
import { memoryAuthStore } from './helpers.js';

/**
 * `wait_batch` on a fake clock and a scripted board: the hold arithmetic, the re-read behind every verdict and the
 * mapping of the board's `standing` onto the CLI's `batch wait` outcomes. The real routes and stores are driven by
 * `mcp.tools-batch.test.ts` and `server/test-db/mcp.tools-batch.test.ts`.
 */

const SECOND = 1000;
const BATCH = '22222222-2222-4222-8222-222222222222';

/**
 * `waitEnd` / `SETTLED` of `cli/src/batch-commands.ts`, copied (the CLI imports nothing from the server, so the server
 * pins a copy): a fence names the outcome `cancelled`, otherwise the settled verdicts end the command as themselves,
 * and `running` / `inconclusive` / `draft` keep the CLI watching.
 */
const CLI_SETTLED_OUTCOME: Record<string, string | null> = {
    succeeded: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
    needs_attention: 'needs_attention',
    running: null,
    inconclusive: null,
    draft: null,
};
/** `EXIT_CODE_OF` of `cli/src/outcome.ts`, copied for the outcomes a wait ends in. */
const CLI_EXIT_CODE = { succeeded: 0, failed: 4, cancelled: 5, needs_attention: 6, timeout: 3 } as const;

type Handler = (
    args: Record<string, unknown>,
    ctx: ServerContext
    // biome-ignore lint/suspicious/noExplicitAny: structured content is asserted field by field below
) => Promise<{ isError?: boolean; content?: unknown; structuredContent?: Record<string, any> }>;

const caller: Caller = { ...memoryAuthStore().seedMember('org-a', 'octocat', 'admin'), scopes: 'all' };

const standing = (verdict: string, extra: Record<string, unknown> = {}) => ({
    verdict,
    fence: null,
    attention: [],
    verificationFailures: [],
    ...extra,
});

const batch = (verdict: string, extra: Record<string, unknown> = {}, standingExtra: Record<string, unknown> = {}) => ({
    id: BATCH,
    status: 'running',
    version: 1,
    standing: standing(verdict, standingExtra),
    tasks: [{ key: 'a', stage: 'one', execution: 'running' }],
    ...extra,
});

const json = (body: unknown, status = 200): BridgeOutcome => ({ kind: 'response', status, body });
const settle = (result: string, view: ReturnType<typeof batch>) => json({ result, batch: view });

interface Rig {
    /** What a hold answers, in order; the clock moves by `spend` seconds first, as a long-poll would. */
    holds: {
        spend: number | 'hold';
        outcome: BridgeOutcome | ((url: string, signal?: AbortSignal) => BridgeOutcome | Promise<BridgeOutcome>);
    }[];
    /** What the batch re-read answers; a list answers one per read, the last one repeating. */
    reread: BridgeOutcome | BridgeOutcome[];
}

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
            if (!Array.isArray(spec.reread)) return spec.reread;
            return (spec.reread.length > 1 ? spec.reread.shift() : spec.reread[0]) as BridgeOutcome;
        },
    };
    const runtime: ToolRuntime = { bridge, deadlineMs: 55 * SECOND, active: new Map(), now: () => t };
    const handlers = new Map<string, Handler>();
    const server = { registerTool: (name: string, _c: unknown, handler: Handler) => handlers.set(name, handler) };
    registerTools(server as unknown as McpServer, caller, runtime, [waitBatch]);
    const notify = vi.fn(async () => undefined);
    const call = (args: Record<string, unknown> = {}, opts: { token?: string; signal?: AbortSignal } = {}) =>
        handlers.get('wait_batch')!({ batchId: BATCH, ...args }, {
            mcpReq: {
                signal: opts.signal ?? new AbortController().signal,
                _meta: opts.token === undefined ? undefined : { progressToken: opts.token },
                notify,
            },
        } as unknown as ServerContext);
    return { call, urls, holdsAt, notify, at: () => t - start };
}

const holdUrls = (urls: string[]) => urls.filter((u) => u.includes('waitFor='));

describe('wait_batch', () => {
    it('settles inside the budget, the verdict coming from the re-read of standing and not the poll', async () => {
        const { call, urls, holdsAt } = rig({
            holds: [
                { spend: 10, outcome: settle('timeout', batch('running')) },
                { spend: 5, outcome: settle('terminal', batch('running')) },
            ],
            reread: json(batch('succeeded', { status: 'completed' })),
        });
        const out = await call();
        expect(out.isError).toBeUndefined();
        expect(out.structuredContent).toMatchObject({
            result: 'succeeded',
            verdict: 'succeeded',
            batchId: BATCH,
            status: 'completed',
            budgetSeconds: WAIT_BUDGET_DEFAULT_S,
        });
        expect(holdsAt).toEqual([
            { at: 0, seconds: 42 },
            { at: 10 * SECOND, seconds: 32 },
        ]);
        expect(urls.at(-1)).toBe(`/api/batches/${BATCH}`);
        expect(urls[0]).toBe(`/api/batches/${BATCH}?waitFor=terminal&timeout=42`);
    });

    it('ends in timeout when the budget runs out, starting no hold past it, with the last standing seen', async () => {
        const { call, holdsAt, at } = rig({
            holds: [{ spend: 42, outcome: settle('timeout', batch('running')) }],
            reread: json(batch('running')),
        });
        const out = await call();
        expect(out.isError).toBeUndefined();
        expect(out.structuredContent).toMatchObject({
            result: 'timeout',
            batchId: BATCH,
            verdict: 'running',
            budgetSeconds: 45,
        });
        expect(holdsAt).toHaveLength(1);
        for (const { at: when, seconds } of holdsAt) expect(when + seconds * SECOND).toBeLessThanOrEqual(45 * SECOND);
        expect(at()).toBe(42 * SECOND);
    });

    it('caps the budget at the maximum', async () => {
        const { call, holdsAt } = rig({
            holds: [{ spend: 52, outcome: settle('timeout', batch('running')) }],
            reread: json(batch('running')),
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
                outcome: settle('timeout', batch('running')),
            }));
            const { call, urls, holdsAt } = rig({ holds, reread: json(batch('running')) });
            const out = await call({ budgetSeconds: budget });
            expect(out.structuredContent).toMatchObject({ result: 'timeout' });
            for (const url of holdUrls(urls)) expect(url).toMatch(/[?&]timeout=[1-9]\d*(&|$)/);
            for (const { at, seconds } of holdsAt) expect(at + seconds * SECOND).toBeLessThanOrEqual(budget * SECOND);
        }
    );

    it('starts no hold at all when the budget cannot hold one second, and claims no verdict', async () => {
        const { call, urls } = rig({ holds: [], reread: json(batch('running')) });
        const out = await call({ budgetSeconds: 2 });
        expect(out.structuredContent).toMatchObject({ result: 'timeout', batchId: BATCH });
        expect(out.structuredContent).not.toHaveProperty('verdict');
        expect(urls).toEqual([]);
        expect(JSON.stringify(out.content)).not.toMatch(/after \d+s/);
    });

    it('maps standing onto the outcomes of bellows batch wait, verdict by verdict, and the exit codes they own', async () => {
        const seen: Record<string, string | undefined> = {};
        for (const [verdict, expected] of Object.entries(CLI_SETTLED_OUTCOME)) {
            const { call } = rig({
                holds: [{ spend: 1, outcome: settle('terminal', batch(verdict)) }],
                reread: json(batch(verdict)),
            });
            // The CLI keeps watching running / inconclusive / draft: the tests above pin what this tool does instead.
            if (expected === null) continue;
            const out = await call();
            seen[verdict] = out.structuredContent?.result;
            expect(seen[verdict], verdict).toBe(expected);
            expect(CLI_EXIT_CODE[expected as keyof typeof CLI_EXIT_CODE], verdict).toBeDefined();
        }
        expect(seen).toEqual({
            succeeded: 'succeeded',
            failed: 'failed',
            cancelled: 'cancelled',
            needs_attention: 'needs_attention',
        });
        const spent = rig({
            holds: [{ spend: 42, outcome: settle('timeout', batch('running')) }],
            reread: json(batch('running')),
        });
        expect((await spent.call()).structuredContent?.result).toBe('timeout');
        expect(CLI_EXIT_CODE.timeout).toBe(3);
    });

    it.each(['cancelled', 'expired'])(
        'names a %s fence as cancelled, like the CLI, and carries the fence',
        async (fence) => {
            const { call } = rig({
                holds: [{ spend: 1, outcome: settle('terminal', batch('cancelled')) }],
                reread: json(batch('cancelled', {}, { fence })),
            });
            const out = await call();
            expect(out.structuredContent).toMatchObject({ result: 'cancelled', verdict: 'cancelled', fence });
        }
    );

    it('answers needs_attention with the attention list and verification failures of the re-read', async () => {
        const attention = [{ key: 'a', stage: 'one', waitReason: 'pr_review', pr: 'https://example.test/pr/1' }];
        const failures = [{ stage: 'one', state: 'failed', detail: 'tests red', headSha: 'abc' }];
        const { call, holdsAt } = rig({
            holds: [{ spend: 1, outcome: settle('parked', batch('running')) }],
            reread: json(batch('needs_attention', {}, { attention, verificationFailures: failures })),
        });
        const out = await call();
        expect(out.isError).toBeUndefined();
        expect(out.structuredContent).toMatchObject({
            result: 'needs_attention',
            verdict: 'needs_attention',
            attention,
            verificationFailures: failures,
        });
        expect(holdsAt).toHaveLength(1);
    });

    it('keeps waiting when the re-read shows the batch moving again, and settles on the next hold', async () => {
        const { call, holdsAt } = rig({
            holds: [
                { spend: 1, outcome: settle('terminal', batch('succeeded')) },
                { spend: 1, outcome: settle('terminal', batch('failed')) },
            ],
            reread: [json(batch('running')), json(batch('failed'))],
        });
        const out = await call();
        expect(out.structuredContent).toMatchObject({ result: 'failed', verdict: 'failed' });
        expect(holdsAt).toHaveLength(2);
    });

    it('ends inconclusive when the board keeps answering settled over a standing that is not, rather than spinning', async () => {
        const { call, holdsAt } = rig({
            holds: [
                { spend: 0, outcome: settle('parked', batch('running')) },
                { spend: 0, outcome: settle('parked', batch('running')) },
                { spend: 0, outcome: settle('parked', batch('running')) },
            ],
            reread: json(batch('running')),
        });
        const out = await call();
        expect(out.isError).toBe(true);
        expect(out.structuredContent).toMatchObject({ outcome: 'inconclusive' });
        expect(holdsAt.length).toBeLessThanOrEqual(2);
    });

    it('ends inconclusive when the re-read standing is inconclusive: no verdict is claimed', async () => {
        const { call } = rig({
            holds: [{ spend: 1, outcome: settle('terminal', batch('succeeded')) }],
            reread: json(batch('inconclusive')),
        });
        const out = await call();
        expect(out.isError).toBe(true);
        expect(out.structuredContent).toMatchObject({ outcome: 'inconclusive' });
        expect(out.structuredContent).not.toHaveProperty('result');
    });

    it('ends inconclusive when the re-read cannot be confirmed, whatever the poll said', async () => {
        const { call } = rig({
            holds: [{ spend: 1, outcome: settle('terminal', batch('succeeded')) }],
            reread: { kind: 'inconclusive', reason: 'transport' },
        });
        const out = await call();
        expect(out.isError).toBe(true);
        expect(out.structuredContent).toMatchObject({ outcome: 'inconclusive' });
    });

    it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
        'a verdict of %s is no verdict: the answer is inconclusive',
        async (verdict) => {
            const { call } = rig({
                holds: [{ spend: 1, outcome: settle('terminal', batch('succeeded')) }],
                reread: json(batch(verdict)),
            });
            const out = await call();
            expect(out.isError).toBe(true);
            expect(out.structuredContent).toMatchObject({ outcome: 'inconclusive' });
        }
    );

    it('refuses a draft with the board code and holds once', async () => {
        const { call, holdsAt } = rig({
            holds: [
                {
                    spend: 0,
                    outcome: json(
                        { error: 'This batch is still a draft; start it first', code: 'BATCH_NOT_STARTED' },
                        409
                    ),
                },
            ],
            reread: json(batch('draft')),
        });
        const out = await call();
        expect(out.isError).toBe(true);
        expect(out.structuredContent).toMatchObject({ outcome: 'refused', code: 'BATCH_NOT_STARTED' });
        expect(holdsAt).toHaveLength(1);
    });

    it('a poll that cannot be confirmed (a replica lost mid-wait) is inconclusive, never a batch verdict', async () => {
        const { call } = rig({
            holds: [{ spend: 1, outcome: { kind: 'inconclusive', reason: 'transport' } }],
            reread: json(batch('succeeded')),
        });
        const out = await call();
        expect(out.isError).toBe(true);
        expect(out.structuredContent).toMatchObject({ outcome: 'inconclusive' });
    });

    it('reports progress between holds, only to a client that sent a token, strictly increasing', async () => {
        const holds = [
            { spend: 10, outcome: settle('timeout', batch('running')) },
            { spend: 0, outcome: settle('timeout', batch('running')) },
            { spend: 10, outcome: settle('timeout', batch('running')) },
            { spend: 5, outcome: settle('terminal', batch('succeeded')) },
        ];
        const withToken = rig({ holds: [...holds], reread: json(batch('succeeded')) });
        await withToken.call({}, { token: 'p1' });
        const progress = withToken.notify.mock.calls.map(
            (c) => (c as unknown as [{ params: { progress: number } }])[0].params.progress
        );
        expect(progress.length).toBeGreaterThan(0);
        expect(progress).toEqual([...progress].sort((a, b) => a - b));
        expect(new Set(progress).size).toBe(progress.length);
        const without = rig({ holds: [...holds], reread: json(batch('succeeded')) });
        await without.call();
        expect(without.notify).not.toHaveBeenCalled();
    });

    it('stops when the client leaves: no further hold, no verdict', async () => {
        const controller = new AbortController();
        const { call, holdsAt } = rig({
            holds: [
                {
                    spend: 1,
                    outcome: (_url, signal) => {
                        controller.abort();
                        return signal?.aborted
                            ? { kind: 'inconclusive', reason: 'aborted' }
                            : settle('timeout', batch('running'));
                    },
                },
            ],
            reread: json(batch('succeeded')),
        });
        const out = await call({}, { signal: controller.signal });
        expect(out.isError).toBe(true);
        expect(out.structuredContent).toMatchObject({ outcome: 'inconclusive' });
        expect(holdsAt).toHaveLength(1);
    });
});
