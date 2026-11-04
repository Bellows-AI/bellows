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
import type { BOARD_STATUSES } from './run-state.js';
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

export const WAIT_RESULTS = ['succeeded', 'failed', 'cancelled', 'needs_attention', 'timeout'] as const;
type WaitResult = (typeof WAIT_RESULTS)[number];

/**
 * What a settled head's board status is called to the caller: the same table as `bellows job wait` (`cli/src/run.ts`,
 * `terminalOutcome`), pinned by `mcp.bounded-wait.test.ts`. It reads the status alone: an open question or integration
 * requirement does not change it (the answer carries `attention` beside it), and only a board `parked` answer is
 * `needs_attention`. A head still `queued` or `running` is not settled, so the wait goes on with it.
 */
export const WAIT_RESULT_OF_STATUS: Record<(typeof BOARD_STATUSES)[number], WaitResult | null> = {
    queued: null,
    running: null,
    succeeded: 'succeeded',
    failed: 'failed',
    dead: 'failed',
    stopped: 'cancelled',
};

/** A poll that settled, and the head as the thread read it right after. */
interface Settled {
    readonly waitReason: string | null;
    readonly data: ReturnType<typeof taskResultOf>;
    readonly result: WaitResult;
}

export const waitTask = defineTool({
    name: 'wait_task',
    description: `Wait, for at most budgetSeconds (default ${WAIT_BUDGET_DEFAULT_S}, never more than ${WAIT_BUDGET_MAX_S}), until a task's head run settles, then answer with its verified result: \`result\` is succeeded, failed (failed or dead), cancelled (stopped), needs_attention (parked on a workflow wait; an open question or integration requirement does not change the result, it is reported beside it as \`attention\`) or timeout. A timeout is not a failure: the task is still going, or was never claimed; call wait_task again. A read that cannot be confirmed (including a replica lost mid-wait) is an inconclusive call, never a failed task; call again. About ${WAIT_HEADROOM_S} seconds of the budget are kept for the answer. Progress is reported between holds when the client sent a progress token.`,
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
        // Where the task was last seen: the poll that is still waiting, or the head the last re-read found. Every field
        // of a `timeout` answer comes from here, never from a poll that settled on a head that has since moved on.
        const last: { seen: { taskId: string; runId: string; status: string } | null } = { seen: null };
        const end = await boundedWait<Settled>({
            budgetSeconds,
            now: ctx.now,
            signal: ctx.signal,
            hold: async (seconds): Promise<Hold<Settled>> => {
                const polled = judge(
                    await ctx.fetch({ method: 'GET', url: `${jobPath(taskId)}?waitFor=terminal&timeout=${seconds}` }),
                    Settle
                );
                if (!polled.ok) return { kind: 'stop', tagged: polled.tagged };
                const poll = polled.data;
                if (poll.result === 'timeout') {
                    last.seen = { taskId: poll.rootJobId, runId: poll.headJobId, status: poll.headStatus };
                    return { kind: 'open' };
                }
                // The verdict is the head as the board has it now, not the poll's snapshot: a retry or a follow-up
                // between the two reads changes the head, and a head that is not settled is waited on again.
                const reread = judge(await ctx.fetch({ method: 'GET', url: `${jobPath(taskId)}/thread` }), Thread);
                if (!reread.ok) return { kind: 'stop', tagged: reread.tagged };
                const head = headOf(reread.data.jobs);
                last.seen = { taskId: head.rootJobId, runId: head.id, status: head.status };
                if (!Object.hasOwn(WAIT_RESULT_OF_STATUS, head.status)) {
                    return {
                        kind: 'stop',
                        tagged: {
                            outcome: 'inconclusive',
                            result: inconclusive(`the settled head reads ${head.status}`),
                        },
                    };
                }
                // A parked poll is settled whatever the head reads: the board answers it for an open workflow wait even
                // while the head is queued or running, and answering `open` there would re-poll into the same answer
                // without holding. Only a terminal poll whose head has since moved on is waited on again.
                const fromStatus =
                    poll.result === 'parked'
                        ? 'needs_attention'
                        : WAIT_RESULT_OF_STATUS[head.status as keyof typeof WAIT_RESULT_OF_STATUS];
                if (fromStatus === null) return { kind: 'open' };
                return {
                    kind: 'settled',
                    value: { waitReason: poll.waitReason, data: taskResultOf(head), result: fromStatus },
                };
            },
            progress: (elapsed, total) =>
                ctx.progress(
                    elapsed,
                    total,
                    `waiting on ${last.seen?.runId ?? taskId}: ${last.seen?.status ?? 'unsettled'}`
                ),
        });
        if (end.kind === 'stopped') return end.tagged;
        if (end.kind === 'aborted') return { outcome: 'inconclusive', result: inconclusive('aborted') };
        if (end.kind === 'timeout') {
            return {
                outcome: 'ok',
                result: success(
                    {
                        result: 'timeout',
                        taskId: last.seen?.taskId ?? taskId,
                        budgetSeconds,
                        ...(last.seen ? { runId: last.seen.runId, status: last.seen.status } : {}),
                    },
                    `${taskId}: not settled when the wait ended; call wait_task again`
                ),
            };
        }
        const { data, waitReason, result: answer } = end.value;
        return {
            outcome: 'ok',
            result: success(
                { ...data, result: answer, budgetSeconds, waitReason },
                `${data.taskId}: ${answer} (${data.status})`
            ),
        };
    },
});
