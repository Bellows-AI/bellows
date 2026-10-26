import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeExportScript } from '../container-scripts.js';
import { type DriverConfig, executorImage } from '../config.js';
import { CLAUDE_CODE } from '../executors.js';
import { VOLUME_EXPORT_LABEL, VOLUME_EXPORT_RUN_LABEL } from '../labels.js';
import type { OpenVolumeExport, VolumeExportChannel } from '../loop/loop-export.js';
import {
    exportWorkloadStale,
    newestVolume,
    VOLUME_EXPORT_CLEANUP_MS,
    type VolumeExport,
    type VolumeExportAttempt,
    type VolumeExportClock,
    volumeExportClock,
    volumeExportEnv,
    volumeExportName,
} from '../reaper-export.js';
import type { ReaperArm } from '../reaper.js';
import { SUPERVISOR_DRAIN_MS } from '../supervisor-contract.js';
import { TASK_MOUNT } from '../task-volume.js';
import { containerHardeningArgs } from './docker.js';
import { reachDriverArgs } from './docker-group.js';
import { boardLabelArgs } from './docker-mailbox.js';
import {
    boundedExec,
    dockerErrorDetail,
    type ExecDocker,
    noSuchObject,
    type RunnerFiles,
} from './docker-runner-support.js';

/**
 * The docker arm of the reaper's export-before-delete (issue #938): the one-shot exporter container over
 * the thread's newest task volume, uploading what the volume holds that the board does not. It carries the
 * board label and its own, never the job, lease or role label a group scan reads, so no sweep reaps it.
 * One absolute deadline covers the create (which pulls), the start, the wait and the inspect; the removal
 * has the reserve the clock leaves it. Only the relay's proof (`channel.proof()`) says `drained`.
 */

/** What the arm needs to export: the driver config (the image, the network), the relay opener and a test's clock. */
export interface DockerVolumeExporting {
    config: DriverConfig;
    open: OpenVolumeExport;
    /** The whole export's budget; `SUPERVISOR_DRAIN_MS` unless a test compresses it. */
    drainMs?: number;
    /** Where the token's env file is written and removed; the real filesystem unless a test replaces it. */
    files?: RunnerFiles;
}

interface Run {
    execDocker: ExecDocker;
    bound: ExecDocker;
    clock: VolumeExportClock;
    drainMs: number;
    signal: AbortSignal;
    name: string;
    /** This export's own id, labelled on its container: the proof that a container under the name is ours. */
    id: string;
    channel: VolumeExportChannel;
    files: RunnerFiles;
    /** `yes`: our create answered. `maybe`: it ended unanswered, the container may exist. `no`: nothing of ours exists. */
    made: 'yes' | 'maybe' | 'no';
}

/** The control token's env file: a 0600 file the daemon reads at create, so the token never rides argv. */
const envFilePath = (id: string): string => join(tmpdir(), `factory-export-env-${id}.env`);
const SECRET_ENV = 'BELLOWS_CONTROL_TOKEN';

const inconclusive = (why: string): VolumeExport => ({ result: 'inconclusive', why });

/** The exporter container's `docker create` argv. */
export function volumeExportCreateArgs(
    exporting: DockerVolumeExporting,
    board: string,
    target: { root: string; volume: string },
    run: Pick<Run, 'channel' | 'clock' | 'id'> & { envFile: string }
): string[] {
    return [
        'create',
        ...containerHardeningArgs(),
        '--name',
        volumeExportName(target.root),
        ...boardLabelArgs(board),
        '--label',
        `${VOLUME_EXPORT_LABEL}=${target.root}`,
        '--label',
        `${VOLUME_EXPORT_RUN_LABEL}=${run.id}`,
        ...reachDriverArgs(exporting.config),
        '--mount',
        `type=volume,src=${target.volume},target=${TASK_MOUNT}`,
        '--env-file',
        run.envFile,
        ...volumeExportEnv(target.root, run.channel, run.clock.giveUpMs)
            .filter(([name]) => name !== SECRET_ENV)
            .flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        '--entrypoint',
        'node',
        executorImage(exporting.config, CLAUDE_CODE),
        '-e',
        claudeExportScript,
    ];
}

/**
 * A refused create or start. A call that ended because the reaper stopped, the deadline passed or its process
 * was killed may have left a workload running: inconclusive. A daemon that answered no never ran anything.
 */
function refusedCall(e: unknown, run: Run, doing: string): VolumeExport {
    const killed = (e as { killed?: boolean }).killed === true;
    if (run.signal.aborted || killed || Date.now() >= run.clock.workEnd) {
        return inconclusive(`${doing} the export container did not finish: ${(e as Error).message}`);
    }
    return {
        result: 'never_started',
        why: `${doing} the export container was refused: ${dockerErrorDetail(e).trim()}`,
    };
}

const NAME_IN_USE = /already in use/i;
const FINISHED = new Set(['exited', 'dead']);

/**
 * Another export's container holds the name. Read it first: it is removed only when provably stale (past the
 * whole budget an export has), else it is a live export of another replica and is left alone.
 */
async function nameHeld(run: Run): Promise<VolumeExport> {
    const contended = (why: string): VolumeExport => ({ result: 'contended', why });
    let created: string;
    try {
        created = (await run.bound(['inspect', '--format', '{{.Created}}', run.name])).stdout.trim();
    } catch (e) {
        return contended(
            noSuchObject(e, ['container'])
                ? 'the export container under the name just ended'
                : `the export container under the name could not be read: ${(e as Error).message}`
        );
    }
    if (!exportWorkloadStale(Date.parse(created), run.drainMs, Date.now())) {
        return contended('another export holds the name and is within its deadline');
    }
    try {
        await run.bound(['rm', '-f', run.name]);
    } catch (e) {
        return contended(`a stale export container could not be removed: ${(e as Error).message}`);
    }
    return contended('removed a stale export container; the next round exports');
}

/** Create (with the token in a private env file removed in the same `finally`), start, wait and read the end. */
async function runContainer(makeArgs: (envFile: string) => string[], run: Run): Promise<VolumeExport> {
    const envFile = envFilePath(run.id);
    try {
        await run.files.writeFile(envFile, `${SECRET_ENV}=${run.channel.token}\n`, { mode: 0o600 });
        run.made = 'maybe';
        await run.bound(makeArgs(envFile));
        run.made = 'yes';
    } catch (e) {
        if (NAME_IN_USE.test(dockerErrorDetail(e))) {
            run.made = 'no';
            return nameHeld(run);
        }
        const refused = refusedCall(e, run, 'creating');
        if (refused.result === 'never_started') run.made = 'no';
        return refused;
    } finally {
        await run.files.rm(envFile, { force: true }).catch(() => undefined);
    }
    try {
        await run.bound(['start', run.name]);
    } catch (e) {
        return refusedCall(e, run, 'starting');
    }
    let exit: string;
    try {
        exit = (await run.bound(['wait', run.name])).stdout.trim();
    } catch (e) {
        return inconclusive(
            run.signal.aborted
                ? 'the reaper stopped mid-export'
                : `the export did not end in time: ${(e as Error).message}`
        );
    }
    let status: string;
    try {
        status = (await run.bound(['inspect', '--format', '{{.State.Status}}', run.name])).stdout.trim();
    } catch (e) {
        return inconclusive(`the export container could not be inspected: ${(e as Error).message}`);
    }
    if (!FINISHED.has(status)) return inconclusive(`the export container is ${status || 'in an unknown state'}`);
    const proof = run.channel.proof();
    return proof.drained ? { result: 'drained' } : inconclusive(`${proof.why} (exit ${exit})`);
}

/**
 * Removes the workload this export created, within the reserve: a create that answered is removed by name, one
 * that ended unanswered only if the container under the name carries this export's id. A failure leaves it to
 * its own give-up and the next round's stale check.
 */
const removeWorkload = async (run: Run): Promise<void> => {
    const { execDocker, name } = run;
    if (run.made === 'no') return;
    try {
        if (run.made === 'maybe') {
            const owner = await execDocker(
                ['inspect', '--format', `{{index .Config.Labels "${VOLUME_EXPORT_RUN_LABEL}"}}`, name],
                { timeout: VOLUME_EXPORT_CLEANUP_MS }
            );
            if (owner.stdout.trim() !== run.id) return;
        }
        await execDocker(['rm', '-f', name], { timeout: VOLUME_EXPORT_CLEANUP_MS });
    } catch {
        // Already gone, or the daemon refused.
    }
};

/** Whether the volume is still there: `false` when the daemon says no such volume, an Error for any other answer. */
const volumePresent = async (bound: ExecDocker, volume: string): Promise<boolean | Error> => {
    try {
        await bound(['volume', 'inspect', '--format', '{{.Name}}', volume]);
        return true;
    } catch (e) {
        return noSuchObject(e, ['volume']) ? false : (e as Error);
    }
};

export function createDockerVolumeExporter(
    execDocker: ExecDocker,
    board: string,
    exporting: DockerVolumeExporting
): NonNullable<ReaperArm['exportVolume']> {
    return async (thread, attempt: VolumeExportAttempt, signal) => {
        const volume = newestVolume(thread);
        if (!volume) return inconclusive('no volume of the thread reads as a generation');
        const drainMs = exporting.drainMs ?? SUPERVISOR_DRAIN_MS;
        const clock = volumeExportClock(drainMs, Date.now());
        const bound = boundedExec(execDocker, { deadline: clock.workEnd, signal });
        const present = await volumePresent(bound, volume.name);
        if (present instanceof Error) return inconclusive(`the volume could not be inspected: ${present.message}`);
        if (!present) return { result: 'gone' };
        let channel: VolumeExportChannel | null;
        try {
            channel = await exporting.open(attempt);
        } catch (e) {
            return { result: 'never_started', why: `the control endpoint did not open: ${(e as Error).message}` };
        }
        if (!channel) return { result: 'never_started', why: 'the driver has no control endpoint for the exporter' };
        const name = volumeExportName(thread.root);
        const files = exporting.files ?? { writeFile, rm };
        const run: Run = {
            execDocker,
            bound,
            clock,
            drainMs,
            signal,
            name,
            id: randomUUID(),
            channel,
            files,
            made: 'no',
        };
        const target = { root: thread.root, volume: volume.name };
        try {
            return await runContainer(
                (envFile) => volumeExportCreateArgs(exporting, board, target, { ...run, envFile }),
                run
            );
        } finally {
            channel.close();
            await removeWorkload(run);
        }
    };
}
