import type { BoardJob } from './board.js';
import { readTypedList } from './k8s-poll.js';
import { expectOk, HTTP_CONFLICT, HTTP_NOT_FOUND, isRecord } from './k8s-transport.js';
import type { K8sDeps } from './k8s-transport.js';
import { type VolumeListing, planTaskVolume } from './task-restore.js';
import {
    TASK_ROOT_LABEL,
    TASK_UNSCHEDULABLE_LABEL,
    generationOfName,
    taskRootOf,
    taskVolumeName,
    taskVolumeSpec,
} from './task-volume.js';

/** The task volumes of a namespace (issue #775). */
export const taskVolumesPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/persistentvolumeclaims`;

/** One claim of a listing: its generation and whether it is being deleted (its name is taken, but it cannot be mounted). */
interface ListedVolume {
    generation: number;
    terminating: boolean;
    unschedulable: boolean;
}

/**
 * The thread's task volumes by its root label (issue #775). Only a 200 whose items are all this
 * thread's claims counts, so an empty list is the one proof of absence; a refusal, a transport
 * failure and a malformed item throw, and nothing is created or restored on them.
 */
export async function listTaskVolumes(deps: K8sDeps, job: BoardJob): Promise<VolumeListing> {
    const root = taskRootOf(job);
    const path = `${taskVolumesPath(deps.config.k8sNamespace)}?labelSelector=${encodeURIComponent(`${TASK_ROOT_LABEL}=${root}`)}`;
    const entry = (value: unknown): ListedVolume | null => {
        if (!isRecord(value) || !isRecord(value.metadata)) return null;
        const { name, labels, deletionTimestamp } = value.metadata;
        if (typeof name !== 'string' || !isRecord(labels) || labels[TASK_ROOT_LABEL] !== root) return null;
        const generation = generationOfName(root, name);
        if (generation === null) return null;
        return {
            generation,
            terminating: deletionTimestamp !== undefined,
            unschedulable: labels[TASK_UNSCHEDULABLE_LABEL] === 'true',
        };
    };
    const read = await readTypedList(deps, path, `listing the task volumes of job ${job.id}`, { entry });
    if (read.kind !== 'value') {
        throw new Error(read.kind === 'inconclusive' ? read.reason : 'the task volume listing is absent');
    }
    const mounted = read.value.filter((volume) => !volume.terminating);
    return {
        live: mounted.filter((volume) => !volume.unschedulable).map((volume) => volume.generation),
        highest: Math.max(0, ...read.value.map((volume) => volume.generation)),
        unschedulable: mounted.filter((volume) => volume.unschedulable).map((volume) => volume.generation),
    };
}

/**
 * Marks the attempt's task volume as one no pod can be scheduled onto (a node-affinity conflict): the
 * lookup skips it from now on, so the next claim restores into a new generation in a schedulable zone.
 */
export async function markTaskVolumeUnschedulable(deps: K8sDeps, job: BoardJob): Promise<void> {
    await labelTaskVolume(deps, taskVolumeName(job), 'true', `marking the task volume of job ${job.id} unschedulable`);
}

/** One merge patch of the unschedulable label on a claim: set (`'true'`) or cleared (null). */
async function labelTaskVolume(deps: K8sDeps, claim: string, value: 'true' | null, what: string): Promise<void> {
    const answer = await deps.request('PATCH', `${taskVolumesPath(deps.config.k8sNamespace)}/${claim}`, {
        metadata: { labels: { [TASK_UNSCHEDULABLE_LABEL]: value } },
    });
    expectOk(answer, what);
}

/**
 * The thread's task volume: the highest generation listed is adopted; one that is not there is
 * created on the thread's first attempt, or — for a claim that continues a session — as the next
 * generation, to be restored from the checkpoint (`planTaskVolume`). A create that answers 409 lost a
 * race to another creation of the same name: it is listed again and adopted. Nothing here deletes one.
 */
export async function ensureTaskVolume(deps: K8sDeps, job: BoardJob, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const { create, unlabel } = await planTaskVolume(deps.checkpoints, job, await listTaskVolumes(deps, job));
    if (unlabel !== undefined) {
        // Adopted again, with nothing to restore it from: the next scheduling attempt decides if it still conflicts.
        await labelTaskVolume(
            deps,
            taskVolumeName(job, unlabel),
            null,
            `clearing the unschedulable mark of the task volume of job ${job.id}`
        );
        return;
    }
    if (!create) return;
    // An attempt aborted while the listing was out creates nothing.
    signal?.throwIfAborted();
    const created = await deps.request(
        'POST',
        taskVolumesPath(deps.config.k8sNamespace),
        taskVolumeSpec(deps.config, job)
    );
    if (created.status === HTTP_CONFLICT && (await listTaskVolumes(deps, job)).live.includes(job.taskGeneration!))
        return;
    expectOk(created, `creating the task volume of job ${job.id}`);
}

/** Deletes the thread's older generations once a restore has landed; a claim already gone is deleted. */
export async function removeTaskVolumes(deps: K8sDeps, job: BoardJob, generations: readonly number[]): Promise<void> {
    for (const generation of generations) {
        const answer = await deps.request(
            'DELETE',
            `${taskVolumesPath(deps.config.k8sNamespace)}/${taskVolumeName(job, generation)}`
        );
        if (answer.status !== HTTP_NOT_FOUND) expectOk(answer, `deleting the task volume generation ${generation}`);
    }
}
