import type { BoardJob } from './board.js';
import { runTimeoutMs } from './claim.js';
import type { DriverConfig } from './config.js';
import {
    MAILBOXES,
    RUN_CONTROL_POLL_MS,
    SUPERVISOR_DRAIN_MS,
    SUPERVISOR_ENV,
    SUPERVISOR_WINDDOWN_MS,
} from './supervisor-contract.js';

/**
 * What both executors decide once about the task supervisor of a run, and render in their own
 * vocabulary (pod env and volumes, `docker create` argv): the supervisor's literals, the agent's
 * mailbox env, and the backstop deadline. The supervisor's credential — the attempt's control pair
 * — is no literal: each executor delivers it by reference (the attempt's Secret, an env file), and
 * only to the supervisor and the exporter, never to the agent.
 */

/** The supervisor's own env literals: the budget it enforces, the paces it works at, whether an exporter waits. */
export function supervisorLiterals(config: DriverConfig, job: BoardJob, exporting: boolean): [string, string][] {
    return [
        [SUPERVISOR_ENV.controlMs, String(RUN_CONTROL_POLL_MS)],
        [SUPERVISOR_ENV.deadlineMs, String(runTimeoutMs(config, job))],
        [SUPERVISOR_ENV.drainMs, String(SUPERVISOR_DRAIN_MS)],
        ...(exporting ? ([[SUPERVISOR_ENV.exports, '1']] as [string, string][]) : []),
    ];
}

/** The mailbox the agent container finds its supervisor through: two paths, no credential. */
export const agentMailboxEnv = (): [string, string][] => [
    ['FACTORY_CTL_IN', MAILBOXES.in.path],
    ['FACTORY_CTL_OUT', MAILBOXES.out.path],
];

/** The names of the supervisor's control pair this attempt carries; none when it has no control endpoint. */
export function supervisorControlNames(job: BoardJob): string[] {
    return [SUPERVISOR_ENV.controlUrl, SUPERVISOR_ENV.controlToken].filter((name) => job.supervisorEnv?.[name]);
}

/**
 * The backstop deadline of the whole group: the run budget plus the wind-down. The supervisor ends
 * the agent at the budget itself and finalizes within the wind-down; the kubelet (or the docker
 * driver's timer) only ends a group whose supervisor stopped doing that.
 */
export const backstopMs = (config: DriverConfig, job: BoardJob): number =>
    runTimeoutMs(config, job) + SUPERVISOR_WINDDOWN_MS;
