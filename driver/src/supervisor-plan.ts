import type { BoardJob } from './board/board.js';
import { opencodeDbPath, runTimeoutMs } from './claim.js';
import type { DriverConfig } from './config.js';
import { checkpointScript, gitHardenScript } from './container-scripts.js';
import { OPENCODE } from './executors.js';
import { baseBranchOf } from './publish/publish-base.js';
import { GATE_IMAGE, checkoutDir, checkoutKey, worktreeBranch } from './publish/publish.js';
import { CHECKPOINT_DIR } from './task-volume.js';
import {
    AGENT_IN,
    AGENT_OUT,
    GO_MARKER,
    RUN_CONTROL_POLL_MS,
    SUPERVISOR_CHECKPOINT_MS,
    SUPERVISOR_DRAIN_MS,
    SUPERVISOR_BINDING_PATH,
    SUPERVISOR_ENV,
    SUPERVISOR_HEARTBEAT_DIVISOR,
    orphanBoundOf,
    SUPERVISOR_STEPS_MS,
    type SupervisorBinding,
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
const MIN_HEARTBEAT_PERIOD_MS = 1_000;

/** How long a group whose driver stopped answering keeps going: a share of the lease, so it ends inside it. */
export const orphanBoundMs = (config: DriverConfig): number => orphanBoundOf(config.leaseSeconds, config.orphanMinMs);

/** How long a released group waits for a newer holder: its lease, then the grace to find the group and bind it (#829). */
export const takeoverBoundMs = (config: DriverConfig): number =>
    config.leaseSeconds * MS_PER_SECOND + config.rebindGraceMs;

/** The pace a lease is renewed at while the driver holds it: a third of the lease, never under a second. */
export const heartbeatPeriodMs = (config: DriverConfig): number =>
    Math.max(MIN_HEARTBEAT_PERIOD_MS, Math.floor((config.leaseSeconds * MS_PER_SECOND) / SUPERVISOR_HEARTBEAT_DIVISOR));

/**
 * How long the next claim waits for the supervisor of a group it adopts to end (#829): a lost driver
 * still alive keeps contact until its next heartbeat learns the lease is gone (`heartbeatPeriodMs`),
 * the released group then waits `takeoverBoundMs` from that contact, and the wind-down (drain and
 * report) follows. It scales with the lease like the bounds it outlasts.
 */
export const finalizeWaitMs = (config: DriverConfig): number =>
    SUPERVISOR_WINDDOWN_MS + heartbeatPeriodMs(config) + takeoverBoundMs(config);

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
        [SUPERVISOR_ENV.gitHardenScript, gitHardenScript],
        [SUPERVISOR_ENV.controlMs, String(RUN_CONTROL_POLL_MS)],
        [SUPERVISOR_ENV.deadlineMs, String(runTimeoutMs(config, job))],
        [SUPERVISOR_ENV.drainMs, String(SUPERVISOR_DRAIN_MS)],
        [SUPERVISOR_ENV.orphanMs, String(orphanBoundMs(config))],
        [SUPERVISOR_ENV.stepWaitMs, String(config.stepWaitMs)],
        [SUPERVISOR_ENV.claimSeq, String(job.claimSeq)],
        [SUPERVISOR_ENV.bindingFile, SUPERVISOR_BINDING_PATH],
        [SUPERVISOR_ENV.takeoverMs, String(takeoverBoundMs(config))],
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

/** The names of the supervisor's control pair and relay tokens this attempt carries; none when it has no control endpoint. */
export function supervisorControlNames(job: BoardJob): string[] {
    return [
        SUPERVISOR_ENV.controlUrl,
        SUPERVISOR_ENV.controlToken,
        SUPERVISOR_ENV.agentToken,
        SUPERVISOR_ENV.exportToken,
    ].filter((name) => job.supervisorEnv?.[name]);
}

/** How much of its budget a run started at `startedAt` has spent; none when the stamp does not parse. */
export const spentMs = (startedAt: string): number => {
    const started = Date.parse(startedAt);
    return Number.isNaN(started) ? 0 : Math.max(0, Date.now() - started);
};

/**
 * The agent phase's backstop: the run budget plus the wind-down. The supervisor ends the agent at
 * the budget itself and reports within the wind-down; the docker driver's timer only ends a group
 * whose supervisor stopped doing that. A taken-over run (#829) has spent `elapsedMs` of the budget already.
 */
export const agentBackstopMs = (config: DriverConfig, job: BoardJob, elapsedMs = 0): number =>
    Math.max(0, runTimeoutMs(config, job) - elapsedMs) + SUPERVISOR_WINDDOWN_MS;

/**
 * The backstop deadline of the whole group (the kubelet's, on the Job): the agent phase's plus the
 * steps the group serves before and after the agent — the sync, the gates, the helpers, the
 * publish, and the bound a released group waits for a newer holder after its agent went (#829). The
 * driver ends the group itself long before; this only ends one it forgot.
 */
export const backstopMs = (config: DriverConfig, job: BoardJob): number =>
    agentBackstopMs(config, job) + SUPERVISOR_STEPS_MS + takeoverBoundMs(config);

const BINDING_TOKEN = /^\S{1,256}$/;

/**
 * The binding file's text: the supervisor follows a binding by the rules of `newerBinding`
 * (`scripts/supervisor.cjs`), so a body it would ignore is refused here, with a message that
 * names neither the url nor the token.
 */
export function bindingBody(binding: SupervisorBinding): string {
    const { claimSeq, url, token, agentToken, exportToken } = binding;
    let protocol = '';
    try {
        protocol = new URL(url).protocol;
    } catch {
        // an unparseable url is refused below
    }
    if (!Number.isSafeInteger(claimSeq) || claimSeq < 0) {
        throw new Error('the holder binding has no valid claim sequence');
    }
    if (protocol !== 'http:' && protocol !== 'https:') throw new Error('the holder binding has no valid board url');
    if (!BINDING_TOKEN.test(token)) throw new Error('the holder binding has no valid token');
    if (!BINDING_TOKEN.test(agentToken)) throw new Error('the holder binding has no valid agent token');
    if (!BINDING_TOKEN.test(exportToken)) throw new Error('the holder binding has no valid export token');
    return JSON.stringify({ claimSeq, url, token, agentToken, exportToken });
}
