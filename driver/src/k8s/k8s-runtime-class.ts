import type { RunnerClass, SandboxPool } from '../runner-classes.js';
import { isRecord, type K8sRequest, type K8sResponse, readAnswer } from './k8s-transport.js';

/**
 * The boot check of a class's RuntimeClass. A docker class runs `dockerd` privileged, which is root
 * of a guest kernel only under a microVM RuntimeClass; under runc it is root of the node. A class
 * tolerating a sandbox pool's taint (RUNNER_SANDBOX_POOLS) lands on that pool, whose only fence is
 * the taint, so it needs a microVM too. Admission trusts RuntimeClass NAMES, so the driver reads
 * each such RuntimeClass once, at boot, and refuses to start unless its handler is Kata. The grant
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

/**
 * Whether `toleration` lets a pod onto a node carrying `taint`: its key matches (or it is keyless
 * with `Exists`, which tolerates every taint) and its value matches (or it is `Exists`). An absent
 * operator is `Equal` and an absent value `''`, as kubernetes reads them. The effect is ignored on
 * purpose: a security guard over-matches toward refusing.
 */
export function toleratesSandbox(toleration: Record<string, unknown>, taint: SandboxPool['taint']): boolean {
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    const exists = toleration.operator === 'Exists';
    const key = text(toleration.key);
    const keyMatches = key === taint.key || (key === '' && exists);
    return keyMatches && (exists || text(toleration.value) === taint.value);
}

/** Why one class may not run as declared, before any read; null when only its RuntimeClass's handler is left to prove. */
function declaredRefusal(runnerClass: RunnerClass, targeted: readonly SandboxPool[]): string | null {
    if (runnerClass.runtimeClassName === null) return 'it names none';
    const outside = targeted.filter((pool) => !pool.runtimeClassNames.includes(runnerClass.runtimeClassName as string));
    if (outside.length === 0) return null;
    const keys = outside.map((pool) => `"${pool.taint.key}"`).join(', ');
    return `the sandbox pool tainted ${keys} does not list it, so admission refuses its pods`;
}

/**
 * Refuses boot, naming every class that needs a Kata RuntimeClass and is not proven on one: a docker
 * class (it runs dockerd privileged), and any class tolerating a sandbox pool's taint (it lands on
 * the pool, and every pod of the class — runner, gate, service sidecars, reader and export Jobs —
 * runs task code there). A pool class must also name a RuntimeClass the pool lists. Kata only: a
 * gVisor (`runsc`) handler is refused too. Each distinct RuntimeClass is read once; no read without
 * such a class.
 */
export async function assertRunnerClassRuntimes(
    classes: Readonly<Record<string, RunnerClass>>,
    pools: readonly SandboxPool[],
    request: K8sRequest
): Promise<void> {
    const reads = new Map<string, Promise<string | null>>();
    const readOnce = (name: string): Promise<string | null> => {
        const known = reads.get(name);
        if (known) return known;
        const read = notKata(request, name);
        reads.set(name, read);
        return read;
    };
    const refusals = await Promise.all(
        Object.values(classes).map(async (runnerClass) => {
            const targeted = pools.filter((pool) =>
                (runnerClass.tolerations ?? []).some((toleration) => toleratesSandbox(toleration, pool.taint))
            );
            if (!runnerClass.docker && targeted.length === 0) return null;
            const { name, runtimeClassName } = runnerClass;
            // The class grammar refuses a docker class without a RuntimeClass; never read as passed.
            const reason = declaredRefusal(runnerClass, targeted) ?? (await readOnce(runtimeClassName as string));
            if (reason === null) return null;
            const why = [
                ...(runnerClass.docker ? ['it runs dockerd privileged'] : []),
                ...(targeted.length > 0
                    ? [
                          `it tolerates the sandbox pool taint ${targeted.map((pool) => `"${pool.taint.key}"`).join(', ')}`,
                      ]
                    : []),
            ].join('; ');
            return `runner class ${name}: RuntimeClass "${runtimeClassName ?? ''}" — ${reason} (${why})`;
        })
    );
    const refused = refusals.filter((line): line is string => line !== null);
    if (refused.length > 0) {
        throw new Error(
            `a docker class or a class that targets a sandbox pool needs a Kata (microVM) RuntimeClass: ${refused.join('; ')}`
        );
    }
}
