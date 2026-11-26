import type { BoardJob } from '../board/board.js';
import { type GateTokenRelay, repoForgeHost } from '../gate-token-control.js';
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
 * installation, a refused attempt or a failed ask — which a public repository survives. A GitLab job's
 * token never rides a step's env: it is null without a board call, and the step asks through its mailbox.
 */
export async function askGithubToken(rt: LoopRuntime, job: BoardJob, what: string): Promise<string | null> {
    if (job.repo && job.repo.forge !== 'github') return null;
    const token = await rt.board.forgeCredential(job);
    if (!token) rt.log(`job ${job.id}: the board issued no GitHub token for ${what} — running it without one`);
    return token;
}

/**
 * The relay a running step's token ask goes through (`POST /gate-token`): the board's grant under the
 * attempt's lease for the host the job's repository is on, `gone` for any other host, and once the attempt
 * is over or its lease lost — also when that happens during the call. An ask the board did not answer inside
 * the budget stays `unanswered`, and a starter's grant waited on stays `waiting`: neither is a verdict.
 */
export function createGateTokenRelay(rt: LoopRuntime, job: BoardJob, state: JobState): GateTokenRelay {
    const over = () => state.phase === 'ended' || down(state);
    const repoHost = repoForgeHost(job);
    return {
        async token(host, signal) {
            if (over() || host !== repoHost) return 'gone';
            const grant = await rt.board.forgeGrant(
                job,
                AbortSignal.any([state.signal, signal, AbortSignal.timeout(GATE_TOKEN_BUDGET_MS)])
            );
            return over() ? 'gone' : grant;
        },
    };
}
