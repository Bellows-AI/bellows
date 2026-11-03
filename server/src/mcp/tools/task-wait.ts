import { z } from 'zod';
import {
    boundedWait,
    effectiveBudgetSeconds,
    WAIT_BUDGET_DEFAULT_S,
    WAIT_BUDGET_MAX_S,
    WAIT_HEADROOM_S,
    type Hold,
} from '../bounded-wait.js';
import { inconclusive, judge, success } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';
import type { RunState } from './run-state.js';
import { jobPath } from './runs.js';
import { headOf, TaskIdInput, TaskResultSchema, Thread, taskResultOf } from './task-detail.js';

/** The board's settle long-poll (`GET /api/jobs/:id?waitFor=terminal`): why it returned, and the head it looked at. */
const Settle = z.object({
    result: z.enum(['terminal', 'parked', 'timeout']),
    rootJobId: z.string(),
    headJobId: z.string(),
    headStatus: z.string(),
    waitReason: z
        .string()
        .nullish()
        .transform((v) => v ?? null),
});
type Settle = z.infer<typeof Settle>;

export const WAIT_RESULTS = ['succeeded', 'failed', 'cancelled', 'needs_attention', 'timeout'] as const;
type WaitResult = (typeof WAIT_RESULTS)[number];

/**
 * What a settled head's state is called to the caller; the same table as `bellows job wait` (`cli/src/run.ts`,
 * `terminalOutcome`), pinned by `mcp.bounded-wait.test.ts`. A head that is still `pending` or `running` was not
 * settled when it was re-read, so the answer is `timeout` (call again), never `failed`. `unreachable` and
 * `inconclusive` are not results: they are an inconclusive call.
 */
export const WAIT_RESULT_OF_STATE: Record<RunState, WaitResult | null> = {
    pending: 'timeout',
    running: 'timeout',
    succeeded: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
    needs_attention: 'needs_attention',
    unreachable: null,
    inconclusive: null,
};

export const waitTask = defineTool({
    name: 'wait_task',
    description: `Wait, for at most budgetSeconds (default ${WAIT_BUDGET_DEFAULT_S}, never more than ${WAIT_BUDGET_MAX_S}), until a task's head run settles, then answer with its verified result: \`result\` is succeeded, failed (failed or dead), cancelled (stopped), needs_attention (an open question or integration requirement, or parked on a workflow wait) or timeout. A timeout is not a failure: the task is still going, or was never claimed; call wait_task again. A read that cannot be confirmed (including a replica lost mid-wait) is an inconclusive call, never a failed task; call again. About ${WAIT_HEADROOM_S} seconds of the budget are kept for the answer. Progress is reported between holds when the client sent a progress token.`,
    scope: 'factory:read',
    routes: [
        ['GET', '/api/jobs/:id'],
        ['GET', '/api/jobs/:id/thread'],
    ],
    annotations: READ_ONLY,
    input: TaskIdInput.extend({
        budgetSeconds: z
            .number()
            .positive()
            .optional()
            .describe(
                `Seconds to wait, default ${WAIT_BUDGET_DEFAULT_S}; a larger value is cut to ${WAIT_BUDGET_MAX_S}.`
            ),
    }),
    output: TaskResultSchema.partial().extend({
        result: z.enum(WAIT_RESULTS),
        taskId: z.string(),
        budgetSeconds: z.number().describe('The budget that applied, after the maximum.'),
        waitReason: z.string().nullable().optional(),
    }),
    async run({ taskId, budgetSeconds: requested }, ctx) {
        const budgetSeconds = effectiveBudgetSeconds(requested ?? WAIT_BUDGET_DEFAULT_S);
        let last: Settle | null = null;
        const end = await boundedWait<Settle>({
            budgetSeconds,
            now: ctx.now,
            signal: ctx.signal,
            hold: async (seconds): Promise<Hold<Settle>> => {
                const judged = judge(
                    await ctx.fetch({ method: 'GET', url: `${jobPath(taskId)}?waitFor=terminal&timeout=${seconds}` }),
                    Settle
                );
                if (!judged.ok) return { kind: 'stop', tagged: judged.tagged };
                last = judged.data;
                return judged.data.result === 'timeout' ? { kind: 'open' } : { kind: 'settled', value: judged.data };
            },
            progress: (elapsed, total) =>
                ctx.progress(
                    elapsed,
                    total,
                    `waiting on ${last?.headJobId ?? taskId}: ${last?.headStatus ?? 'unsettled'}`
                ),
        });
        const timeout = (seen: Settle | null) => ({
            outcome: 'ok' as const,
            result: success(
                {
                    result: 'timeout',
                    taskId: seen?.rootJobId ?? taskId,
                    budgetSeconds,
                    ...(seen ? { runId: seen.headJobId, status: seen.headStatus } : {}),
                },
                `${taskId}: still going after ${budgetSeconds}s; call wait_task again`
            ),
        });
        if (end.kind === 'stopped') return end.tagged;
        if (end.kind === 'aborted') {
            return { outcome: 'inconclusive', result: inconclusive('aborted') };
        }
        if (end.kind === 'timeout') return timeout(last);

        // The verdict is the settled head as the board has it now, not the poll's snapshot: a retry or a follow-up
        // between the two reads changes the head.
        const reread = judge(await ctx.fetch({ method: 'GET', url: `${jobPath(taskId)}/thread` }), Thread);
        if (!reread.ok) return reread.tagged;
        const data = taskResultOf(headOf(reread.data.jobs));
        const fromState = WAIT_RESULT_OF_STATE[data.state];
        if (fromState === null) {
            return { outcome: 'inconclusive', result: inconclusive(`the settled head reads ${data.state}`) };
        }
        if (fromState === 'timeout') return timeout(end.value);
        const result: WaitResult = end.value.result === 'parked' ? 'needs_attention' : fromState;
        return {
            outcome: 'ok',
            result: success(
                { ...data, result, budgetSeconds, waitReason: end.value.waitReason },
                `${data.taskId}: ${result} (${data.status})`
            ),
        };
    },
});
