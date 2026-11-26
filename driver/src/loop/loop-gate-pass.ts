import type { DeadService } from '../runner.js';
import {
    type GateFailure,
    type GatePassSource,
    type GateReport,
    type GateSession,
    probeDeadServices,
    runVerdictGates,
    sizeGateForVerify,
} from './loop-gates.js';
import { noChangeSkip } from './loop-no-change.js';
import { restartDeadServices } from './loop-services.js';
import type { AttemptCtx } from './loop-types.js';
import { STOOD_DOWN } from './loop-types.js';
import { fitReport } from './gate-settled.js';

/** What one pass over the declared gates found: the failed gate, the dead services, or why it skipped. */
export interface GatesPhase {
    failure: GateFailure | null;
    deadServices: DeadService[];
    gatesSkipped: string | null;
    /** The gates were skipped because the task produced no change. */
    noChange?: boolean;
    /** The services found dead before the gates and restarted for them: noted, not faults. */
    recoveredServices: DeadService[];
    /** The gates list as the board was last told it; empty when no declared gate ran. */
    reports: GateReport[];
}

/**
 * The one body of a pass over the declared gates, shared by the close-time pass (`runGatesPhase`) and the agent's
 * finish pass (`loop-finish.ts`): the no-change skip, the gate container sized for verify, dead services restarted
 * first, the gates (reusing a covering record), and the services probed again after a failure.
 */
export async function runGatePass(
    ctx: AttemptCtx,
    gateSession: GateSession,
    pass: { source: GatePassSource; treeAfter: string | null }
): Promise<GatesPhase> {
    const { rt, job, state } = ctx;
    // A task that changed nothing has nothing for the gates to judge.
    const unchanged = await noChangeSkip({ ...ctx, gateSession });
    if (unchanged) return unchanged;
    // A gate against a dead service fails on an environment the agent cannot fix, and a
    // failed gate is what the agent is sent back for. The
    // services are stateless fixtures, so a dead one is restarted first; only a restart that
    // cannot bring the fleet back is the run's fault.
    await sizeGateForVerify(rt, job);
    const deadBefore = await probeDeadServices(rt, job);
    let recoveredServices: DeadService[] = [];
    if (deadBefore.length > 0) {
        const restartFailure = await restartDeadServices(rt, job, state.signal, deadBefore);
        // A stand-down during the restart runs no gates; the caller's fence settles the attempt.
        if (restartFailure === STOOD_DOWN)
            return { failure: null, deadServices: [], gatesSkipped: null, recoveredServices, reports: [] };
        if (restartFailure !== null) {
            const deadServices = deadBefore.map((dead) => ({ ...dead, restartFailure }));
            return { failure: null, deadServices, gatesSkipped: null, recoveredServices, reports: [] };
        }
        recoveredServices = deadBefore;
    }
    const failure = await runVerdictGates(rt, job, gateSession, { state, ...pass });
    // A service OOM-killed by the suite fails the gate for a reason the agent cannot fix: re-probe.
    const deadAfter = failure ? await probeDeadServices(rt, job) : [];
    return {
        failure,
        deadServices: deadAfter,
        gatesSkipped: null,
        recoveredServices,
        // The checkpoint keeps what the board was told: the list cut to its body.
        reports: fitReport(gateSession.lastReports ?? []),
    };
}
