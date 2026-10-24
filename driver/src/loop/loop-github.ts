import type { BoardJob } from '../board/board.js';
import type { LoopRuntime } from './loop-types.js';

/**
 * A GitHub token for one supervised step that reaches GitHub, or for a gate environment (`what`
 * names it in the log), asked of the board right before it starts (docs/connections.md). Null runs
 * it without one — no App installation, a refused attempt or a failed ask — which a public
 * repository survives.
 */
export async function askGithubToken(rt: LoopRuntime, job: BoardJob, what: string): Promise<string | null> {
    const token = await rt.board.githubCredential(job);
    if (!token) rt.log(`job ${job.id}: the board issued no GitHub token for ${what} — running it without one`);
    return token;
}
