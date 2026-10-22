import { JOB_LABEL, LEASE_LABEL } from './labels.js';
import type { BoardJob } from './board.js';
import { jobsPath } from './k8s-podspec.js';
import { JOB_ID, LOG_TAIL_LINES } from './k8s-transport.js';
import type { K8sDeps } from './k8s-transport.js';

/**
 * The shared naming and path helpers (the checkout claim's ConfigMap, the runner's per-attempt
 * Secret, the pods and their logs) every `k8s-*.ts` file addresses these objects by. The sync, the
 * reclaim, the publish steps, the helpers, the gates and the declared services are no objects of
 * their own: the task supervisor and its pod's sidecars run them (`supervised-steps.ts`). See
 * docs/kubernetes.md for the full module map.
 */

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

export const secretsPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/secrets`;

/** Label-scoped collection paths by JOB for the re-claim fence: every OTHER attempt's. */
const otherAttempts = (job: BoardJob): string =>
    encodeURIComponent(`${JOB_LABEL}=${job.id},${LEASE_LABEL}!=${job.leaseToken}`);
const byJob = (path: string, job: BoardJob): string => `${path}?labelSelector=${otherAttempts(job)}`;

export const podsSelectorPath = (namespace: string, job: BoardJob): string => byJob(podsPath(namespace), job);

export const jobPath = (namespace: string, name: string): string => `${jobsPath(namespace)}/${name}`;

/**
 * Delete one Job by name, swallowing the answer — the shape almost every aux/runner Job's
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
 * Keyed by the JOB id and never the thread root, even though checkoutDir keys the TREE by root:
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
