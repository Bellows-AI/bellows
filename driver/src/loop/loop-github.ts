import type { BoardJob } from '../board/board.js';
import type { GateTokenRelay } from '../gate-token-control.js';
import { down, type JobState } from './loop-attempt.js';
import type { LoopRuntime } from './loop-types.js';

/**
 * How long one gate token ask retries a board that does not answer, over every try. Inside the supervisor's
 * per-ask deadline (`SUPERVISOR_GATE_ASK_MS`), which is inside the helper's: each layer answers before the
 * layer above gives up.
 */
export const GATE_TOKEN_BUDGET_MS = 30_000;

/**
 * A GitHub token for one supervised step that reaches GitHub (`what` names it in the log), asked of
 * the board right before it starts (docs/connections.md). Null runs it without one — no App
 * installation, a refused attempt or a failed ask — which a public repository survives.
 */
export async function askGithubToken(rt: LoopRuntime, job: BoardJob, what: string): Promise<string | null> {
    const token = await rt.board.githubCredential(job);
    if (!token) rt.log(`job ${job.id}: the board issued no GitHub token for ${what} — running it without one`);
    return token;
}

/**
 * The relay a running gate step's token ask goes through (`POST /gate-token`): the board's grant under the
 * attempt's lease, `gone` once the attempt is over or its lease lost — also when that happens during the call.
 * An ask the board did not answer inside the budget stays `unanswered`, which is no verdict.
 */
export function createGateTokenRelay(rt: LoopRuntime, job: BoardJob, state: JobState): GateTokenRelay {
    const over = () => state.phase === 'ended' || down(state);
    return {
        async token(signal) {
            if (over()) return 'gone';
            const grant = await rt.board.githubGrant(
                job,
                AbortSignal.any([state.signal, signal, AbortSignal.timeout(GATE_TOKEN_BUDGET_MS)])
            );
            return over() ? 'gone' : grant;
        },
    };
}
