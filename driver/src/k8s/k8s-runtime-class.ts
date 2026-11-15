import type { RunnerClass } from '../runner-classes.js';
import { isRecord, type K8sRequest, type K8sResponse, readAnswer } from './k8s-transport.js';

/**
 * The boot check of a docker class's RuntimeClass. A docker class runs `dockerd` privileged, which
 * is root of a guest kernel only under a microVM RuntimeClass; under runc it is root of the node.
 * Admission pins the pod to the class's RuntimeClass by NAME, so the driver reads each docker
 * class's RuntimeClass once, at boot, and refuses to start unless its handler is Kata. The grant
 * is the chart's one ClusterRole (`driver-runtimeclass-rbac.yaml`): `get` on those names alone.
 * A RuntimeClass that is missing, a read that is refused, malformed or failed, is no proof — each
 * refuses too (an unconfirmed read never passes). A RuntimeClass changed after boot is not seen;
 * the restart that applies a new class re-reads it.
 */

/**
 * Kata's handler names: `kata` (upstream's default and AKS's), or `kata-<variant>` — upstream's
 * hypervisor and confidential variants (`kata-qemu`, `kata-clh`, `kata-fc`, `kata-dragonball`,
 * `kata-qemu-snp`, …), GKE's `kata-clh`. Nothing else: a prefix-alike (`katana`) is not Kata.
 */
const KATA_HANDLER = /^kata(-[a-z0-9]+)*$/;

export const isKataHandler = (handler: string): boolean => KATA_HANDLER.test(handler);

const runtimeClassPath = (name: string): string => `/apis/node.k8s.io/v1/runtimeclasses/${name}`;

/** Why `runtimeClassName`'s RuntimeClass does not prove a microVM, or null when its handler is Kata. */
async function notKata(request: K8sRequest, runtimeClassName: string): Promise<string | null> {
    const what = `reading the RuntimeClass "${runtimeClassName}"`;
    let response: K8sResponse;
    try {
        response = await request('GET', runtimeClassPath(runtimeClassName));
    } catch (error) {
        return `${what} failed: ${(error as Error).message}`;
    }
    const read = readAnswer(response, what, (value) =>
        isRecord(value) && typeof value.handler === 'string' ? value.handler : null
    );
    if (read.kind === 'absent') return 'it does not exist';
    if (read.kind === 'inconclusive') return read.reason;
    return isKataHandler(read.value) ? null : `its handler "${read.value}" is not Kata`;
}

/** Refuses boot, naming every docker class whose RuntimeClass is not proven Kata. No read without a docker class. */
export async function assertDockerClassesOnKata(
    classes: Readonly<Record<string, RunnerClass>>,
    request: K8sRequest
): Promise<void> {
    const docker = Object.values(classes).filter((runnerClass) => runnerClass.docker);
    const refusals = await Promise.all(
        docker.map(async ({ name, runtimeClassName }) => {
            // The class grammar refuses a docker class without a RuntimeClass; never read as passed.
            const reason = runtimeClassName === null ? 'it names none' : await notKata(request, runtimeClassName);
            return reason === null
                ? null
                : `runner class ${name}: RuntimeClass "${runtimeClassName ?? ''}" — ${reason}`;
        })
    );
    const refused = refusals.filter((line): line is string => line !== null);
    if (refused.length > 0) {
        throw new Error(
            `a docker class runs dockerd privileged and needs a Kata (microVM) RuntimeClass: ${refused.join('; ')}`
        );
    }
}
