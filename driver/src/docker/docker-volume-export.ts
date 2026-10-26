import { claudeExportScript } from '../container-scripts.js';
import { type DriverConfig, executorImage } from '../config.js';
import { CLAUDE_CODE } from '../executors.js';
import { VOLUME_EXPORT_LABEL } from '../labels.js';
import type { OpenVolumeExport, VolumeExportChannel } from '../loop/loop-export.js';
import {
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
import { boundedExec, dockerErrorDetail, type ExecDocker, noSuchObject } from './docker-runner-support.js';

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
}

interface Run {
    execDocker: ExecDocker;
    bound: ExecDocker;
    clock: VolumeExportClock;
    signal: AbortSignal;
    name: string;
    channel: VolumeExportChannel;
}

const inconclusive = (why: string): VolumeExport => ({ result: 'inconclusive', why });

/** The exporter container's `docker create` argv. */
export function volumeExportCreateArgs(
    exporting: DockerVolumeExporting,
    board: string,
    target: { root: string; volume: string },
    run: Pick<Run, 'channel' | 'clock'>
): string[] {
    return [
        'create',
        ...containerHardeningArgs(),
        '--name',
        volumeExportName(target.root),
        ...boardLabelArgs(board),
        '--label',
        `${VOLUME_EXPORT_LABEL}=${target.root}`,
        ...reachDriverArgs(exporting.config),
        '--mount',
        `type=volume,src=${target.volume},target=${TASK_MOUNT}`,
        ...volumeExportEnv(target.root, run.channel, run.clock.giveUpMs).flatMap(([name, value]) => [
            '-e',
            `${name}=${value}`,
        ]),
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

/** Create, start, wait and read the end of the container. The caller removes it. */
async function runContainer(args: string[], run: Run): Promise<VolumeExport> {
    try {
        await run.bound(args);
    } catch (e) {
        // A stale container from a crashed driver holds the name: the removal that follows clears it for the next round.
        if (NAME_IN_USE.test(dockerErrorDetail(e))) return inconclusive('a stale export container held the name');
        return refusedCall(e, run, 'creating');
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

/** `rm -f` of the workload by name, within the reserve; a failure leaves it to its own give-up and the next round's name check. */
const removeWorkload = async (execDocker: ExecDocker, name: string): Promise<void> => {
    try {
        await execDocker(['rm', '-f', name], { timeout: VOLUME_EXPORT_CLEANUP_MS });
    } catch {
        // Already gone, or the daemon refused: the exporter ends on its own give-up, and a stale name is cleared next round.
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
        const clock = volumeExportClock(exporting.drainMs ?? SUPERVISOR_DRAIN_MS, Date.now());
        const bound = boundedExec(execDocker, { deadline: clock.workEnd, signal });
        const present = await volumePresent(bound, volume.name);
        if (present instanceof Error) return inconclusive(`the volume could not be inspected: ${present.message}`);
        if (!present) return { result: 'drained' };
        let channel: VolumeExportChannel | null;
        try {
            channel = await exporting.open(attempt);
        } catch (e) {
            return { result: 'never_started', why: `the control endpoint did not open: ${(e as Error).message}` };
        }
        if (!channel) return { result: 'never_started', why: 'the driver has no control endpoint for the exporter' };
        const name = volumeExportName(thread.root);
        const run: Run = { execDocker, bound, clock, signal, name, channel };
        try {
            const args = volumeExportCreateArgs(exporting, board, { root: thread.root, volume: volume.name }, run);
            return await runContainer(args, run);
        } finally {
            channel.close();
            await removeWorkload(execDocker, name);
        }
    };
}
