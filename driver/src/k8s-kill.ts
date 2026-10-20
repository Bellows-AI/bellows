import type { BoardJob } from './board.js';
import { jobPath } from './k8s-auxspec.js';
import { createKillLedger, type KillLedger } from './kill-ledger.js';
import { runnerName } from './k8s-podspec.js';
import { expectOk, HTTP_NOT_FOUND, type K8sDeps } from './k8s-transport.js';
import type { RunOutcome } from './runner.js';
import type { SupervisorReport } from './supervisor-contract.js';
import { type KillRecord, killMarkOf, settleEnd } from './termination.js';

/**
 * What a Stop (`kill`) leaves for the polls it interrupts. Deleting a Job makes the very next
 * status read answer 404 — indistinguishable from a Job fenced away by hand unless the driver
 * remembers it did the deleting. That is an in-process fact of one runner, so it lives in its kill ledger.
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

/** A run whose runner Job was deleted under it, by `settleEnd` over what the supervisor reported. */
export function vanishedOutcome(e: RunnerVanished, report: SupervisorReport | null): RunOutcome {
    const { timedOut, infraLoss } = settleEnd({
        kills: [],
        driverKilledHard: false,
        report,
        budgetEnded: false,
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

/** The error for a runner Job that read 404: this driver's own kill, or one taken away under the run. */
export function vanishedRunner(deps: K8sDeps, job: BoardJob): Error {
    const name = runnerName(job);
    return ledgerOf(deps).was(job).hard ? new RunnerKilled(name) : new RunnerVanished(name);
}

/** This runner's kill ledger: the durable half is the runner Job's annotation; created on first use. */
export const ledgerOf = (deps: K8sDeps): KillLedger =>
    (deps.ledger ??= createKillLedger({
        write: (job, kill) => recordRunnerKill(deps, job, kill),
    }));

/**
 * Records why the driver is ending the attempt on its runner Job, one annotation per reason, for the
 * claim that adopts the finished Job after this driver's loss (`k8s-adopt.ts`). A Job already gone
 * has nothing to record on; any other refusal rejects.
 */
export async function recordRunnerKill(deps: K8sDeps, job: BoardJob, kill: KillRecord): Promise<void> {
    // The incarnation this runner created, by uid, when it knows it: never one created since.
    const uid = deps.groups?.get(job.leaseToken)?.uids.job;
    const patched = await deps.request('PATCH', jobPath(deps.config.k8sNamespace, runnerName(job)), {
        metadata: { ...(uid ? { uid } : {}), annotations: { [killMarkOf(kill.reason)]: kill.detail } },
    });
    if (patched.status === HTTP_NOT_FOUND) return;
    expectOk(patched, 'recording why the runner job was ended');
}
