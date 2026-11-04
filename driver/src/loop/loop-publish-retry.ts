/**
 * The publish push itself and its retry (BEL-253), shared by the end-of-run publish
 * (`loop-post-run.ts`) and the agent's draft publish (`loop-publish.ts`). Its own module because
 * `loop-publish.ts` cannot import `loop-verdict.ts` without an import cycle through `loop-gates.ts`.
 */

import type { BoardJob } from '../board/board.js';
import { type JobState, raceStep } from './loop-attempt.js';
import { askGithubToken } from './loop-github.js';
import { prOperationRecorder } from './loop-pr-operation.js';
import { type LoopRuntime, STOOD_DOWN } from './loop-types.js';
import { type PublishOptions, type PublishResult, publishFailed, publishRetryable } from '../publish/publish.js';
import { stepLost } from '../step-control.js';

/**
 * Pushes the branch and opens the PR. A lost supervisor (`stepLost`) is thrown, never a failed publish:
 * the caller hands the attempt back as an interruption (#925). Deliberately NOT raced against the stand-down and not
 * abortable: a push already in flight is not a thing the driver can take back, and half a push is
 * worse than a fenced one. The caller fences before asking for the token instead (issue #472).
 */
export async function publishBranch(
    rt: LoopRuntime,
    job: BoardJob,
    githubToken: string | null,
    options?: PublishOptions
): Promise<PublishResult> {
    return rt.runner
        .publishGit(job, githubToken ?? undefined, { ...options, recordPrOperation: prOperationRecorder(rt, job) })
        .catch((e: Error) => {
            if (stepLost(e)) throw e;
            return publishFailed(`the publish threw: ${e.message}`, 'unknown');
        });
}

/** How many times one publish asks for a token and pushes (BEL-253). */
export const PUBLISH_TRIES = 3;
const PUBLISH_FIRST_BACKOFF_MS = 2000;
/** The wait before the second and third try. */
export const PUBLISH_BACKOFF_MS = [PUBLISH_FIRST_BACKOFF_MS, PUBLISH_FIRST_BACKOFF_MS * 2] as const;

/**
 * `publishBranch` with a NEW token ask per try, retried while `publishRetryable` says a fresh token or a
 * moment's wait may land it (BEL-253). `down` fences before every retry's ask and between each ask and its
 * push, as the single try always did (issue #472); the backoff is cut short by a stand-down. `stepLost` propagates.
 */
export async function publishWithRetry(
    ctx: { rt: LoopRuntime; job: BoardJob; state: JobState },
    publish: { what: string; options: PublishOptions | undefined },
    down: () => boolean | Promise<boolean>
): Promise<PublishResult | typeof STOOD_DOWN> {
    const { rt, job, state } = ctx;
    for (let n = 1; ; n++) {
        if (n > 1 && (await down())) return STOOD_DOWN;
        const token = await askGithubToken(rt, job, publish.what);
        if (await down()) return STOOD_DOWN;
        const result = await publishBranch(rt, job, token, publish.options);
        if (n === PUBLISH_TRIES || !publishRetryable(result, token === null)) return result;
        const wait = PUBLISH_BACKOFF_MS[n - 1] ?? 0;
        rt.log(
            `job ${job.id}: ${publish.what} failed (try ${n} of ${PUBLISH_TRIES}): ${result.reason} — asking for a new GitHub token and retrying in ${wait} ms`
        );
        await raceStep(state.signal, rt.sleep(wait));
    }
}
