import { createHash } from 'node:crypto';
import type { DriverConfig } from './config.js';
import { containerScript } from './container-scripts.js';

/**
 * The task volume (issue #775): one volume per task thread, named by the thread's root job id, mounted
 * at one fixed path in every container of the attempt's group. The checkout, the agent's session
 * state, the caches and the review roots all live in it; no member, no other task and no shared claim
 * is reachable through it. Both executors name it identically (a docker named volume, a kubernetes
 * PVC), and no attempt ever deletes it: only the reaper may (a later slice).
 */

/** Where every container of a task group mounts the task volume. */
export const TASK_MOUNT = '/task';

/** Where the supervisor's checkpoint script writes its parts on the task volume (issue #775); git-ignored with `.factory/`. */
export const CHECKPOINT_DIR = `${TASK_MOUNT}/.factory/checkpoint`;

/** The pod volume and the mount name of the task volume. */
export const TASK_VOLUME = 'task';

/**
 * A uuid, asserted before it names a volume, a checkout directory or a branch segment. The one home
 * for this pattern: every other file that needs one imports it from here (`publish.ts` re-exports it).
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The name prefix of every task volume, and the admission rule's anchor (charts/factory/templates/driver-admission.yaml). */
export const TASK_VOLUME_PREFIX = 'factory-task-';

/** The generation of a thread's first volume; a restore replaces it with the next generation (`task-restore.ts`). */
export const FIRST_GENERATION = 1;

/** The labels a task volume carries, on kubernetes PVCs and docker volumes alike. */
export const TASK_ROOT_LABEL = 'factory.task-root';
export const TASK_GENERATION_LABEL = 'factory.task-generation';
export const TASK_ORG_LABEL = 'factory.task-org';
export const TASK_CLAIM_SEQ_LABEL = 'factory.task-claim-seq';
/** The board a volume was made for (`boardIdentity`): the reaper deletes only volumes carrying its own, never another board's on a shared daemon. */
export const TASK_BOARD_LABEL = 'factory.task-board';
/** Set on a PVC no pod could be scheduled onto (kubernetes only): the volume lookup never adopts it again. */
export const TASK_UNSCHEDULABLE_LABEL = 'factory.task-unschedulable';

/** The job fields a task volume is derived from. */
export interface TaskVolumeJob {
    id: string;
    rootJobId?: string | null;
    claimSeq?: number;
    workspacePath?: string | null;
    /**
     * The generation of the thread's volume THIS attempt runs on, set by the driver once the claim has
     * found, adopted or created it (never read off the wire); absent before then, which names the first.
     */
    taskGeneration?: number | undefined;
}

/** The thread root, asserted: the one id that names the thread's volume. */
export function taskRootOf(job: Pick<TaskVolumeJob, 'id' | 'rootJobId'>): string {
    const root = job.rootJobId ?? job.id;
    if (!UUID.test(root)) {
        throw new Error(`refusing to run job ${job.id}: a thread root id that is not a uuid: ${root}`);
    }
    return root.toLowerCase();
}

/** `factory-task-<root uuid>-<generation>`, the name of the thread's volume. */
export function taskVolumeName(
    job: Pick<TaskVolumeJob, 'id' | 'rootJobId' | 'taskGeneration'>,
    generation = job.taskGeneration ?? FIRST_GENERATION
): string {
    if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error(`refusing to name a task volume for generation ${generation}`);
    }
    return `${TASK_VOLUME_PREFIX}${taskRootOf(job)}-${generation}`;
}

const BOARD_IDENTITY_LENGTH = 16;

/** This driver's board, stable across restarts: a digest of `JOB_BOARD_URL`, so boards on one daemon need distinct URLs. */
export const boardIdentity = (config: Pick<DriverConfig, 'boardUrl'>): string =>
    createHash('sha256').update(config.boardUrl).digest('hex').slice(0, BOARD_IDENTITY_LENGTH);

/** The labels the volume is created with; the org is only a label, so a shape it cannot take is left off. */
export function taskVolumeLabels(
    job: TaskVolumeJob,
    board: string,
    generation = job.taskGeneration ?? FIRST_GENERATION
): Record<string, string> {
    const org = job.workspacePath?.split('/')[0];
    return {
        [TASK_ROOT_LABEL]: taskRootOf(job),
        [TASK_GENERATION_LABEL]: String(generation),
        [TASK_BOARD_LABEL]: board,
        ...(org && /^[a-z0-9][a-z0-9_-]{0,38}$/i.test(org) ? { [TASK_ORG_LABEL]: org } : {}),
        ...(job.claimSeq !== undefined ? { [TASK_CLAIM_SEQ_LABEL]: String(job.claimSeq) } : {}),
    };
}

/** The PersistentVolumeClaim of a thread's task volume: no ownerReferences, so nothing garbage-collects it. */
export function taskVolumeSpec(
    config: Pick<DriverConfig, 'taskVolume' | 'k8sRelease' | 'boardUrl'>,
    job: TaskVolumeJob
): {
    apiVersion: 'v1';
    kind: 'PersistentVolumeClaim';
    metadata: { name: string; labels: Record<string, string> };
    spec: {
        accessModes: string[];
        resources: { requests: { storage: string } };
        storageClassName?: string;
    };
} {
    const { storageClass, accessMode, size } = config.taskVolume;
    return {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
            name: taskVolumeName(job),
            // The label every runner Job carries (releaseLabel in k8s-podspec.ts), so one release's cleanup finds its claims.
            labels: {
                ...taskVolumeLabels(job, boardIdentity(config)),
                ...(config.k8sRelease ? { 'app.kubernetes.io/instance': config.k8sRelease } : {}),
            },
        },
        spec: {
            accessModes: [accessMode],
            resources: { requests: { storage: size } },
            ...(storageClass ? { storageClassName: storageClass } : {}),
        },
    };
}

/** The pod volume that serves the task volume to a group's containers. */
export const taskPodVolume = (job: Pick<TaskVolumeJob, 'id' | 'rootJobId' | 'taskGeneration'>) => ({
    name: TASK_VOLUME,
    persistentVolumeClaim: { claimName: taskVolumeName(job) },
});

/** The `--mount` argv of the task volume for a docker container; `subPath` narrows it (the reviewer's home). */
export const taskMountArgs = (
    job: Pick<TaskVolumeJob, 'id' | 'rootJobId' | 'taskGeneration'>,
    options: { readOnly?: boolean; subPath?: string; target?: string } = {}
): string[] => [
    '--mount',
    `type=volume,src=${taskVolumeName(job)}` +
        `${options.subPath ? `,volume-subpath=${options.subPath}` : ''}` +
        `,target=${options.target ?? TASK_MOUNT}${options.readOnly ? ',readonly' : ''}`,
];

/** The task volume's directory prepared before a subPath mount names it: see scripts/task-init.sh. */
export const taskInitScript = containerScript('task-init.sh');

/**
 * The generation a volume name carries for the thread `root`, or null when the name is not one of that
 * thread's volumes. A listing is read through it, so a name it cannot read is never adopted.
 */
export function generationOfName(root: string, name: string): number | null {
    const prefix = `${TASK_VOLUME_PREFIX}${root.toLowerCase()}-`;
    const digits = name.startsWith(prefix) ? name.slice(prefix.length) : '';
    return /^[1-9][0-9]{0,8}$/.test(digits) ? Number(digits) : null;
}
