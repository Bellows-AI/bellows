import type { BoardJob } from './board.js';
import { opencodeDbPath, runTimeoutMs } from './claim.js';
import type { DriverConfig } from './config.js';
import { checkpointScript } from './container-scripts.js';
import { OPENCODE } from './executors.js';
import { baseBranchOf } from './publish-base.js';
import { GATE_IMAGE, checkoutDir, checkoutKey, worktreeBranch } from './publish.js';
import { CHECKPOINT_DIR } from './task-volume.js';
import {
    AGENT_IN,
    AGENT_OUT,
    GO_MARKER,
    RUN_CONTROL_POLL_MS,
    SUPERVISOR_CHECKPOINT_MS,
    SUPERVISOR_DRAIN_MS,
    SUPERVISOR_ENV,
    SUPERVISOR_ORPHAN_LEASE_SHARE,
    SUPERVISOR_ORPHAN_MAX_MS,
    SUPERVISOR_ORPHAN_MIN_MS,
    SUPERVISOR_STEPS_MS,
    SUPERVISOR_WINDDOWN_MS,
} from './supervisor-contract.js';

/**
 * What both executors decide once about the task supervisor of a run, and render in their own
 * vocabulary (pod env and volumes, `docker create` argv): the supervisor's literals, the agent's
 * mailbox env, and the backstop deadline. The supervisor's credential — the attempt's control pair
 * — is no literal: each executor delivers it by reference (the attempt's Secret, an env file), and
 * only to the supervisor and the exporter, never to the agent.
 */

const MS_PER_SECOND = 1000;

/** How long a group whose driver stopped answering keeps going: a share of the lease, so it ends inside it. */
export const orphanBoundMs = (config: DriverConfig): number =>
    Math.min(
        SUPERVISOR_ORPHAN_MAX_MS,
        Math.max(SUPERVISOR_ORPHAN_MIN_MS, (config.leaseSeconds * MS_PER_SECOND) / SUPERVISOR_ORPHAN_LEASE_SHARE)
    );

/**
 * The declared gate image of the attempt's group (issue #773), or null when the group runs no gate
 * container: the checkout declares neither gates nor setup, or the job has no worktree to run them
 * in. One decision for both executors' group specs; the image is asserted before it lands in one.
 */
export function gateImageOf(job: BoardJob): string | null {
    const declared = job.gates;
    if (!declared || (declared.gates.length === 0 && !declared.setup) || !checkoutKey(job)) return null;
    if (!GATE_IMAGE.test(declared.image)) {
        throw new Error(`refusing to run a gate in an image that is not a plain image reference: "${declared.image}"`);
    }
    return declared.image;
}

/** The supervisor's own env literals: the budget it enforces, the paces it works at, whether an exporter and a gate container wait. */
export function supervisorLiterals(
    config: DriverConfig,
    job: BoardJob,
    group: { exporting: boolean; agentless?: boolean; gated?: boolean; reviewing?: boolean }
): [string, string][] {
    return [
        [SUPERVISOR_ENV.controlMs, String(RUN_CONTROL_POLL_MS)],
        [SUPERVISOR_ENV.deadlineMs, String(runTimeoutMs(config, job))],
        [SUPERVISOR_ENV.drainMs, String(SUPERVISOR_DRAIN_MS)],
        [SUPERVISOR_ENV.orphanMs, String(orphanBoundMs(config))],
        ...(group.exporting ? ([[SUPERVISOR_ENV.exports, '1']] as [string, string][]) : []),
        ...(group.agentless ? ([[SUPERVISOR_ENV.agentless, '1']] as [string, string][]) : []),
        ...(group.gated ? ([[SUPERVISOR_ENV.gate, '1']] as [string, string][]) : []),
        ...(group.reviewing ? ([[SUPERVISOR_ENV.reviewer, '1']] as [string, string][]) : []),
        ...(group.agentless ? [] : checkpointLiterals(job)),
    ];
}

/**
 * What the supervisor's finalize stage needs to checkpoint the task (issue #775): the script by
 * content, the tree and branch it works on, a directory on the volume, and — for opencode — the
 * session database. None for a job with no repository (no tree to carry) or without a control
 * endpoint (nowhere to upload to).
 */
function checkpointLiterals(job: BoardJob): [string, string][] {
    const checkout = checkoutDir(job);
    const base = baseBranchOf(job);
    if (!checkout || supervisorControlNames(job).length === 0) return [];
    return [
        [SUPERVISOR_ENV.checkpointScript, checkpointScript],
        [SUPERVISOR_ENV.checkpointCheckout, checkout],
        [SUPERVISOR_ENV.checkpointBranch, worktreeBranch(job)],
        ...(base ? ([[SUPERVISOR_ENV.checkpointBase, base]] as [string, string][]) : []),
        [SUPERVISOR_ENV.checkpointDir, CHECKPOINT_DIR],
        ...(job.executorType === OPENCODE
            ? ([[SUPERVISOR_ENV.checkpointOpencodeDb, opencodeDbPath(job)]] as [string, string][])
            : []),
        [SUPERVISOR_ENV.checkpointMs, String(SUPERVISOR_CHECKPOINT_MS)],
    ];
}

/** The mailbox the agent container finds its supervisor through: three paths, no credential. */
export const agentMailboxEnv = (): [string, string][] => [
    ['FACTORY_CTL_IN', AGENT_IN],
    ['FACTORY_CTL_OUT', AGENT_OUT],
    // The agent's entrypoint waits for the supervisor's release before it starts (`go`).
    ['FACTORY_CTL_GO', GO_MARKER],
];

/** The names of the supervisor's control pair this attempt carries; none when it has no control endpoint. */
export function supervisorControlNames(job: BoardJob): string[] {
    return [SUPERVISOR_ENV.controlUrl, SUPERVISOR_ENV.controlToken].filter((name) => job.supervisorEnv?.[name]);
}

/**
 * The agent phase's backstop: the run budget plus the wind-down. The supervisor ends the agent at
 * the budget itself and reports within the wind-down; the docker driver's timer only ends a group
 * whose supervisor stopped doing that.
 */
export const agentBackstopMs = (config: DriverConfig, job: BoardJob): number =>
    runTimeoutMs(config, job) + SUPERVISOR_WINDDOWN_MS;

/**
 * The backstop deadline of the whole group (the kubelet's, on the Job): the agent phase's plus the
 * steps the group serves before and after the agent — the sync, the gates, the helpers, the
 * publish. The driver ends the group itself long before; this only ends one it forgot.
 */
export const backstopMs = (config: DriverConfig, job: BoardJob): number =>
    agentBackstopMs(config, job) + SUPERVISOR_STEPS_MS;
