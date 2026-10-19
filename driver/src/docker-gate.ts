import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { gateName } from './docker-group.js';
import type { ExecDocker } from './docker-runner-support.js';
import { networkName } from './services.js';
import { type GateStepRequest, runGateStep, type StepHost } from './supervised-steps.js';
import type { StepResult } from './supervisor-contract.js';

/** What a docker gate run needs of its runner: the daemon, the attempt's group once made, and its step host. */
export interface DockerGateDeps {
    config: DriverConfig;
    execDocker: ExecDocker;
    /** The attempt's step host, its group made on demand for an attempt whose sync made none. */
    host: () => Promise<StepHost>;
    /** The attempt's group as the runner remembers it, once made. */
    group: () => object | undefined;
}

/** The services network each group's gate container joined, so each attempt connects it once. */
const joined = new WeakMap<object, string>();

/**
 * One gate in the attempt's group (issue #773): its gate container runs it. The gate container joins
 * the attempt's services network first, once per attempt, so a gate reaches the declared services
 * by name the way the agent does; an attempt with no services network has nothing to join, and the
 * refused connect is left for the next gate to retry.
 */
export async function runDockerGate(
    deps: DockerGateDeps,
    job: BoardJob,
    gate: GateStepRequest,
    signal?: AbortSignal
): Promise<StepResult> {
    const host = await deps.host();
    const group = deps.group();
    const network = networkName(job);
    if (deps.config.servicesEnabled && group && joined.get(group) !== network) {
        try {
            await deps.execDocker(['network', 'connect', network, gateName(job)]);
            joined.set(group, network);
        } catch {
            // No services network for this attempt — nothing to join.
        }
    }
    return runGateStep(host, job, gate, signal);
}
