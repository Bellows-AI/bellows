import type { BoardJob } from './board.js';
import { type ReviewRun, runReviewSteps } from './review-step.js';
import { type GateStepRequest, runGateStep, type StepHost } from './supervised-steps.js';
import type { StepResult } from './supervisor-contract.js';

/** What a docker gate run needs of its runner: the attempt's step host, its group made on demand. */
export interface DockerGateDeps {
    /** The attempt's step host, its group made on demand for an attempt whose sync made none. */
    host: () => Promise<StepHost>;
}

/**
 * One gate in the attempt's group (issue #773): its gate container runs it, in the network
 * namespace of the group's supervisor, so it reaches the declared services by name on loopback the
 * way the agent does.
 */
export async function runDockerGate(
    deps: DockerGateDeps,
    job: BoardJob,
    gate: GateStepRequest,
    signal?: AbortSignal
): Promise<StepResult> {
    return runGateStep(await deps.host(), job, gate, signal);
}

/** One review in the caller's group (issue #774): its reviewer container runs it, beside the gate container, in the same namespace. */
export async function runDockerReview(deps: DockerGateDeps, run: ReviewRun, signal?: AbortSignal): Promise<StepResult> {
    return runReviewSteps(await deps.host(), run, signal);
}
