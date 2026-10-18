import type { BoardJob } from './board.js';
import { jobPath } from './k8s-auxspec.js';
import { runnerName } from './k8s-podspec.js';
import { expectOk, HTTP_NOT_FOUND, type K8sDeps } from './k8s-transport.js';
import type { RunOutcome } from './runner.js';
import type { SupervisorReport } from './supervisor-contract.js';
import { infraLossOf, type KillRecord, killMarkOf } from './termination.js';

/**
 * What a Stop (`kill`) leaves for the polls it interrupts. Deleting a Job makes the very next
 * status read answer 404 — indistinguishable from a Job fenced away by hand unless the driver
 * remembers it did the deleting. That is an in-process fact of one driver, so it lives in module state.
 * Why the driver ended a run is not: it is recorded on the runner Job (`recordRunnerKill`).
 */

/** The exit code a killed run resolves with — the SIGKILL status docker's killed container answers. */
export const KILLED_EXIT_CODE = 137;

/** A run a Stop deleted: resolved, as docker's killed container resolves exit 137, never left to the lease. */
export const killedOutcome = (): RunOutcome => ({
    exitCode: KILLED_EXIT_CODE,
    output: '',
    timedOut: false,
    started: true,
});

/** Thrown by a poll whose Job vanished because this driver killed it. */
export class RunnerKilled extends Error {
    constructor(jobName: string) {
        super(`the runner job ${jobName} was killed`);
    }
}

/** Thrown by a poll whose Job vanished under the run without this driver deleting it: an infrastructure loss. */
export class RunnerVanished extends Error {
    constructor(jobName: string) {
        super(`the runner job ${jobName} was deleted before it exited`);
    }
}

/** A run whose runner Job was deleted under it, by `infraLossOf` over what the supervisor reported. */
export function vanishedOutcome(e: RunnerVanished, report: SupervisorReport | null): RunOutcome {
    const timedOut = report?.outcome === 'timed_out';
    const infraLoss = infraLossOf({
        killedByDriver: false,
        timedOut,
        reported: report !== null,
        vanished: e.message,
        unfinalized: null,
    });
    return {
        exitCode: report?.agentExit ?? null,
        output: '',
        timedOut,
        started: true,
        ...(infraLoss ? { infraLoss } : {}),
    };
}

const killedRunners = new Set<string>();

/** The error for a runner Job that read 404: this driver's own kill, or one taken away under the run. */
export function vanishedRunner(name: string): Error {
    return killedRunners.has(name) ? new RunnerKilled(name) : new RunnerVanished(name);
}

/** Records that `kill` deleted the runner Job `name`; the poll's 404 that follows is its own doing. */
export function markKilled(name: string): void {
    killedRunners.add(name);
}

/** True once this driver's `kill` deleted the runner Job `name`. */
export function wasKilled(name: string): boolean {
    return killedRunners.has(name);
}

/** Forgets a kill on the runner Job `name` — a fresh run of the same job starts with a clean slate. */
export function clearKilled(name: string): void {
    killedRunners.delete(name);
}

/**
 * Records why the driver is ending the attempt on its runner Job, one annotation per reason, for the
 * claim that adopts the finished Job after this driver's loss (`k8s-adopt.ts`). A Job already gone
 * has nothing to record on; any other refusal rejects.
 */
export async function recordRunnerKill(deps: K8sDeps, job: BoardJob, kill: KillRecord): Promise<void> {
    const patched = await deps.request('PATCH', jobPath(deps.config.k8sNamespace, runnerName(job)), {
        metadata: { annotations: { [killMarkOf(kill.reason)]: kill.detail } },
    });
    if (patched.status === HTTP_NOT_FOUND) return;
    expectOk(patched, 'recording why the runner job was ended');
}
