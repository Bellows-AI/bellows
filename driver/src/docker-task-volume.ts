import { containerHardeningArgs } from './docker.js';
import type { BoardJob } from './board.js';
import { type DriverConfig, executorImage } from './config.js';
import { GATE_GID, GATE_UID, REVIEWER_TREE_PATH } from './claim.js';
import { type ExecDocker, readDocker } from './docker-runner-support.js';
import {
    TASK_MOUNT,
    TASK_ROOT_LABEL,
    taskInitScript,
    taskMountArgs,
    taskRootOf,
    taskVolumeLabels,
    taskVolumeName,
} from './task-volume.js';

const INIT_DEADLINE_MS = 60_000;

/** A volume's labels from `{{json .Labels}}`: `null` (unlabeled) reads as none; anything but an object is no answer. */
const labelMap = (stdout: string): Record<string, unknown> | null => {
    try {
        const parsed: unknown = JSON.parse(stdout);
        if (parsed === null) return {};
        return typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
};

const readTaskVolume = (execDocker: ExecDocker, job: BoardJob, signal?: AbortSignal) =>
    readDocker(
        (args) => execDocker(args, signal ? { signal } : undefined),
        ['volume', 'inspect', '--format', '{{json .Labels}}', taskVolumeName(job)],
        `the task volume of job ${job.id}`,
        { parse: labelMap, absentOn: ['volume'] }
    );

/**
 * Whether the thread's task volume exists and carries its root label: the only volume a readout
 * may mount, because `--mount type=volume` creates a missing one unlabeled, where the reaper
 * never sees it. A refused or unreadable inspect is false.
 */
export async function taskVolumeIsOurs(execDocker: ExecDocker, job: BoardJob, signal?: AbortSignal): Promise<boolean> {
    const read = await readTaskVolume(execDocker, job, signal);
    return read.kind === 'value' && read.value[TASK_ROOT_LABEL] === taskRootOf(job);
}

/**
 * The task volume of the job's thread, created on the thread's first attempt and adopted by every
 * later one (issue #775). Presence is judged by inspecting the volume by name, as the kubernetes
 * executor GETs its claim: a refused or malformed inspect throws, and nothing is created or mounted
 * on it; a volume of the name without the thread's root label is refused, never adopted. An aborted
 * attempt creates nothing. The volume root is handed to the task group by a root init, and a thread
 * with a reviewer also gets the reviewer's home made before the reviewer's container mounts it.
 */
export async function ensureTaskVolume(
    deps: { config: DriverConfig; execDocker: ExecDocker },
    job: BoardJob,
    signal?: AbortSignal
): Promise<void> {
    const name = taskVolumeName(job);
    signal?.throwIfAborted();
    const read = await readTaskVolume(deps.execDocker, job, signal);
    if (read.kind === 'inconclusive') throw new Error(read.reason);
    if (read.kind === 'absent') {
        signal?.throwIfAborted();
        const labels = Object.entries(taskVolumeLabels(job)).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
        await deps.execDocker(['volume', 'create', ...labels, name], signal ? { signal } : undefined);
    } else if (read.value[TASK_ROOT_LABEL] !== taskRootOf(job)) {
        throw new Error(`the volume ${name} exists but is not labelled as the task volume of job ${job.id}`);
    }
    // The task group cannot write a fresh named volume's root: kubernetes hands it to GATE_GID
    // through fsGroup, the daemon has no such thing. The daemon copies the image's /task (uid 1000)
    // into the empty volume, so root does not own what it hands over: chmod needs FOWNER, and
    // keeping the setgid bit while root is outside the group needs FSETID.
    const opts = signal ? { timeout: INIT_DEADLINE_MS, signal } : { timeout: INIT_DEADLINE_MS };
    await deps.execDocker(
        [
            'run',
            ...containerHardeningArgs(),
            '--cap-add',
            'CHOWN',
            '--cap-add',
            'FOWNER',
            '--cap-add',
            'FSETID',
            '--rm',
            '--user',
            '0:0',
            ...taskMountArgs(job),
            '--entrypoint',
            'sh',
            executorImage(deps.config, job.executorType),
            '-c',
            taskInitScript,
            'init',
            TASK_MOUNT,
            String(GATE_GID),
        ],
        opts
    );
    if ((job.reviewerProfiles?.length ?? 0) === 0) return;
    await deps.execDocker(
        [
            'run',
            ...containerHardeningArgs(),
            '--rm',
            '--user',
            `${GATE_UID}:${GATE_GID}`,
            ...taskMountArgs(job),
            '--entrypoint',
            'sh',
            executorImage(deps.config, job.executorType),
            '-c',
            taskInitScript,
            'init',
            REVIEWER_TREE_PATH,
        ],
        opts
    );
}
