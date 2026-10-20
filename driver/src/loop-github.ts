import type { BoardJob } from './board.js';
import { claimRestoresTree } from './claim.js';
import type { LoopRuntime } from './loop-types.js';
import type { SyncTurn } from './sync-queue.js';

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

/**
 * The token a starting claim's fetch reaches GitHub with; a restore, a reviewer's tree and a repo-less
 * job fetch nothing. A throwing ask hands the granted turn on, since no sync will hold it.
 */
export async function checkoutToken(rt: LoopRuntime, job: BoardJob, turn: SyncTurn): Promise<string | undefined> {
    if (!job.repo || job.reviewRun || claimRestoresTree(job)) return undefined;
    try {
        return (await askGithubToken(rt, job, 'the checkout sync')) ?? undefined;
    } catch (e) {
        turn.release(Promise.resolve());
        throw e;
    }
}
