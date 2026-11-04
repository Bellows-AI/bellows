import type { BatchVerdict } from '@factory-ai/core';
import { z } from 'zod';
import {
    boundedWait,
    paceMs,
    effectiveBudgetSeconds,
    WAIT_BUDGET_DEFAULT_S,
    WAIT_BUDGET_MAX_S,
    WAIT_HEADROOM_S,
    WAIT_PACE_S,
    type Hold,
} from '../bounded-wait.js';
import { inconclusive, judge, success } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';
import { BatchIdInput, BatchViewSchema, batchPath, StandingSchema } from './batches.js';

/** The board's batch settle long-poll (`GET /api/batches/:id?waitFor=terminal`): why it returned, and the batch it looked at. */
const Settle = z.object({ result: z.enum(['terminal', 'parked', 'timeout']), batch: BatchViewSchema });

export const BATCH_WAIT_RESULTS = ['succeeded', 'failed', 'cancelled', 'needs_attention', 'timeout'] as const;
type BatchWaitResult = (typeof BATCH_WAIT_RESULTS)[number];

/**
 * What a settled standing is called to the caller: the same table as `bellows batch wait` (`SETTLED` in
 * `cli/src/batch-commands.ts`), pinned by `mcp.wait-batch.test.ts`. `null` is not settled: the batch is still moving.
 * An `inconclusive` standing is handled before this table; the tool never turns it into an outcome.
 */
const RESULT_OF_VERDICT: Record<BatchVerdict, Exclude<BatchWaitResult, 'timeout'> | null> = {
    draft: null,
    running: null,
    succeeded: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
    needs_attention: 'needs_attention',
    inconclusive: null,
};

/** A poll that settled, and the batch as it read right after. */
type Settled = {
    readonly view: z.output<typeof BatchViewSchema>;
    readonly result: Exclude<BatchWaitResult, 'timeout'>;
};

export const waitBatch = defineTool({
    name: 'wait_batch',
    description: `Wait, for at most budgetSeconds (default ${WAIT_BUDGET_DEFAULT_S}, never more than ${WAIT_BUDGET_MAX_S}), until a started batch settles, then answer with the board's standing read after the wait: \`result\` is succeeded (CLI exit 0), failed (a task failed, 4), cancelled (cancelled or expired; \`fence\` names which, 5), needs_attention (a task waits on a person or a stage verification failed, 6; \`attention\` and \`verificationFailures\` say which) or timeout (the budget ran out, 3). A timeout is not a failure: the batch is still going; call wait_batch again. Leaving the wait never cancels the batch. A read that cannot be confirmed is an inconclusive call, never a verdict; so is a standing the board marks inconclusive, on the first re-read that shows it (the CLI keeps watching to its timeout); call again. A batch the board calls settled while its standing is still running (a last stage awaiting verification) is waited on, re-read every ${WAIT_PACE_S} seconds, until the budget ends in timeout. About ${WAIT_HEADROOM_S} seconds of the budget are kept for the answer. Progress is reported between holds when the client sent a progress token. A draft has no wait (BATCH_NOT_STARTED).`,
    scope: 'factory:read',
    routes: [['GET', '/api/batches/:id']],
    annotations: READ_ONLY,
    input: BatchIdInput.extend({
        budgetSeconds: z
            .number()
            .positive()
            .optional()
            .describe(
                `Seconds to wait, default ${WAIT_BUDGET_DEFAULT_S}; a larger value is cut to ${WAIT_BUDGET_MAX_S}.`
            ),
    }),
    output: z.object({
        result: z.enum(BATCH_WAIT_RESULTS),
        batchId: z.string(),
        budgetSeconds: z.number().describe('The budget that applied, after the maximum.'),
        status: z.string().optional(),
        version: z.number().int().optional(),
        verdict: StandingSchema.shape.verdict.optional(),
        fence: StandingSchema.shape.fence.optional(),
        attention: StandingSchema.shape.attention.optional(),
        verificationFailures: StandingSchema.shape.verificationFailures.optional(),
    }),
    async run({ batchId, budgetSeconds: requested }, ctx) {
        const budgetSeconds = effectiveBudgetSeconds(requested ?? WAIT_BUDGET_DEFAULT_S);
        // Where the batch was last seen: the poll that is still waiting, or the re-read behind the last settled poll.
        // Every field of a `timeout` answer comes from here, never from a poll that settled on a batch that moved on.
        const last: { seen: { status: string; version: number; verdict: BatchVerdict } | null } = { seen: null };
        const end = await boundedWait<Settled>({
            budgetSeconds,
            now: ctx.now,
            signal: ctx.signal,
            hold: async (seconds): Promise<Hold<Settled>> => {
                const polled = judge(
                    await ctx.fetch({
                        method: 'GET',
                        url: `${batchPath(batchId)}?waitFor=terminal&timeout=${seconds}`,
                    }),
                    Settle
                );
                if (!polled.ok) return { kind: 'stop', tagged: polled.tagged };
                const poll = polled.data;
                if (poll.result === 'timeout') {
                    const seen = poll.batch;
                    last.seen = { status: seen.status, version: seen.version, verdict: seen.standing.verdict };
                    return { kind: 'open' };
                }
                // The verdict is the standing as the board has it now, not the poll's snapshot: a retry or an acceptance
                // between the two reads changes it, and a batch that is not settled is waited on again.
                const reread = judge(await ctx.fetch({ method: 'GET', url: batchPath(batchId) }), BatchViewSchema);
                if (!reread.ok) return { kind: 'stop', tagged: reread.tagged };
                const view = reread.data;
                const { verdict, fence } = view.standing;
                last.seen = { status: view.status, version: view.version, verdict };
                if (verdict === 'inconclusive') {
                    return {
                        kind: 'stop',
                        tagged: {
                            outcome: 'inconclusive',
                            result: inconclusive('the board could not confirm the batch standing'),
                        },
                    };
                }
                // A fence ends the batch whatever else it reads, as `bellows batch wait` names it.
                const result = fence === null ? RESULT_OF_VERDICT[verdict] : 'cancelled';
                if (result !== null) return { kind: 'settled', value: { view, result } };
                // The board said settled and the standing says moving (a race with a retry, or a last stage whose
                // verification has not passed yet: the board parks it at once). The same answer would be re-polled into
                // without holding, so the poll is paced like `bellows batch wait`, never ended and never spun on.
                await ctx.sleep(paceMs(seconds));
                return { kind: 'open' };
            },
            progress: (elapsed, total) =>
                ctx.progress(elapsed, total, `waiting on batch ${batchId}: ${last.seen?.verdict ?? 'unsettled'}`),
        });
        if (end.kind === 'stopped') return end.tagged;
        if (end.kind === 'aborted') return { outcome: 'inconclusive', result: inconclusive('aborted') };
        if (end.kind === 'timeout') {
            return {
                outcome: 'ok',
                result: success(
                    {
                        result: 'timeout',
                        batchId,
                        budgetSeconds,
                        ...(last.seen ? last.seen : {}),
                    },
                    `${batchId}: not settled when the wait ended; call wait_batch again`
                ),
            };
        }
        const { view, result } = end.value;
        return {
            outcome: 'ok',
            result: success(
                {
                    result,
                    batchId,
                    budgetSeconds,
                    status: view.status,
                    version: view.version,
                    verdict: view.standing.verdict,
                    fence: view.standing.fence,
                    attention: view.standing.attention,
                    verificationFailures: view.standing.verificationFailures,
                },
                `${batchId}: ${result} (standing ${view.standing.verdict})`
            ),
        };
    },
});
