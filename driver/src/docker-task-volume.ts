import { containerHardeningArgs } from './docker.js';
import type { BoardJob } from './board.js';
import { type DriverConfig, executorImage } from './config.js';
import { GATE_GID, GATE_UID, REVIEWER_TREE_PATH } from './claim.js';
import { type ExecDocker, nameLines, readDocker } from './docker-runner-support.js';
import {
    TASK_ROOT_LABEL,
    taskInitScript,
    taskMountArgs,
    taskRootOf,
    taskVolumeLabels,
    taskVolumeName,
} from './task-volume.js';

const INIT_DEADLINE_MS = 60_000;

/**
 * The task volume of the job's thread, created on the thread's first attempt and adopted by every
 * later one (issue #775). The listing is the only evidence of absence: a failed or malformed
 * listing throws, and nothing is created or mounted on it. A thread with a reviewer also gets the
 * reviewer's home made before the reviewer's container mounts it.
 */
export async function ensureTaskVolume(
    deps: { config: DriverConfig; execDocker: ExecDocker },
    job: BoardJob
): Promise<void> {
    const name = taskVolumeName(job);
    const listed = await readDocker(
        deps.execDocker,
        ['volume', 'ls', '--filter', `label=${TASK_ROOT_LABEL}=${taskRootOf(job)}`, '--format', '{{.Name}}'],
        `the task volume of job ${job.id}`,
        { parse: nameLines }
    );
    if (listed.kind !== 'value') {
        throw new Error(
            listed.kind === 'inconclusive' ? listed.reason : `the task volume of job ${job.id} could not be listed`
        );
    }
    if (!listed.value.includes(name)) {
        const labels = Object.entries(taskVolumeLabels(job)).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
        await deps.execDocker(['volume', 'create', ...labels, name]);
    }
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
        { timeout: INIT_DEADLINE_MS }
    );
}
