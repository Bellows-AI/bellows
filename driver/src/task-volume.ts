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

/** The pod volume and the mount name of the task volume. */
export const TASK_VOLUME = 'task';

/**
 * A uuid, asserted before it names a volume, a checkout directory or a branch segment. The one home
 * for this pattern: every other file that needs one imports it from here (`publish.ts` re-exports it).
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The name prefix of every task volume, and the admission rule's anchor (charts/factory/templates/driver-admission.yaml). */
export const TASK_VOLUME_PREFIX = 'factory-task-';

/** The generation of the one volume a thread has until restore can replace it. */
export const FIRST_GENERATION = 1;

/** The labels a task volume carries, on kubernetes PVCs and docker volumes alike. */
export const TASK_ROOT_LABEL = 'factory.task-root';
export const TASK_GENERATION_LABEL = 'factory.task-generation';
export const TASK_ORG_LABEL = 'factory.task-org';
export const TASK_CLAIM_SEQ_LABEL = 'factory.task-claim-seq';

/** The job fields a task volume is derived from. */
export interface TaskVolumeJob {
    id: string;
    rootJobId?: string | null;
    claimSeq?: number;
    workspacePath?: string | null;
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
export function taskVolumeName(job: Pick<TaskVolumeJob, 'id' | 'rootJobId'>, generation = FIRST_GENERATION): string {
    if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error(`refusing to name a task volume for generation ${generation}`);
    }
    return `${TASK_VOLUME_PREFIX}${taskRootOf(job)}-${generation}`;
}

/** The labels the volume is created with; the org is only a label, so a shape it cannot take is left off. */
export function taskVolumeLabels(job: TaskVolumeJob, generation = FIRST_GENERATION): Record<string, string> {
    const org = job.workspacePath?.split('/')[0];
    return {
        [TASK_ROOT_LABEL]: taskRootOf(job),
        [TASK_GENERATION_LABEL]: String(generation),
        ...(org && /^[a-z0-9][a-z0-9_-]{0,38}$/i.test(org) ? { [TASK_ORG_LABEL]: org } : {}),
        ...(job.claimSeq !== undefined ? { [TASK_CLAIM_SEQ_LABEL]: String(job.claimSeq) } : {}),
    };
}

/** The PersistentVolumeClaim of a thread's task volume: no ownerReferences, so nothing garbage-collects it. */
export function taskVolumeSpec(
    config: Pick<DriverConfig, 'taskVolume' | 'k8sRelease'>,
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
                ...taskVolumeLabels(job),
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
export const taskPodVolume = (job: Pick<TaskVolumeJob, 'id' | 'rootJobId'>) => ({
    name: TASK_VOLUME,
    persistentVolumeClaim: { claimName: taskVolumeName(job) },
});

/** The `--mount` argv of the task volume for a docker container; `subPath` narrows it (the reviewer's home). */
export const taskMountArgs = (
    job: Pick<TaskVolumeJob, 'id' | 'rootJobId'>,
    options: { readOnly?: boolean; subPath?: string; target?: string } = {}
): string[] => [
    '--mount',
    `type=volume,src=${taskVolumeName(job)}` +
        `${options.subPath ? `,volume-subpath=${options.subPath}` : ''}` +
        `,target=${options.target ?? TASK_MOUNT}${options.readOnly ? ',readonly' : ''}`,
];

/** The task volume's directory prepared before a subPath mount names it: see scripts/task-init.sh. */
export const taskInitScript = containerScript('task-init.sh');
