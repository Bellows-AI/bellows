import { FLEET_LABEL, JOB_LABEL, LEASE_LABEL, SERVICE_LABEL, UNHARDENED_LABEL } from './labels.js';
import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { jobsPath, pullSecretsField, releaseLabel, serviceSubdomain } from './k8s-podspec.js';
import {
    containerHardeningField,
    doNotDisruptField,
    podHardeningField,
    resourcesField,
    schedulingField,
    type PodResources,
    type PodSecurityContext,
} from './k8s-podfields.js';
import { JOB_ID, LOG_TAIL_LINES } from './k8s-transport.js';
import type { K8sDeps } from './k8s-transport.js';
import type { ServiceSpec } from './services.js';

/**
 * The kubernetes executor's declared-service pod builders, plus the shared naming and path helpers
 * (the checkout claim's ConfigMap, the runner's per-attempt Secret) every `k8s-*.ts` file addresses
 * these objects by. The sync, the reclaim, the publish steps and the helpers are no objects at all:
 * the task supervisor runs them (`supervised-steps.ts`). See docs/kubernetes.md for the full module map.
 */

/**
 * One declared service, as a Pod. A Pod and not a Job because a Job is a unit of WORK — a
 * service is a long-running neighbor the tests talk to, the k8s twin of docker's detached
 * container. `restartPolicy: Never` mirrors docker exactly: a detached container that crashes
 * stays crashed, and so does this pod.
 *
 * The pod is OWNED by the attempt's headless DNS Service — the `ownerUid` the caller read off the
 * Service's create response — so it is never a standalone pod: it is the one driver-specced pod
 * that is not a Job, and a CNI that enforces NetworkPolicy "optimized for" owned pods (EKS's VPC
 * CNI, issue #363) would otherwise be free to skip the one pod class a repository's
 * `.bellows.yaml` starts. `blockOwnerDeletion: false` needs no write on the owner, and the
 * existing teardown deletes pods before their Service either way; the GC dependency is a
 * self-healing bonus, not a new path.
 *
 * Environment values travel as literals, unlike every credential this driver forwards: they
 * were already world-readable in the author's `.bellows.yaml`, and no secret of this process's
 * own ever reaches them — the same reasoning docker's `-e KEY=value` argv states.
 */
export const servicePodName = (job: BoardJob, name: string): string =>
    `factory-job-${job.id}-${job.leaseToken}-svc-${name}`;

const SERVICE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function servicePodSpec(
    config: DriverConfig,
    job: BoardJob,
    spec: ServiceSpec,
    ownerUid: string
): {
    apiVersion: 'v1';
    kind: 'Pod';
    metadata: {
        name: string;
        labels: Record<string, string>;
        /** The disruption opt-out (doNotDisruptField) — a bare Pod's own metadata. */
        annotations?: Record<string, string>;
        ownerReferences: {
            apiVersion: 'v1';
            kind: 'Service';
            name: string;
            uid: string;
            blockOwnerDeletion: boolean;
            controller: boolean;
        }[];
    };
    spec: {
        restartPolicy: 'Never';
        automountServiceAccountToken: false;
        /** The executor hardening (#382) — `podHardeningField`, always present, opt-out or not. */
        securityContext: PodSecurityContext;
        hostname: string;
        subdomain: string;
        imagePullSecrets?: { name: string }[];
        /** The runner group's scheduling knobs — `schedulingField`, absent when unset. */
        nodeSelector?: Record<string, string>;
        tolerations?: Record<string, unknown>[];
        affinity?: Record<string, unknown>;
        containers: {
            name: string;
            image: string;
            imagePullPolicy: string;
            resources?: PodResources;
            /**
             * The executor hardening (#382). Always carries `allowPrivilegeEscalation: false`;
             * the capability drop is absent on a service that declared `unhardened: true`, and the
             * uid:gid is present on one that declared `user`.
             */
            securityContext: {
                allowPrivilegeEscalation: false;
                capabilities?: { drop: string[] };
                runAsNonRoot?: true;
                runAsUser?: number;
                runAsGroup?: number;
            };
            env: { name: string; value: string }[];
        }[];
    };
} {
    const labels = {
        [JOB_LABEL]: job.id,
        [LEASE_LABEL]: job.leaseToken,
        [SERVICE_LABEL]: spec.name,
        [FLEET_LABEL]: serviceSubdomain(job),
        // The declared opt-out, surfaced to admission (#382). Absent unless the file asked.
        ...(spec.unhardened ? { [UNHARDENED_LABEL]: 'true' } : {}),
        ...releaseLabel(config),
    };
    return {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
            name: servicePodName(job, spec.name),
            labels,
            ...doNotDisruptField(config),
            ownerReferences: [
                {
                    apiVersion: 'v1',
                    kind: 'Service',
                    name: serviceSubdomain(job),
                    uid: ownerUid,
                    blockOwnerDeletion: false,
                    controller: false,
                },
            ],
        },
        spec: {
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            // The seccomp profile is on every service pod, opt-out or not (#382): what breaks a
            // stock image is the capability drop below, never the syscall filter.
            securityContext: { ...podHardeningField() },
            // The declared name as the pod's hostname under the attempt's subdomain: the DNS
            // record the runner's and gates' search domain resolves `db` to (serviceSubdomain).
            // The bellows parser constrains names to lowercase DNS labels, so it is legal as-is.
            hostname: spec.name,
            subdomain: serviceSubdomain(job),
            ...pullSecretsField(config),
            ...schedulingField(config),
            containers: [
                {
                    name: spec.name,
                    image: spec.image,
                    imagePullPolicy: config.imagePullPolicy,
                    ...resourcesField(config),
                    // The opt-out's whole reach (#382): a service that declared `unhardened: true`
                    // keeps the image's default capability set, because a root entrypoint that
                    // chowns its data directory needs CHOWN/DAC_OVERRIDE/FOWNER back. It does not
                    // need to ESCALATE to do that, so that bit stays off either way — the drop is
                    // the only half a stock image trips over.
                    securityContext: {
                        ...(spec.unhardened
                            ? { allowPrivilegeEscalation: false as const }
                            : containerHardeningField().securityContext),
                        // The declared uid:gid — the same reach as docker's `--user`.
                        ...(spec.user
                            ? { runAsNonRoot: true as const, runAsUser: spec.user.uid, runAsGroup: spec.user.gid }
                            : {}),
                    },
                    env: spec.environment.map(({ key, value }) => {
                        if (!SERVICE_ENV_KEY.test(key)) {
                            throw new Error(
                                `refusing to run job ${job.id}: "${key}" is not a valid environment variable name`
                            );
                        }
                        return { name: key, value };
                    }),
                },
            ],
        },
    };
}

/**
 * The attempt's service DNS, as ONE headless Service named `serviceSubdomain(job)`. THIS is the
 * whole feature under kubernetes: each service pod sets `hostname: <declared name>` and
 * `subdomain: <this Service>`, so `<name>.<subdomain>.<namespace>.svc` resolves to it, and the
 * runner and gate pods carry that domain as a search domain (fleetDnsField) — `postgres://db:5432`
 * resolves for exactly this attempt. The name is attempt-scoped, never the declared one, so two
 * concurrent jobs both declaring `db` never meet at the apiserver.
 *
 * Headless (`clusterIP: None`) because the gate endpoint aside, the runner must reach the
 * service's EPHEMERAL container ports, and no port list was declared — `ports:` is an unknown
 * key in `.bellows.yaml` by design. A headless Service publishes A records straight to the
 * matching pods, which is exactly the "any port, direct to the container" semantics docker's
 * network alias had. It selects by the fleet label, which only service pods carry.
 */
export function serviceDnsSpec(
    config: DriverConfig,
    job: BoardJob
): {
    apiVersion: 'v1';
    kind: 'Service';
    metadata: { name: string; labels: Record<string, string> };
    spec: { clusterIP: 'None'; selector: Record<string, string> };
} {
    const subdomain = serviceSubdomain(job);
    return {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
            name: subdomain,
            // factory.service is what the lease-scoped teardown selects on (byLease below) and
            // what the orphan reaper's scan pairs with factory.job; the release label rides along
            // like it does on the service pods, so a shared-namespace reaper scopes to one
            // release's fleets and never touches a neighbour's (issue #301).
            labels: {
                [JOB_LABEL]: job.id,
                [LEASE_LABEL]: job.leaseToken,
                [SERVICE_LABEL]: subdomain,
                ...releaseLabel(config),
            },
        },
        spec: {
            clusterIP: 'None',
            selector: { [FLEET_LABEL]: subdomain },
        },
    };
}

export const podsPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/pods`;

/** The pods of one Job, by the `job-name` label the Job controller stamps on every pod it owns. */
export const jobPodsPath = (namespace: string, jobName: string): string =>
    `${podsPath(namespace)}?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`;

/**
 * One pod's log, tailed to `LOG_TAIL_LINES` by default — the full log when `tail` is null. A pod
 * with several containers (the runner's) answers 400 without `container`, the one whose log it is.
 */
export const podLogPath = (
    namespace: string,
    pod: string,
    tail: number | null = LOG_TAIL_LINES,
    container?: string
): string => {
    const query = [
        ...(tail !== null ? [`tailLines=${tail}`] : []),
        ...(container !== undefined ? [`container=${container}`] : []),
    ];
    return `${podsPath(namespace)}/${pod}/log${query.length > 0 ? `?${query.join('&')}` : ''}`;
};

/** One object's events, by name: read for why a service pod vanished (issue #560). */
export const eventsForPath = (namespace: string, name: string): string =>
    `/api/v1/namespaces/${namespace}/events?fieldSelector=${encodeURIComponent(`involvedObject.name=${name}`)}`;

export const secretsPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/secrets`;

/**
 * Label-scoped collection paths: by JOB for the re-claim fence — every OTHER attempt's, so the
 * fleet the loop started for this one before the runner survives it — by LEASE for this attempt's
 * own teardown. The teardown selectors additionally require the `factory.service` key to exist —
 * the set-based `,factory.service` at the end — because the runner pod and every gate pod carry
 * the same lease label, and only the service fleet may die at teardown.
 */
const otherAttempts = (job: BoardJob): string =>
    encodeURIComponent(`${JOB_LABEL}=${job.id},${LEASE_LABEL}!=${job.leaseToken}`);
const byJob = (path: string, job: BoardJob): string => `${path}?labelSelector=${otherAttempts(job)}`;
const byLease = (path: string, job: BoardJob): string =>
    `${path}?labelSelector=${encodeURIComponent(`${LEASE_LABEL}=${job.leaseToken}`)},${SERVICE_LABEL}`;

export const podsSelectorPath = (namespace: string, job: BoardJob): string => byJob(podsPath(namespace), job);
export const servicesPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/services`;
export const servicesSelectorPath = (namespace: string, job: BoardJob): string => byJob(servicesPath(namespace), job);
export const podsByLeasePath = (namespace: string, job: BoardJob): string => byLease(podsPath(namespace), job);
export const servicesByLeasePath = (namespace: string, job: BoardJob): string => byLease(servicesPath(namespace), job);

export const jobPath = (namespace: string, name: string): string => `${jobsPath(namespace)}/${name}`;

/**
 * Delete one Job by name, swallowing the answer — the shape almost every aux/runner/gate Job's
 * teardown wants: reaped once its verdict has been read, and nobody downstream branches on
 * whether the delete actually landed. `Foreground` is what `takeSyncJobDown`/`takeReclaimJobDown`
 * await before handing the checkout back — the delete returns only once the Job's dependents are
 * gone, so a released claim can never overlap a pod still writing the tree.
 */
export function deleteJob(
    deps: K8sDeps,
    name: string,
    propagationPolicy: 'Background' | 'Foreground' = 'Background'
): Promise<void> {
    return deps
        .request('DELETE', `${jobPath(deps.config.k8sNamespace, name)}?propagationPolicy=${propagationPolicy}`)
        .then(
            () => undefined,
            () => undefined
        );
}

/** Delete one Secret by name, swallowing the answer — the same fire-and-forget shape as `deleteJob`. */
export function deleteSecret(deps: K8sDeps, name: string): Promise<void> {
    return deps.request('DELETE', `${secretsPath(deps.config.k8sNamespace)}/${name}`).then(
        () => undefined,
        () => undefined
    );
}

/**
 * The label-scoped collection path every attempt of a job shares. The lease token never repeats,
 * so attempt-scoped names cannot find a previous attempt's leftovers — the `factory.job` label is
 * the one identifier they all carry, and it is what the fence selects on, sparing this attempt's own.
 */
export const jobsSelectorPath = (namespace: string, job: BoardJob): string => byJob(jobsPath(namespace), job);

/**
 * The checkout claim: one ConfigMap per JOB id, the one job-scoped name this runner ever writes,
 * and the atom that makes the re-claim fence a mutex instead of a GET-then-POST race. The
 * apiserver's name uniqueness arbitrates — POST it and a `409` means somebody else holds the
 * checkout — while `data.claimSeq` (the board's monotonic per-job claim sequence, never a clock
 * and never the refundable attempt counter, issue #559) orders the contenders: a claim whose
 * sequence is ahead of ours is our replacement's, and we stand down. A ConfigMap and not a Secret
 * because the protocol needs `get`, and granting `get` on secrets would expose every attempt's env
 * values; this object carries a holder token and a claim sequence, both already known to the driver.
 *
 * Keyed by the JOB id and never the thread root, even though worktreeDir keys the TREE by root:
 * the board serializes claims per thread root server-side (a separate fix), so cross-row
 * exclusion happens there — and a root-scoped claim NAME would break the attempt-ordered
 * stale-holder takeover across follow-up rows, where a leaked row-1 claim carrying attempt 3
 * would stand down row 2's attempt 1 forever.
 *
 * Everything else stays attempt-scoped: names carrying the lease token are what keep a
 * superseded attempt's cleanup from ever reaching the winner's objects.
 */
export const claimName = (job: BoardJob): string => {
    if (!JOB_ID.test(job.id)) {
        throw new Error(`refusing to address a job id that is not a uuid: ${job.id}`);
    }
    return `factory-job-${job.id}-claim`;
};

export const configmapsPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/configmaps`;

export const claimPath = (namespace: string, job: BoardJob): string => `${configmapsPath(namespace)}/${claimName(job)}`;

/** The claim object this attempt POSTs. `data` values are strings — the apiserver rejects numbers. */
export const claimBody = (job: BoardJob) => ({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
        name: claimName(job),
        labels: { [JOB_LABEL]: job.id, [LEASE_LABEL]: job.leaseToken },
    },
    data: { holder: job.leaseToken, claimSeq: String(job.claimSeq) },
});
