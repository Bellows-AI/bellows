import { containerHardeningArgs } from './docker.js';
import type { Board, BoardJob } from '../board/board.js';
import { type DriverConfig, executorImage } from '../config.js';
import { GATE_GID, GATE_UID, REVIEWER_TREE_PATH } from '../claim.js';
import { type ExecDocker, alreadyGone, nameLines, readDocker, startupRefusalOf } from './docker-runner-support.js';
import { StartupRefused } from '../startup-cause.js';
import { type VolumeListing, planTaskVolume } from '../task-restore.js';
import {
    TASK_MOUNT,
    TASK_ROOT_LABEL,
    generationOfName,
    taskInitScript,
    taskMountArgs,
    taskRootOf,
    boardIdentity,
    taskVolumeLabels,
    taskVolumeName,
    TASK_VOLUME_PREFIX,
} from '../task-volume.js';

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
 * The guard in front of every container that mounts the task volume after `ensureTaskVolume`: the
 * reaper may have deleted it since (issue #775), and `--mount type=volume` would create an EMPTY
 * unlabelled one the attempt then runs on. A volume that is gone, or an inspect that proved nothing,
 * is a transient startup refusal — an infrastructure interruption the board refunds, never a run failure.
 */
export async function assertTaskVolumeIsOurs(
    execDocker: ExecDocker,
    job: BoardJob,
    signal?: AbortSignal
): Promise<void> {
    if (await taskVolumeIsOurs(execDocker, job, signal)) return;
    throw new StartupRefused(taskVolumeGoneWords(job), 'transient');
}

/** What a refusal for a missing task volume says. */
export const taskVolumeGoneWords = (job: BoardJob): string =>
    `the task volume ${taskVolumeName(job)} of job ${job.id} is gone or unreadable; nothing is mounted on a volume made empty`;

/**
 * The thread's task volumes by its root label (`docker volume ls`), their generations read off the
 * names. Only a listing the daemon answered and every line of which is one of the thread's volumes
 * counts: a refused call, an unreadable answer or a name that is not a generation of this root throws,
 * so nothing is created or restored on an inconclusive read. A second listing by name prefix finds a
 * volume a mount auto-created unlabelled after the reaper removed the labelled one: it is no volume of
 * the thread (`live`), but its generation is taken (`highest`), so no create ever lands on it.
 */
export async function listTaskVolumes(
    execDocker: ExecDocker,
    job: BoardJob,
    signal?: AbortSignal
): Promise<VolumeListing> {
    const root = taskRootOf(job);
    const read = await readDocker(
        (args) => execDocker(args, signal ? { signal } : undefined),
        ['volume', 'ls', '--filter', `label=${TASK_ROOT_LABEL}=${root}`, '--format', '{{.Name}}'],
        `the task volumes of job ${job.id}`,
        { parse: nameLines }
    );
    if (read.kind !== 'value') {
        throw new Error(read.kind === 'inconclusive' ? read.reason : 'the task volume listing is absent');
    }
    const named = await readDocker(
        (args) => execDocker(args, signal ? { signal } : undefined),
        ['volume', 'ls', '--filter', `name=${TASK_VOLUME_PREFIX}${root}-`, '--format', '{{.Name}}'],
        `the task volume names of job ${job.id}`,
        { parse: nameLines }
    );
    if (named.kind !== 'value') {
        throw new Error(named.kind === 'inconclusive' ? named.reason : 'the task volume name listing is absent');
    }
    const taken = named.value.flatMap((name) => generationOfName(root, name) ?? []);
    const live = read.value.map((name) => {
        const generation = generationOfName(root, name);
        if (generation === null)
            throw new Error(
                `the task volume listing of job ${job.id} names ${name}, which is no generation of ${root}`
            );
        return generation;
    });
    return { live, highest: Math.max(0, ...live, ...taken), unschedulable: [] };
}

/** Removes the thread's older generations once a restore has landed. An already-gone volume is removed. */
export async function removeTaskVolumes(
    execDocker: ExecDocker,
    job: BoardJob,
    generations: readonly number[],
    signal?: AbortSignal
): Promise<void> {
    for (const generation of generations) {
        try {
            await execDocker(['volume', 'rm', taskVolumeName(job, generation)], signal ? { signal } : undefined);
        } catch (e) {
            if (!alreadyGone(e)) throw e;
        }
    }
}

/**
 * The task volume of the job's thread (issue #775): the thread's highest generation listed by its root
 * label is adopted, and one that is not there is created on the thread's first attempt, or — for a
 * claim that continues a session — as the next generation to be restored from the checkpoint
 * (`planTaskVolume`). A refused or malformed listing throws and nothing is created or mounted; a
 * volume of the name without the thread's root label is refused, never adopted. An aborted attempt
 * creates nothing. The volume root is handed to the task group by a root init, and a thread with a
 * reviewer also gets the reviewer's home made before the reviewer's container mounts it.
 */
export async function ensureTaskVolume(
    deps: { config: DriverConfig; execDocker: ExecDocker; checkpoints?: Pick<Board, 'checkpoint'> | undefined },
    job: BoardJob,
    signal?: AbortSignal
): Promise<void> {
    signal?.throwIfAborted();
    const listing = await listTaskVolumes(deps.execDocker, job, signal);
    const { create } = await planTaskVolume(deps.checkpoints, job, listing);
    const name = taskVolumeName(job);
    signal?.throwIfAborted();
    if (create) {
        const labels = Object.entries(taskVolumeLabels(job, boardIdentity(deps.config))).flatMap(([key, value]) => [
            '--label',
            `${key}=${value}`,
        ]);
        await deps.execDocker(['volume', 'create', ...labels, name], signal ? { signal } : undefined);
        // `volume create` of a name that exists answers ok and labels nothing: only a labelled volume is ours.
        await assertTaskVolumeIsOurs(deps.execDocker, job, signal);
    } else {
        const read = await readTaskVolume(deps.execDocker, job, signal);
        if (read.kind !== 'value') {
            throw new Error(read.kind === 'inconclusive' ? read.reason : `the listed volume ${name} is gone`);
        }
        if (read.value[TASK_ROOT_LABEL] !== taskRootOf(job)) {
            throw new Error(`the volume ${name} exists but is not labelled as the task volume of job ${job.id}`);
        }
    }
    // The task group cannot write a fresh named volume's root: kubernetes hands it to GATE_GID
    // through fsGroup, the daemon has no such thing. The daemon copies the image's /task (uid 1000)
    // into the empty volume, so root does not own what it hands over: chmod needs FOWNER, and
    // keeping the setgid bit while root is outside the group needs FSETID.
    const opts = signal ? { timeout: INIT_DEADLINE_MS, signal } : { timeout: INIT_DEADLINE_MS };
    // Each init runs the executor image before the group does: a daemon refusing that image is the same
    // typed startup refusal the group start answers (`startupRefusalOf`), never a raw error.
    const init = (args: string[]) =>
        deps.execDocker(args, opts).catch((e: unknown) => {
            throw startupRefusalOf(e);
        });
    await init([
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
    ]);
    if ((job.reviewerProfiles?.length ?? 0) === 0) return;
    await init([
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
    ]);
}
