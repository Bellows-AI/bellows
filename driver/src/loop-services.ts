import type { BoardJob } from './board.js';
import { raceStep } from './loop-attempt.js';
import type { AttemptCtx, LoopRuntime, SetupConclusion } from './loop-types.js';
import { STOOD_DOWN } from './loop-types.js';
import { type DeadService, Inconclusive, type RunOutcome } from './runner.js';
import { ServicesNotRunning } from './service-restart.js';
import { stepLost } from './step-control.js';

/** Tears the attempt's services down, saying so when it cannot. */
const release = (rt: LoopRuntime, job: BoardJob): Promise<void> =>
    rt.runner
        .releaseServices(job)
        .catch((e: Error) => rt.log(`job ${job.id}: could not tear down the services: ${e.message}`));

/**
 * The setup step that starts the attempt's `.bellows.yaml` services, on both executors, before the
 * gate environment and its `environment.setup` (which may migrate or seed one), and so before the
 * runner, which starts none. Raced against the stand-down: a start the attempt stopped
 * waiting on is torn down once it settles, so a Stop leaks no fleet. An author's refusal fails the
 * run with the verdict a refused start always had; a daemon or cluster refusal is handed back as an
 * interruption carrying its reason.
 */
export async function startServicesStep(ctx: AttemptCtx): Promise<SetupConclusion | null> {
    const { rt, job, state } = ctx;
    const starting = rt.runner.startServices(job, state.signal);
    let raced: { value: RunOutcome | null } | null;
    try {
        raced = await raceStep(state.signal, starting);
    } catch (e) {
        // A fleet that never ran is the declared services' verdict, as the pre-gate restart's is:
        // the run fails `services` before any setup or agent, and the fleet is released.
        if (e instanceof ServicesNotRunning) {
            ctx.servicesStarted = true;
            return {
                halt: 'fault',
                log: `its services never ran, failing: ${e.message}`,
                verdict: {
                    status: 'failed',
                    exitCode: null,
                    output: `[driver] the declared services did not come up before the run: ${e.message}`,
                    failureKind: 'services',
                },
            };
        }
        // An infrastructure refusal: the start tore its partial fleet down itself.
        return { halt: 'interrupt', reason: `could not start the services: ${(e as Error).message}` };
    }
    if (raced === null) {
        void starting.catch(() => null).then(() => release(rt, job));
        return STOOD_DOWN;
    }
    ctx.servicesStarted = true;
    const refused = raced.value;
    if (!refused) return null;
    return {
        halt: 'fault',
        log: 'its services could not be started, failing',
        verdict: { status: 'failed', exitCode: refused.exitCode, output: refused.output, failureKind: 'runner_error' },
    };
}

/** A setup that ended after the services step: they go with it. Answers `STOOD_DOWN` for `runPhases`. */
export async function releaseStartedServices(ctx: AttemptCtx): Promise<typeof STOOD_DOWN> {
    if (ctx.servicesStarted) await release(ctx.rt, ctx.job);
    return STOOD_DOWN;
}

/** Runs the setup phase, releasing services it started even when a conclusion itself throws. */
export async function releasingOnThrow<T>(ctx: AttemptCtx, phases: (ctx: AttemptCtx) => Promise<T>): Promise<T> {
    try {
        return await phases(ctx);
    } catch (e) {
        await releaseStartedServices(ctx);
        throw e;
    }
}

/**
 * A failure of the services' machinery rather than of the services (issue #773, R2-1): a lost
 * supervisor (`stepLost`) or a pod or daemon that could not be read (`Inconclusive`). The attempt is
 * interrupted for it, never failed `services`.
 */
export const servicesLost = (e: unknown): boolean => stepLost(e) || e instanceof Inconclusive;

/**
 * Restarts the fleet `dead` was found in; null when it is back, else why it is not. Raced against
 * the attempt's stand-down, which also aborts the restart itself: a Stop or lost lease must not
 * wait out its budget, nor see services recreated after the kill took them. A failure of the
 * machinery (`servicesLost`) is thrown, never answered as the services' own.
 */
export async function restartDeadServices(
    rt: LoopRuntime,
    job: BoardJob,
    signal: AbortSignal,
    dead: readonly DeadService[]
): Promise<string | null | typeof STOOD_DOWN> {
    rt.log(
        `job ${job.id}: ${dead.map(({ name }) => `service "${name}"`).join(', ')} dead before the gates, restarting`
    );
    try {
        return (await raceStep(signal, rt.runner.restartServices(job, signal))) === null ? STOOD_DOWN : null;
    } catch (e) {
        rt.log(`job ${job.id}: the service restart failed: ${(e as Error).message}`);
        if (servicesLost(e)) throw e;
        return (e as Error).message;
    }
}
