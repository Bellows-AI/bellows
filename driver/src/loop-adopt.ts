import { raceStep } from './loop-attempt.js';
import { isAgentless } from './loop-agentless.js';
import { releaseAbandonedAdoption } from './loop-fence.js';
import { type AdoptedRecord, type AttemptCtx, type SetupConclusion, STOOD_DOWN } from './loop-types.js';
import { AdoptionBlocked, type AdoptedRun, type LiveRun, type Read } from './runner.js';
import { awaitFirstContact, controlTokenOf } from './supervised-steps.js';
import { SUPERVISOR_ENV, SUPERVISOR_REBIND_DELIVERY_MS } from './supervisor-contract.js';

/**
 * Adopts the finished runner an earlier claim left behind (issue #792) — before the sync, which
 * would rewrite the tree that run left. A read that fails is no verdict: the attempt is left to its
 * lease, and the next claim adopts what survived. The earlier attempt is recorded as an interruption
 * under this claim's lease, best-effort (`recordAdopted`): the step answers it as data and
 * performs nothing, and the verdict does not wait on it.
 */
export async function adoptStep(
    ctx: AttemptCtx,
    { retaken = false }: { retaken?: boolean } = {}
): Promise<SetupConclusion | AdoptedRecord | null> {
    const { rt, job, state } = ctx;
    if (isAgentless(job)) return null;
    const adopting = rt.runner.adopt(job, state.signal);
    let adoptedOut: { value: AdoptedRun | LiveRun | null } | null;
    try {
        adoptedOut = await raceStep(state.signal, adopting);
    } catch (e) {
        // A read run that could not be secured (issue #821), or an earlier run that could not be read at
        // all, is no reason to run afresh over its tree: an unconfirmed read never licenses the sweep.
        const why =
            e instanceof AdoptionBlocked ? 'could not adopt the finished runner' : 'could not read an earlier runner';
        return { halt: 'leave', log: `${why}, leaving it to the lease: ${(e as Error).message}` };
    }
    if (adoptedOut === null) {
        releaseAbandonedAdoption(rt, job, adopting);
        return STOOD_DOWN;
    }
    const run = adoptedOut.value;
    if (!run) return null;
    if ('live' in run) {
        if (!retaken) return takeOver(ctx, run);
        // The group answered live again after it was found finished: not a third try, the lease decides.
        state.keepGroup = true;
        run.forget();
        return { halt: 'leave', log: 'the earlier group answered live again after it ended, leaving it to the lease' };
    }
    ctx.adopted = run;
    ctx.fenced = true;
    const reason = `adopted the finished runner of claim ${run.claimSeq}, whose driver was lost`;
    rt.log(`job ${job.id}: ${reason}`);
    return { record: 'interruption', reason, claimSeq: run.claimSeq };
}

/** Records the earlier claim's interruption under this claim's lease: durable, best-effort, no ending. */
export async function recordAdopted(ctx: AttemptCtx, { reason, claimSeq }: AdoptedRecord): Promise<void> {
    const { rt, job } = ctx;
    await rt.board
        .interrupt(job, { reason, release: false, claimSeq })
        .catch((e: Error) => rt.log(`job ${job.id}: could not record the adopted interruption: ${e.message}`));
}

/** The wait for the rebound supervisor ended because the earlier group is confirmed finished (#928). */
class EarlierGroupEnded extends Error {}

/**
 * Takes over the agent a lost driver left RUNNING (issue #829): the supervisor's binding is rewritten
 * to this claim, and only a first poll of the new endpoint within `SUPERVISOR_REBIND_DELIVERY_MS` proves it
 * took, or the earlier group is confirmed finished meanwhile (`supervisorServing`: it stopped serving, so it will
 * never poll the new endpoint), when the claim adopts it once more as a finished runner. Until then the attempt owns nothing (`groupLease` unset, `keepGroup` set), so every way out of it
 * leaves the group to the next claim. No sync, setup or go order follows: the run carries on.
 */
async function takeOver(ctx: AttemptCtx, run: LiveRun): Promise<SetupConclusion | AdoptedRecord | null> {
    const { rt, job, state } = ctx;
    const leave = (why: string): SetupConclusion => ({
        halt: 'leave',
        log: `${why}, leaving it to the lease`,
    });
    const gates = rt.gates;
    if (!gates) return leave('could not take over the running agent: no run-control endpoint to deliver the claim to');
    ctx.takeover = run;
    state.keepGroup = true;
    try {
        const binding = {
            claimSeq: job.claimSeq,
            url: job.supervisorEnv?.[SUPERVISOR_ENV.controlUrl] ?? '',
            token: controlTokenOf(job),
            agentToken: job.supervisorEnv?.[SUPERVISOR_ENV.agentToken] ?? '',
            exportToken: job.supervisorEnv?.[SUPERVISOR_ENV.exportToken] ?? '',
        };
        const rebound = await raceStep(state.signal, rt.runner.rebind(run.prior, binding, state.signal));
        if (rebound === null) return STOOD_DOWN;
    } catch (e) {
        return leave(`could not rebind the running agent: ${(e as Error).message}`);
    }
    let contacted: boolean;
    try {
        contacted = await awaitFirstContact({ sink: { contacted: (t) => gates.server.controlPolled(t) } }, job, {
            sleep: rt.sleep,
            signal: state.signal,
            ms: SUPERVISOR_REBIND_DELIVERY_MS,
            probe: async (bound) => {
                // A read that threw proves nothing either: keep waiting.
                const serving = await rt.runner
                    .supervisorServing(run.prior, bound)
                    .catch((): Read<boolean> => ({ kind: 'inconclusive', reason: 'the probe failed' }));
                // Only a confirmed end shortens the wait: an unconfirmed read keeps waiting for the bound.
                if (serving.kind === 'absent' || (serving.kind === 'value' && !serving.value))
                    throw new EarlierGroupEnded('the earlier supervisor stopped serving');
            },
        });
    } catch (e) {
        if (state.signal.aborted) return STOOD_DOWN;
        if (e instanceof EarlierGroupEnded) {
            // Its end is read afresh by the adoption, which is never told what this probe saw.
            rt.log(
                `job ${job.id}: the earlier group ended before the rebind reached it, adopting it as a finished runner`
            );
            run.forget();
            delete ctx.takeover;
            state.keepGroup = false;
            return adoptStep(ctx, { retaken: true });
        }
        return leave(`could not reach the running agent: ${(e as Error).message}`);
    }
    if (state.signal.aborted) return STOOD_DOWN;
    if (!contacted) return leave('the running agent did not poll the new endpoint');
    job.groupLease = run.prior.leaseToken;
    ctx.session = run.session ? { id: run.session, resume: true } : null;
    ctx.fenced = true;
    state.keepGroup = false;
    // The agent runs: every exit before `launchRun` retains, stops or kills it as a launched attempt's.
    state.launched = true;
    const reason = `took over the running agent of claim ${run.claimSeq}, whose driver was lost`;
    rt.log(`job ${job.id}: ${reason}`);
    return { record: 'interruption', reason, claimSeq: run.claimSeq };
}
