import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardJob } from './board.js';
import { executorImage, type DriverConfig } from './config.js';
import { GATE_GID, GATE_UID, gateEnv, supervisorEnvFileBody, workspacePath } from './claim.js';
import { claudeExportScript, gateLoopArgv, supervisorScript } from './container-scripts.js';
import { containerHardeningArgs, resourceArgs, workspacesMountArgs } from './docker.js';
import { ctlVolumeName, idsOf, mailboxMountArgs } from './docker-mailbox.js';
import {
    type ClosedState,
    type ExecDocker,
    noSuchObject,
    provenStartRefusal,
    type RunnerFiles,
    startupRefusalOf,
} from './docker-runner-support.js';
import { JOB_LABEL, LEASE_LABEL, RECLAIM_LABEL, ROLE_LABEL } from './labels.js';
import { Inconclusive, type RunSession } from './runner.js';
import {
    EXPORTER_CONTAINER,
    GATE_CONTAINER,
    MAILBOXES,
    SUPERVISOR_CONTAINER,
    SUPERVISOR_ENV,
    DRIVER_LOST_LOSS,
    SUPERVISOR_EXIT,
    SUPERVISOR_WINDDOWN_MS,
    type SupervisorReport,
} from './supervisor-contract.js';
import { gateImageOf, supervisorLiterals } from './supervisor-plan.js';
import { exportEnv, exportsTranscript } from './transcript-export.js';

/**
 * The docker half of a run's container group: the task supervisor and, for a run that exports its
 * transcript, the exporter, and for a checkout that declares gates or setup the gate container,
 * created and started beside the agent, with the mailboxes as named volumes
 * (`supervisor-contract.ts`) mounted exactly as the pod mounts them — the agent gets `in` read-only
 * and `out`, the exporter the workspace and `export`, the gate the workspace and `gate`, the
 * supervisor all of them, and no container but the supervisor and the exporter holds the control pair. The agent's end does not end
 * the group: the supervisor drains the exporter and finalizes first, and the runner waits for it
 * (`awaitSupervisor`). The group is the pod's twin, and `k8s-podspec.ts` its other half.
 */

export const supervisorName = (job: BoardJob): string => `factory-supervisor-${idsOf(job)}`;
export const exporterName = (job: BoardJob): string => `factory-export-${idsOf(job)}`;
export const gateName = (job: BoardJob): string => `factory-gate-${idsOf(job)}`;

/** The reclaim group's mark (`RECLAIM_LABEL`), on each of its objects; nothing on an attempt's. */
const reclaimLabelArgs = (reclaim: boolean): string[] => (reclaim ? ['--label', `${RECLAIM_LABEL}=true`] : []);

const labelArgs = (job: BoardJob, role: string, reclaim: boolean): string[] => [
    '--label',
    `${JOB_LABEL}=${job.id}`,
    '--label',
    `${LEASE_LABEL}=${job.leaseToken}`,
    '--label',
    `${ROLE_LABEL}=${role}`,
    ...reclaimLabelArgs(reclaim),
];

/** The `docker volume create` argv of each mailbox: labelled with the job and lease, so a fence can find them. */
export const ctlVolumeArgs = (job: BoardJob, reclaim = false): string[][] =>
    Object.values(MAILBOXES).map((box) => [
        'volume',
        'create',
        '--label',
        `${JOB_LABEL}=${job.id}`,
        '--label',
        `${LEASE_LABEL}=${job.leaseToken}`,
        ...reclaimLabelArgs(reclaim),
        ctlVolumeName(job, box),
    ]);

const reachDriverArgs = (config: DriverConfig): string[] => [
    // The control URL names the driver as the agent's does; Linux needs the name mapped.
    '--add-host',
    'host.docker.internal:host-gateway',
    ...(config.network ? ['--network', config.network] : []),
];

/**
 * The supervisor's `docker create` argv — pure and exported, the part worth pinning. All four
 * mailboxes, no workspace and no claim env; the control pair rides an env file, never argv.
 */
export function supervisorCreateArgs(
    config: DriverConfig,
    job: BoardJob,
    group: { exporting: boolean; agentless: boolean; gated?: boolean; reclaim?: boolean },
    envFile: string | null
): string[] {
    return [
        'create',
        ...containerHardeningArgs(),
        '--name',
        supervisorName(job),
        ...labelArgs(job, SUPERVISOR_CONTAINER, group.reclaim === true),
        ...reachDriverArgs(config),
        ...(envFile ? ['--env-file', envFile] : []),
        ...supervisorLiterals(config, job, group).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        // The member's workspace subtree: the steps the supervisor runs (the sync, the probe, the
        // publish, the helpers, the reclaim) work on the task worktree.
        ...workspacesMountArgs(config, workspacePath(job)),
        ...Object.values(MAILBOXES).flatMap((box) => mailboxMountArgs(job, box, 'rw')),
        '--entrypoint',
        'node',
        executorImage(config, job.executorType),
        '-e',
        supervisorScript,
    ];
}

/** The exporter's `docker create` argv: the member's workspace and the one mailbox it shares with the supervisor. */
export function exporterCreateArgs(config: DriverConfig, job: BoardJob, startedAt: string, envFile: string): string[] {
    const env = exportEnv(config, job, startedAt);
    return [
        'create',
        ...containerHardeningArgs(),
        '--name',
        exporterName(job),
        ...labelArgs(job, EXPORTER_CONTAINER, false),
        ...workspacesMountArgs(config, workspacePath(job)),
        ...mailboxMountArgs(job, MAILBOXES.export, 'rw'),
        ...reachDriverArgs(config),
        '--env-file',
        envFile,
        ...env.literals.flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        '--entrypoint',
        'node',
        executorImage(config, job.executorType),
        '-e',
        claudeExportScript,
    ];
}

/**
 * The gate container's `docker create` argv (issue #773) — the declared image, running the gate loop
 * over the gate mailbox (`scripts/gate-loop.sh`), the pod's gate sidecar's twin. It writes the
 * shared task worktree as the uid:gid every other writer on that tree uses, with a HOME that uid can
 * write; its working directory is the mailbox, since each request names its worktree. No claim env
 * and no credential: those ride each request. Sized by GATE_* (issue #507), on the runner network
 * for the registry a setup installs from; the services network is joined once services start.
 */
export function gateCreateArgs(config: DriverConfig, job: BoardJob, image: string): string[] {
    return [
        'create',
        ...containerHardeningArgs(),
        '--name',
        gateName(job),
        ...labelArgs(job, GATE_CONTAINER, false),
        '--user',
        `${GATE_UID}:${GATE_GID}`,
        ...gateEnv(config, job).flatMap((pair) => ['-e', pair.join('=')]),
        ...workspacesMountArgs(config, workspacePath(job)),
        ...mailboxMountArgs(job, MAILBOXES.gate, 'rw'),
        '-w',
        MAILBOXES.gate.path,
        ...(config.network ? ['--network', config.network] : []),
        ...resourceArgs(config.gateResources),
        '--entrypoint',
        'sh',
        image,
        ...gateLoopArgv().slice(1),
    ];
}

const controlEnvFilePath = (job: BoardJob, role: string): string =>
    join(tmpdir(), `factory-${role}-env-${idsOf(job)}.env`);

interface GroupDeps {
    config: DriverConfig;
    execDocker: ExecDocker;
    files: RunnerFiles;
}

/** Writes a 0600 env file of the control pair, runs `create` against it and removes it — the daemon reads it at create. */
async function createWithEnvFile(
    deps: GroupDeps,
    file: string,
    body: string,
    argv: (envFile: string | null) => string[]
): Promise<void> {
    if (!body) {
        await deps.execDocker(argv(null));
        return;
    }
    await deps.files.writeFile(file, body, { mode: 0o600 });
    try {
        await deps.execDocker(argv(file));
    } finally {
        await deps.files.rm(file).catch(() => undefined);
    }
}

/**
 * What the group holds beyond its supervisor: an exporter for a run that exports its transcript,
 * and no agent at all for a node that launches none (issue #503) — whose group still serves the
 * sync, the probe and the publish.
 */
export function groupShape(
    job: BoardJob,
    session: RunSession | null
): { exporting: boolean; agentless: boolean; gated: boolean } {
    const agentless = job.agent === false;
    return { exporting: !agentless && exportsTranscript(job, session), agentless, gated: gateImageOf(job) !== null };
}

/**
 * Creates the group's mailboxes and its supervisor and exporter containers (not started). A
 * failure removes what was created and throws: a run whose supervisor cannot exist is an
 * infrastructure refusal the loop leaves to its lease, never a run that silently loses its record.
 * A terminal reclaim's group (`reclaim`) carries `RECLAIM_LABEL` on every object it creates.
 */
export async function createGroup(
    deps: GroupDeps,
    job: BoardJob,
    session: RunSession | null,
    { startedAt, reclaim = false }: { startedAt: string; reclaim?: boolean }
): Promise<void> {
    const shape = { ...groupShape(job, session), reclaim };
    const { exporting } = shape;
    try {
        for (const args of ctlVolumeArgs(job, reclaim)) await deps.execDocker(args);
        const supervisorPair = [SUPERVISOR_ENV.controlUrl, SUPERVISOR_ENV.controlToken].map((name) => ({
            name,
            source: name,
        }));
        await createWithEnvFile(
            deps,
            controlEnvFilePath(job, 'supervisor'),
            supervisorEnvFileBody(job, supervisorPair),
            (file) => supervisorCreateArgs(deps.config, job, shape, file)
        );
        if (exporting) {
            await createWithEnvFile(
                deps,
                controlEnvFilePath(job, 'export'),
                supervisorEnvFileBody(job, exportEnv(deps.config, job, startedAt).control),
                (file) => exporterCreateArgs(deps.config, job, startedAt, file ?? '')
            );
        }
    } catch (e) {
        await removeGroup(deps.execDocker, job);
        // Typed when the daemon's words prove a cause, for the loop's one startup decision (#824 D11).
        throw startupRefusalOf(e);
    }
    await createGate(deps, job);
}

/** The gate container, created after the supervisor, whose image owns the mailbox mount points. */
async function createGate(deps: GroupDeps, job: BoardJob): Promise<void> {
    const image = gateImageOf(job);
    if (!image) return;
    try {
        await deps.execDocker(gateCreateArgs(deps.config, job, image));
    } catch (e) {
        await removeGroup(deps.execDocker, job);
        throw startupRefusalOf(e, { role: 'gate', image });
    }
}

/**
 * Starts the supervisor, the exporter and the gate, detached; the agent is started by the caller, attached,
 * after them. A refusal is typed by the cause the daemon's words prove, as a refused create is.
 */
export async function startGroup(execDocker: ExecDocker, job: BoardJob, session: RunSession | null): Promise<void> {
    const shape = groupShape(job, session);
    try {
        await execDocker(['start', supervisorName(job)]);
        if (shape.exporting) await execDocker(['start', exporterName(job)]);
    } catch (e) {
        throw startupRefusalOf(e);
    }
    const image = gateImageOf(job);
    try {
        if (image) await execDocker(['start', gateName(job)]);
    } catch (e) {
        throw startupRefusalOf(e, image ? { role: 'gate', image } : undefined);
    }
}

/**
 * Waits for the supervisor to finalize and exit — the drain, the manifests, the report — and
 * answers its exit status; null when it did not end in `ms`, or its container is gone. Rejects when
 * the daemon could not say, or answered anything but a status (#824): that is no confirmation the
 * supervisor is past finalizing. The
 * group is the agent's to outlive, so this is read after the agent's close, never before.
 */
export async function waitSupervisorExit(
    execDocker: ExecDocker,
    job: BoardJob,
    ms: number,
    signal?: AbortSignal
): Promise<number | null> {
    let waited: string;
    try {
        waited = (await execDocker(['wait', supervisorName(job)], { timeout: ms, ...(signal ? { signal } : {}) }))
            .stdout;
    } catch (e) {
        if ((e as { killed?: boolean }).killed === true || noSuchObject(e, CONTAINER) || signal?.aborted) return null;
        throw e;
    }
    // The whole answer is the exit status, or it is no answer at all.
    if (!/^\d+$/.test(waited.trim())) throw new Inconclusive(`docker wait answered '${waited.trim()}'`);
    return Number(waited.trim());
}

/** The words docker refuses a missing container in: `inspect` and `wait` say `No such object`. */
const CONTAINER = ['container', 'object'];

/** `waitSupervisorExit`, with a wait the daemon could not answer read as one that did not end. */
export async function awaitSupervisor(
    execDocker: ExecDocker,
    job: BoardJob,
    ms: number = SUPERVISOR_WINDDOWN_MS
): Promise<number | null> {
    return waitSupervisorExit(execDocker, job, ms).catch(() => null);
}

/**
 * Waits for the supervisor's report that the agent is over and its exporter drained, or for the
 * supervisor to exit without one (a kill, the budget — both end it at once — or a crash), whichever
 * comes first, bounded by the wind-down. The report's absence with no exit is reported as neither.
 */
export async function awaitReportOrExit(
    execDocker: ExecDocker,
    job: BoardJob,
    reported: Promise<SupervisorReport | null>
): Promise<{ report: SupervisorReport | null; supervisorExit: number | null }> {
    const exited = awaitSupervisor(execDocker, job).then((supervisorExit) => ({ report: null, supervisorExit }));
    const answered = reported.then((report) =>
        report ? { report, supervisorExit: null } : new Promise<never>(() => undefined)
    );
    return Promise.race([answered, exited]);
}

/**
 * How an attached run's close ends (#824 D11): a start the daemon refused, proven (`provenStartRefusal`),
 * ran no agent — decided before the wind-down, its supervisor owes no report and is no loss, and the
 * daemon's answer is kept for the verdict. Any other close waits for the supervisor (`awaitReportOrExit`).
 */
export async function closeEndOf(
    execDocker: ExecDocker,
    job: BoardJob,
    close: { code: number | null; output: string; reported: Promise<SupervisorReport | null> }
): Promise<{ proven: ClosedState | null; report: SupervisorReport | null; supervisorExit: number | null }> {
    const proven = await provenStartRefusal(execDocker, job, close.code, close.output);
    if (proven) return { proven, report: null, supervisorExit: SUPERVISOR_EXIT.finalized };
    return { proven, ...(await awaitReportOrExit(execDocker, job, close.reported)) };
}

/**
 * Why a group whose agent ended was still lost, or null: its supervisor ended any way but
 * finalizing — an exit other than 0 and its deadline's 124, or no exit within the wind-down — so
 * nothing finalized the attempt and the agent's exit code is no verdict on the work. The attempt is
 * interrupted for the next claim to adopt, never failed. The backstop's own timeout is a verdict,
 * never a loss.
 */
export function supervisorLossOf(exit: number | null, timedOut: boolean): string | null {
    if (timedOut || exit === SUPERVISOR_EXIT.finalized || exit === SUPERVISOR_EXIT.deadline) return null;
    if (exit === SUPERVISOR_EXIT.lost) return DRIVER_LOST_LOSS;
    return exit === null
        ? 'the task supervisor did not finalize the run in time'
        : `the task supervisor ended before it finalized the run (exit ${exit})`;
}

/** Removes the supervisor, the exporter, the gate and the mailboxes of the attempt; tolerant of any of them being gone already. */
export async function removeGroup(execDocker: ExecDocker, job: BoardJob): Promise<void> {
    for (const name of [gateName(job), exporterName(job), supervisorName(job)]) {
        await execDocker(['rm', '-f', name]).catch(() => undefined);
    }
    for (const box of Object.values(MAILBOXES)) {
        await execDocker(['volume', 'rm', '-f', ctlVolumeName(job, box)]).catch(() => undefined);
    }
}
