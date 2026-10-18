import { raceStep } from './loop-attempt.js';
import { isAgentless } from './loop-agentless.js';
import { releaseAbandonedAdoption } from './loop-fence.js';
import { type AttemptCtx, type SetupConclusion, STOOD_DOWN } from './loop-types.js';
import { AdoptionBlocked, type AdoptedRun } from './runner.js';

/**
 * Adopts the finished runner an earlier claim left behind (issue #792) — before the sync, which
 * would rewrite the tree that run left. A read that fails is no verdict: the attempt runs the job
 * itself, and its launch sweeps what is left. The earlier attempt is recorded as an interruption
 * under this claim's lease, best-effort: the verdict does not wait on it.
 */
export async function adoptStep(ctx: AttemptCtx): Promise<SetupConclusion | null> {
    const { rt, job, state } = ctx;
    if (isAgentless(job)) return null;
    const adopting = rt.runner.adopt(job);
    let adoptedOut: { value: AdoptedRun | null } | null;
    try {
        adoptedOut = await raceStep(state.signal, adopting);
    } catch (e) {
        // A read run that could not be secured is no reason to run afresh over its tree (issue #821).
        if (e instanceof AdoptionBlocked)
            return { halt: 'leave', log: `could not adopt the finished runner, leaving it to the lease: ${e.message}` };
        rt.log(`job ${job.id}: could not adopt an earlier runner, running the job: ${(e as Error).message}`);
        return null;
    }
    if (adoptedOut === null) {
        releaseAbandonedAdoption(rt, job, adopting);
        return STOOD_DOWN;
    }
    const run = adoptedOut.value;
    if (!run) return null;
    ctx.adopted = run;
    ctx.fenced = true;
    const reason = `adopted the finished runner of claim ${run.claimSeq}, whose driver was lost`;
    rt.log(`job ${job.id}: ${reason}`);
    await rt.board
        .interrupt(job, { reason, release: false, claimSeq: run.claimSeq })
        .catch((e: Error) => rt.log(`job ${job.id}: could not record the adopted interruption: ${e.message}`));
    return null;
}
