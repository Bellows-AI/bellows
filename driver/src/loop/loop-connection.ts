import type { BoardJob } from '../board/board.js';
import { withBoardRetry } from '../board/board-retry.js';
import type { ConnectionRelay } from '../connection-control.js';
import { applyHeartbeatVerdict, down, type JobState } from './loop-attempt.js';
import type { LoopRuntime } from './loop-types.js';

/**
 * How long a relayed ask retries a board that does not answer. Inside the helper's request timeout
 * (`connection-ask.cjs`) and its deadline, which retry the route themselves: the board's silence is
 * never a verdict.
 */
export const CONNECTION_ASK_BUDGET_MS = 8_000;

/**
 * The relay one attempt's agent token asks for a connection through. The board decides: `bound`
 * and `unavailable` change nothing here. `waiting` records the requirement on the attempt and stops the
 * agent exactly as a heartbeat carrying `requirementWait` would (`applyHeartbeatVerdict`), so the ask and
 * an adopter's heartbeat are one code path; the run's end then hands the attempt back as a requirement wait.
 * A lost lease or a removed thread is the attempt's end, as everywhere.
 */
export function createConnectionRelay(rt: LoopRuntime, job: BoardJob, state: JobState): ConnectionRelay {
    return {
        async require(provider, target) {
            if (state.phase === 'ended' || (down(state) && state.ending?.kind !== 'requirement')) return 'gone';
            const verdict = await withBoardRetry(
                rt,
                `job ${job.id}: the ${provider} connection ask was not accepted`,
                () => rt.board.requireConnection(job, provider, target),
                { budgetMs: CONNECTION_ASK_BUDGET_MS }
            );
            if (verdict === 'lost' || verdict === 'removed') {
                await applyHeartbeatVerdict(rt, job, state, verdict);
                return 'gone';
            }
            if (verdict === 'waiting') {
                state.requirement ??= { provider };
                state.requirement.provider ??= provider;
                await applyHeartbeatVerdict(rt, job, state, {
                    result: 'held',
                    cancelRequested: false,
                    requirementWait: true,
                });
            }
            return verdict;
        },
    };
}

/** Opens the connection route on an attempt's control token: every attempt with an endpoint has it. */
export function attachConnection(ctx: { rt: LoopRuntime; job: BoardJob; state: JobState }, token: string): void {
    const { rt, job, state } = ctx;
    rt.gates?.server.attachConnection(token, createConnectionRelay(rt, job, state));
}
