import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import {
    HTTP_CONFLICT,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    HTTP_OK_STATUS,
    JOB_ID,
    parse,
    wait,
    type K8sDeps,
    type K8sRequest,
    type K8sResponse,
} from './k8s-transport.js';
import { claimPath, secretsPath } from './k8s-auxspec.js';
import { releaseClaimAfterGroupEnd } from './k8s-fence.js';
import { holderGroupsOf } from './k8s-group.js';
import { finishedAgentRun, jobsPath, type ListedRunnerJob, runnerJobName, secretName } from './k8s-podspec.js';
import { HOLDER_LABEL, JOB_LABEL, LEASE_LABEL } from './labels.js';
import type { OrphanGroup, OrphanObject, ReaperArm, ReapVerdict } from './reaper.js';

/**
 * The kubernetes half of the orphan reaper (issue #301): enumerate the Jobs the driver's crashed
 * attempts left behind — a declared service is a sidecar of its attempt's pod (issue #773), so it
 * goes with its Job — and delete them when the board condemns the owning job. The
 * counterpart of the re-claim fence — the fence acts on the job label at CLAIM time, under the
 * checkout claim; this arm acts on it when the BOARD says no claim can ever be taken again.
 *
 * RBAC needs nothing new: `list` on jobs is the fence's grant, `delete` on all resource
 * kinds is already the chart's Role. `list secrets` stays deliberately ungranted — which is why
 * the attempt-scoped env Secret is reaped by DERIVED NAME, never enumerated. Its name hashes the
 * same (job id, lease token) pair the labels carry, so it is derivable: the sync, publish, helper
 * and gate steps run in the task group and have no Secret of their own, which is also why no
 * nonce-named Secret is left for this arm to miss. A
 * runner Job its driver suspended because its teardown went unconfirmed (`k8s-teardown.ts`) is
 * the anchor those names are derived from: reaped, never adopted. A gone job's checkout claim goes
 * through the fence's one deletion (`releaseClaimAfterGroupEnd`), never on an unconfirmed end.
 */

/** The two status codes a reaper delete can answer with that mean "already going away". */
const GONE_STATUSES: readonly number[] = [HTTP_NOT_FOUND, HTTP_CONFLICT];

/** Every kind the arm deletes, with its collection path — one table, not a branch per kind. */
const basePathOf = (config: DriverConfig): Record<OrphanObject['kind'], string> => ({
    job: jobsPath(config.k8sNamespace),
    // The docker-only kinds never reach this arm's table; the record must still be total.
    container: '',
    volume: '',
});

/**
 * The (job id, lease token) pair, dressed as the BoardJob the shared naming helpers read — they
 * touch exactly these two fields and assert both are uuids, and this call site has already
 * tested both before reaching here.
 */
const attemptPair = (jobId: string, leaseToken: string): BoardJob => ({ id: jobId, leaseToken }) as BoardJob;

interface ListedItem extends ListedRunnerJob {
    metadata?: {
        name?: string;
        uid?: string;
        labels?: Record<string, string>;
        creationTimestamp?: string;
    };
}

/**
 * A finished runner Job — its name is the (job, lease) hash no aux Job shares — that nobody has read
 * yet. A Job its driver suspended because its teardown could not be confirmed (issue #821) is no
 * run to adopt: it is reaped, Secrets first.
 */
const unreadRunner = (item: ListedItem, jobId: string, leaseToken: string): boolean =>
    JOB_ID.test(jobId) && JOB_ID.test(leaseToken) && finishedAgentRun(item, attemptPair(jobId, leaseToken));

/** One label-selector collection GET, parsed into the fields the grouping needs. */
const listBySelector = async (request: K8sRequest, path: string): Promise<ListedItem[] | null> => {
    let response: K8sResponse;
    try {
        response = await request('GET', path);
    } catch {
        return null;
    }
    if (response.status < HTTP_OK_STATUS || response.status >= HTTP_ERROR_STATUS) return null;
    return parse<{ items?: ListedItem[] }>(response.body).items ?? [];
};

/** Select attempt Jobs within this release; never sweep another release. */
const selectorFor = (config: DriverConfig): string => {
    const terms = [JOB_LABEL, LEASE_LABEL];
    if (config.k8sRelease) terms.push(`app.kubernetes.io/instance=${config.k8sRelease}`);
    return terms.join(',');
};

/** One listed item → its identity and age, or null when the row cannot be named or dated. */
const groupKeyOf = (
    item: ListedItem,
    kind: OrphanObject['kind']
): {
    jobId: string;
    leaseToken: string;
    name: string;
    object: OrphanObject;
    createdAtMs: number;
} | null => {
    const name = item.metadata?.name;
    const jobId = item.metadata?.labels?.[JOB_LABEL];
    const leaseToken = item.metadata?.labels?.[LEASE_LABEL];
    const created = item.metadata?.creationTimestamp;
    if (!name || !jobId || !leaseToken || created === undefined) return null;
    const createdAtMs = Date.parse(created);
    if (Number.isNaN(createdAtMs)) return null;
    const isRunner =
        kind === 'job' &&
        JOB_ID.test(jobId) &&
        JOB_ID.test(leaseToken) &&
        name === runnerJobName(attemptPair(jobId, leaseToken));
    const object: OrphanObject = {
        kind,
        name,
        ...(kind === 'job' && unreadRunner(item, jobId, leaseToken) ? { unread: true as const } : {}),
        // A live job's runner Job, running or not, is its next claim's fence's (issue #821).
        ...(isRunner ? { runner: true as const } : {}),
        // The incarnation listed: its delete names that one only.
        ...(item.metadata?.uid ? { uid: item.metadata.uid } : {}),
        // The checkout holder a reclaim group serves: whose claim its reap may act on.
        ...(item.metadata?.labels?.[HOLDER_LABEL] ? { holder: item.metadata.labels[HOLDER_LABEL] } : {}),
    };
    return { jobId, leaseToken, name, object, createdAtMs };
};

const mergeIntoGroups = (
    groups: Map<string, OrphanGroup>,
    key: string,
    found: NonNullable<ReturnType<typeof groupKeyOf>>
): void => {
    const existing = groups.get(key);
    if (existing) {
        existing.objects.push(found.object);
        if (found.createdAtMs < existing.createdAtMs) existing.createdAtMs = found.createdAtMs;
    } else {
        groups.set(key, {
            jobId: found.jobId,
            leaseToken: found.leaseToken,
            createdAtMs: found.createdAtMs,
            objects: [found.object],
        });
    }
};

const scan = async (config: DriverConfig, request: K8sRequest): Promise<OrphanGroup[]> => {
    const jobs = await listBySelector(
        request,
        `${jobsPath(config.k8sNamespace)}?labelSelector=${encodeURIComponent(selectorFor(config))}`
    );
    if (jobs === null) return [];
    const groups = new Map<string, OrphanGroup>();
    for (const item of jobs) {
        const found = groupKeyOf(item, 'job');
        if (found) mergeIntoGroups(groups, `${found.jobId}|${found.leaseToken}`, found);
    }
    return [...groups.values()];
};

/** How one named delete landed: removed it this call, it was already going (404/409), or it
 * failed — a transport rejection or an unexpected status is the next round's problem. */
type DeleteResult = 'removed' | 'gone' | 'failed';

const deleteNamed = async (request: K8sRequest, path: string, uid?: string): Promise<DeleteResult> => {
    try {
        const response = await (uid
            ? request('DELETE', path, { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid } })
            : request('DELETE', path));
        // A 409 under a uid precondition is another incarnation under the name, not the listed
        // one going away: no removal, and nothing that lets the round go on to the claim.
        if (uid && response.status === HTTP_CONFLICT) return 'failed';
        if (response.status >= HTTP_ERROR_STATUS) return GONE_STATUSES.includes(response.status) ? 'gone' : 'failed';
        return 'removed';
    } catch {
        return 'failed';
    }
};

/** The attempt-scoped env Secret, re-derived through the builder that created it. */
const derivedSecretPaths = (config: DriverConfig, group: OrphanGroup): string[] => {
    const job = attemptPair(group.jobId, group.leaseToken!);
    const namespace = config.k8sNamespace;
    // Every one of these hashes the same (job id, lease token) pair the labels carry — see the
    // file header for why the helper env Secret is the one left out.
    return [`${secretsPath(namespace)}/${secretName(job)}`];
};

const uuidScoped = (group: OrphanGroup): group is OrphanGroup & { leaseToken: string } =>
    group.leaseToken !== null && JOB_ID.test(group.jobId) && JOB_ID.test(group.leaseToken);

/**
 * The attempt-scoped env Secrets, deleted FIRST — before the Job, and one failed
 * delete stops the round (answers false): a Secret has no ownerReferences, so once the listed
 * objects are gone no next scan can rediscover the (job, lease) pair these names are hashed
 * from. Already-gone Secrets (404/409) never hold the teardown back. The names hash the OLD
 * lease token, so this ordering never reaches a replacement attempt's resources.
 */
const reapDerivedSecrets = async (
    config: DriverConfig,
    request: K8sRequest,
    group: OrphanGroup & { leaseToken: string },
    removed: string[]
): Promise<boolean> => {
    for (const path of derivedSecretPaths(config, group)) {
        const result = await deleteNamed(request, path);
        if (result === 'failed') return false;
        if (result === 'removed') removed.push(`secret ${path.split('/').pop()}`);
    }
    return true;
};

/** The claim of the group's job as it reads now — the incarnation the claim reap may act on — or null. */
const observedClaim = async (deps: K8sDeps, job: BoardJob): Promise<{ uid: string; holder: string } | null> => {
    try {
        const read = await deps.request('GET', claimPath(deps.config.k8sNamespace, job));
        if (read.status < HTTP_OK_STATUS || read.status >= HTTP_ERROR_STATUS) return null;
        const claim = parse<{ metadata?: { uid?: string }; data?: { holder?: string } }>(read.body);
        const uid = claim.metadata?.uid;
        const holder = claim.data?.holder;
        return uid && holder ? { uid, holder } : null;
    } catch {
        return null;
    }
};

const reap = async (deps: K8sDeps, group: OrphanGroup, verdict: ReapVerdict): Promise<readonly string[]> => {
    const { config, request } = deps;
    const paths = basePathOf(config);
    const removed: string[] = [];
    if (uuidScoped(group) && !(await reapDerivedSecrets(config, request, group, removed))) return removed;
    let failed = false;
    for (const object of group.objects) {
        const result = await deleteNamed(
            request,
            `${paths[object.kind]}/${object.name}?propagationPolicy=Foreground`,
            object.uid
        );
        if (result === 'removed') removed.push(`${object.kind} ${object.name}`);
        if (result === 'failed') failed = true;
    }
    // The checkout claim is JOB-scoped — the one name a replacement attempt can hold — so only a
    // provably dead job's claim may be removed, and only once nothing of this round failed: a
    // superseded attempt's group must never touch it, the live attempt's fence is holding it. It
    // goes the one way a claim ever goes (issue #821): the incarnation read here, both groups its
    // holder can have left ended the acknowledged way and confirmed gone, then the uid-preconditioned
    // delete — anything short of that is deferred to a later round, never deleted on a maybe.
    // Answered in the log like the fleet's objects, so "is the reaper running?" stays answerable
    // from a round that only cleaned Secrets.
    if (!uuidScoped(group) || verdict !== 'gone' || failed) return removed;
    const job = attemptPair(group.jobId, group.leaseToken);
    const observed = await observedClaim(deps, job);
    if (observed === null || !JOB_ID.test(observed.holder)) return removed;
    // Only the condemned attempt's own claim — held by its lease, or by the reclaim whose derived
    // token it is: a holder that is neither is a replacement's (the task reopened since the board
    // answered), and nothing of it is touched.
    const servesHolder = group.objects.some((object) => object.holder === observed.holder);
    if (observed.holder !== group.leaseToken && !servesHolder) return removed;
    const groups = await holderGroupsOf(deps, job, observed.holder);
    if (groups !== null && (await releaseClaimAfterGroupEnd(deps, job, { groups, observed }))) {
        removed.push(`claim ${claimPath(config.k8sNamespace, job).split('/').pop()}`);
    }
    return removed;
};

/**
 * The arm. See the file header for the posture; `scan` is one collection GET, `reap` is the
 * derived-name Secret deletes FIRST — one failure stops the round, since nothing rediscoverable
 * would survive it — then one Foreground delete per named object and — only on a provably dead
 * job whose holder's groups are confirmed ended — the checkout claim. `sleep` paces that
 * confirmation.
 */
export function createKubernetesReaper({
    config,
    request,
    sleep = wait,
}: {
    config: DriverConfig;
    request: K8sRequest;
    sleep?: (ms: number) => Promise<void>;
}): ReaperArm {
    const deps: K8sDeps = { config, request, sleep };
    return {
        scan: () => scan(config, request),
        reap: (group, verdict) => reap(deps, group, verdict),
    };
}
