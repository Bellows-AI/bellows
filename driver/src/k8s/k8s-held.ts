import type { K8sContainerStatus, K8sPod } from './k8s-transport.js';
import { type HeldContainer, heldWords } from '../startup-cause.js';

/** The container a pod status holds, with the image its status names (#773 D10). */
export type HeldImage = HeldContainer & { image?: string };

/**
 * The one unpullable-image message shape every poll shares; the held container is the only
 * variation — the gate names its own declared image, a service its own (#773 D10), the runner and
 * aux Jobs the executor's.
 */
export function unpullableImage(held: HeldContainer, image: string, blocked: string): string {
    return `the ${heldWords(held)} image "${image}" cannot be pulled: ${blocked}`;
}

/** The unpullable-image message for the container a pod status holds, its own image before the caller's (#773 D10). */
export const heldUnpullable = (image: string, pull: { held: HeldImage | null }, blocked: string): string =>
    unpullableImage(pull.held ?? { role: 'executor' }, pull.held?.image ?? image, blocked);

/** The role a group pod's container plays, from its name (#773 D10): `svc-<name>`, `gate`, else the executor's own. */
function heldContainerOf(name: string | undefined): HeldContainer {
    if (name?.startsWith('svc-')) return { role: 'service', service: name.slice('svc-'.length) };
    return name === 'gate' ? { role: 'gate' } : { role: 'executor' };
}

/**
 * The first container the kubelet holds in CrashLoopBackOff, in words, else null. Never a refusal of
 * its own — the container may yet come up (a docker class's dockerd) — only what the start's bound names.
 */
export function crashLoopingOf(statuses: readonly K8sContainerStatus[]): string | null {
    const looping = statuses.find((c) => c.state?.waiting?.reason === 'CrashLoopBackOff');
    if (!looping) return null;
    const words = looping.state?.waiting?.message;
    return `the ${looping.name} container is crash-looping (CrashLoopBackOff${words ? `: ${words}` : ''})`;
}

/**
 * The held container and its image: the status's own, else — for a sidecar — the image the pod spec
 * gave it, never the executor image a caller would otherwise fill in.
 */
export function heldOf(holder: K8sContainerStatus | undefined, pod: K8sPod | undefined): HeldImage | null {
    if (!holder) return null;
    const role = heldContainerOf(holder.name);
    const specced =
        role.role === 'executor'
            ? undefined
            : pod?.spec?.initContainers?.find((container) => container.name === holder.name)?.image;
    const image = holder.image || specced;
    return { ...role, ...(image ? { image } : {}) };
}
