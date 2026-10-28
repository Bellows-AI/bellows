import {
    nonEmpty,
    optionalStrings,
    optionalTimestamp,
    stringsOnly,
    containerStatusesFault,
    imageFault,
    sidecarFault,
    validPodConditions,
    isCount,
} from './k8s-shapes.js';
import { isRecord } from './k8s-transport.js';
import type { K8sPod, Refused } from './k8s-transport.js';

/**
 * A listed or read object that names itself, as far as a decision on it reads (#869): a `metadata`
 * with a non-empty string `name`; `uid` a non-empty string, `labels` and `annotations` string maps
 * and `creationTimestamp` an RFC 3339 time when present; a `status`, when present, a record whose Job
 * counters are counts. One entry that is not this makes the whole read inconclusive; only a
 * well-formed entry out of scope is skipped by its caller.
 */
export function asNamed<T>(value: unknown): T | null {
    if (!isRecord(value) || !isRecord(value.metadata)) return null;
    const { name, uid, labels, annotations, creationTimestamp } = value.metadata;
    if (!nonEmpty(name) || (uid !== undefined && !nonEmpty(uid)) || !optionalTimestamp(creationTimestamp)) return null;
    if (labels !== undefined && !stringsOnly(labels)) return null;
    if (annotations !== undefined && !stringsOnly(annotations)) return null;
    if (value.status !== undefined && (!isRecord(value.status) || !validCounters(value.status))) return null;
    return value as T;
}

/**
 * `asNamed` for a listing a delete is decided on (#869): the entry also carries a non-empty `uid`,
 * which the apiserver always sets and the delete's precondition names. An entry without one makes
 * the whole read inconclusive — it is never deleted unconditionally.
 */
export function asIdentified<T>(value: unknown): T | null {
    const item = asNamed<{ metadata: { uid?: string } }>(value);
    return item && nonEmpty(item.metadata.uid) ? (value as T) : null;
}

/**
 * A listed or read pod (#869): named, with its deletion time, phase, words, conditions and every
 * container status — named, with a typed state — in the grammar `k8s-shapes.ts` gives them. A pod
 * with no `status` yet is a pod that has not started: no container evidence, which every consumer
 * reads as "nothing seen".
 */
const podWith =
    (containers: (status: NonNullable<K8sPod['status']>, pod: K8sPod) => string | null) =>
    (value: unknown): K8sPod | Refused => {
        const pod = asNamed<K8sPod & { metadata: { deletionTimestamp?: unknown } }>(value);
        if (pod === null) return { refused: 'metadata' };
        if (!optionalTimestamp(pod.metadata.deletionTimestamp)) return { refused: 'metadata.deletionTimestamp' };
        const { status } = pod;
        if (status === undefined) return pod;
        const { phase, reason, message, conditions } = status;
        if (!optionalStrings(phase, reason, message)) return { refused: 'status' };
        if (!validPodConditions(conditions)) return { refused: 'status.conditions' };
        const fault = containers(status, pod);
        return fault === null ? pod : { refused: `status.${fault}` };
    };

export const asPod = podWith((status) => containerStatusesFault(status.containerStatuses, 'containerStatuses'));

/**
 * A pod as the group start reads it (#869): `asPod`, and also every field `heldOf`, `startRefusalOf`
 * and `agentStarted` consume — the init containers' statuses as well as the main ones, each image a
 * string, and the pod spec's init container names and images.
 */
export const asStartupPod = podWith(({ containerStatuses, initContainerStatuses }, pod) => {
    const spec: unknown = pod.spec;
    const specInit = isRecord(spec) ? spec.initContainers : undefined;
    const specReadable =
        spec === undefined ||
        (isRecord(spec) &&
            (specInit === undefined ||
                (Array.isArray(specInit) && specInit.every((c) => isRecord(c) && optionalStrings(c.name, c.image)))));
    return (
        (specReadable ? null : 'spec.initContainers') ??
        containerStatusesFault(containerStatuses, 'containerStatuses', imageFault) ??
        containerStatusesFault(initContainerStatuses, 'initContainerStatuses', imageFault)
    );
});

/**
 * A pod as the service sidecars are read (#869): `asPod` over the init container statuses alone, each
 * with a restart count that is a count and a `lastState` of the same typed shape as `state` — every
 * field `sidecarStatuses` and its endings consume.
 */
export const asServicePod = podWith(({ initContainerStatuses }) =>
    containerStatusesFault(initContainerStatuses, 'initContainerStatuses', sidecarFault)
);

/**
 * A Job's `succeeded`, `failed` and `active` counts, each a non-negative integer when present, and
 * its `conditions` a list of typed records when present (#869).
 */
export const validCounters = (status: Record<string, unknown>): boolean =>
    (status.conditions === undefined ||
        (Array.isArray(status.conditions) &&
            status.conditions.every((c) => isRecord(c) && typeof c.type === 'string'))) &&
    ['succeeded', 'failed', 'active'].every((field) => status[field] === undefined || isCount(status[field]));
