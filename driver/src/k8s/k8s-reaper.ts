import type { BoardJob } from '../board/board.js';
import type { DriverConfig } from '../config.js';
import {
    HTTP_CONFLICT,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    JOB_ID,
    type K8sDeps,
    type K8sRequest,
} from './k8s-transport.js';
import { claimPath, secretsPath } from './k8s-auxspec.js';
import { readObserved, releaseClaimAfterGroupEnd } from './k8s-fence.js';
import { holderGroupsOf } from './k8s-group.js';
import { abortableSleep } from '../poll.js';
import { asIdentified } from './k8s-pod-shapes.js';
import { readTypedList } from './k8s-poll.js';
import { finishedAgentRun, jobsPath, type ListedRunnerJob, runnerJobName, secretName } from './k8s-podspec.js';
import { isLease, runnerSpecReadable } from './k8s-shapes.js';
import { HOLDER_LABEL, JOB_LABEL, LEASE_LABEL } from '../labels.js';
import type {
    OrphanGroup,
    OrphanObject,
    ReapInconclusive,
    ReaperArm,
    ReapVerdict,
    VolumeListing,
    VolumeThread,
} from '../reaper.js';
import { taskVolumesPath } from './k8s-task-volume.js';
import { TASK_BOARD_LABEL, TASK_ROOT_LABEL, boardIdentity, generationOfName } from '../task-volume.js';
import { parseRfc3339 } from '../timestamps.js';

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
    metadata: {
        name: string;
        uid: string;
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

/**
 * One listed item as far as the scan reads it (#869): an item carrying the job and the lease label
 * is in scope, and must be dated; any job, lease or holder label it carries must be a uuid — a
 * corrupt one would become an attempt identity the grouping files it under, and the group's board
 * lookup would condemn a live attempt's objects. A Job named as the runner of its pair must have a
 * readable spec (`unreadRunner` decides on it). An item that is not this makes the whole list
 * inconclusive, and the scan answers nothing rather than a group built from the rest. An item out of
 * scope is skipped later.
 */
const asListedItem =
    (kind: OrphanObject['kind']) =>
    (value: unknown): ListedItem | null => {
        const item = asIdentified<ListedItem>(value);
        if (item === null) return null;
        const labels = item.metadata.labels;
        const [jobId, leaseToken, holder] = [JOB_LABEL, LEASE_LABEL, HOLDER_LABEL].map((label) => labels?.[label]);
        if ([jobId, leaseToken, holder].some((label) => label !== undefined && !isLease(label))) return null;
        if (jobId === undefined || leaseToken === undefined) return item;
        const created = item.metadata.creationTimestamp;
        if (created === undefined || parseRfc3339(created) === null) return null;
        return kind !== 'job' || runnerSpecReadable(item, attemptPair(jobId, leaseToken)) ? item : null;
    };

/** One label-selector collection GET, parsed into the fields the grouping needs; null when it proves nothing. */
const listBySelector = async (
    deps: K8sDeps,
    path: string,
    what: string,
    kind: OrphanObject['kind']
): Promise<ListedItem[] | null> => {
    const read = await readTypedList(deps, path, what, { entry: asListedItem(kind), once: true });
    if (read.kind === 'inconclusive') return null;
    return read.kind === 'absent' ? [] : read.value;
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
    const { name, uid } = item.metadata;
    const jobId = item.metadata.labels?.[JOB_LABEL];
    const leaseToken = item.metadata.labels?.[LEASE_LABEL];
    const created = item.metadata.creationTimestamp;
    if (!name || !jobId || !leaseToken || created === undefined) return null;
    const createdAtMs = parseRfc3339(created);
    if (createdAtMs === null) return null;
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
        uid,
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

const scan = async (deps: K8sDeps): Promise<OrphanGroup[] | null> => {
    const { config } = deps;
    const jobs = await listBySelector(
        deps,
        `${jobsPath(config.k8sNamespace)}?labelSelector=${encodeURIComponent(selectorFor(config))}`,
        'listing the jobs',
        'job'
    );
    if (jobs === null) return null;
    const groups = new Map<string, OrphanGroup>();
    for (const item of jobs) {
        const found = groupKeyOf(item, 'job');
        if (found) mergeIntoGroups(groups, `${found.jobId}|${found.leaseToken}`, found);
    }
    return [...groups.values()];
};

/** How one named delete landed: removed it this call, it was already going (404/409), or it
 * failed — a transport rejection or an unexpected status is the next round's problem. */
type DeleteResult = 'removed' | 'gone' | 'replaced' | 'failed';

const deleteNamed = async (request: K8sRequest, path: string, uid?: string): Promise<DeleteResult> => {
    try {
        const response = await (uid
            ? request('DELETE', path, { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid } })
            : request('DELETE', path));
        // A 409 under a uid precondition is another incarnation under the name, not the listed
        // one going away: no removal, and nothing that lets the round go on to the claim.
        if (uid && response.status === HTTP_CONFLICT) return 'replaced';
        if (response.status >= HTTP_ERROR_STATUS) return response.status === HTTP_NOT_FOUND ? 'gone' : 'failed';
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
 * from. Already-gone Secrets (404) never hold the teardown back. The names hash the OLD
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

const reap = async (
    deps: K8sDeps,
    group: OrphanGroup,
    verdict: ReapVerdict
): Promise<readonly string[] | ReapInconclusive> => {
    const { config, request } = deps;
    const paths = basePathOf(config);
    const removed: string[] = [];
    if (uuidScoped(group) && !(await reapDerivedSecrets(config, request, group, removed))) {
        return { removed, inconclusive: 'an attempt Secret delete failed' };
    }
    // `held` stops the round before the claim (a failed or replaced delete); `unconfirmed` is only the failed.
    let held = false;
    let unconfirmed: string | null = null;
    for (const object of group.objects) {
        const result = await deleteNamed(
            request,
            `${paths[object.kind]}/${object.name}?propagationPolicy=Foreground`,
            object.uid
        );
        if (result === 'removed') removed.push(`${object.kind} ${object.name}`);
        if (result === 'failed') unconfirmed ??= `deleting ${object.kind} ${object.name} failed`;
        if (result === 'failed' || result === 'replaced') held = true;
    }
    // The checkout claim is JOB-scoped — the one name a replacement attempt can hold — so only a
    // provably dead job's claim may be removed, and only once nothing of this round failed: a
    // superseded attempt's group must never touch it, the live attempt's fence is holding it. It
    // goes the one way a claim ever goes (issue #821): the incarnation read here, both groups its
    // holder can have left ended the acknowledged way and confirmed gone, then the uid-preconditioned
    // delete — anything short of that is deferred to a later round, never deleted on a maybe.
    // Answered in the log like the fleet's objects, so "is the reaper running?" stays answerable
    // from a round that only cleaned Secrets.
    if (unconfirmed !== null) return { removed, inconclusive: unconfirmed };
    if (!uuidScoped(group) || verdict !== 'gone' || held) return removed;
    return releaseDeadClaim(deps, group, removed);
};

/** The condemned job's checkout claim, released the one confirmed way; told apart when a read proved nothing. */
const releaseDeadClaim = async (
    deps: K8sDeps,
    group: OrphanGroup & { leaseToken: string },
    removed: string[]
): Promise<readonly string[] | ReapInconclusive> => {
    const { config } = deps;
    const job = attemptPair(group.jobId, group.leaseToken);
    let inconclusive: string | null = null;
    const onUnproven = (reason: string) => {
        inconclusive ??= reason;
    };
    // A refused read, or a claim answered without its identity, proves nothing; a confirmed absence is gone.
    const observed = await readObserved(deps, job, onUnproven);
    if (observed === null) return inconclusive === null ? removed : { removed, inconclusive };
    if (!JOB_ID.test(observed.holder)) return removed;
    // Only the condemned attempt's own claim — held by its lease, or by the reclaim whose derived
    // token it is: a holder that is neither is a replacement's (the task reopened since the board
    // answered), and nothing of it is touched.
    const servesHolder = group.objects.some((object) => object.holder === observed.holder);
    if (observed.holder !== group.leaseToken && !servesHolder) return removed;
    const groups = await holderGroupsOf(deps, job, observed.holder);
    if (groups === null) return { removed, inconclusive: 'listing the holder groups proved nothing' };
    if (await releaseClaimAfterGroupEnd(deps, job, { groups, observed, onUnproven })) {
        removed.push(`claim ${claimPath(config.k8sNamespace, job).split('/').pop()}`);
    }
    return inconclusive === null ? removed : { removed, inconclusive };
};

/** One listed task volume claim, as far as the scan reads it: its thread, its name and the incarnation. */
interface ListedVolumeClaim {
    root: string;
    name: string;
    uid: string;
    createdAtMs: number | null;
    terminating: boolean;
}

/** A labelled claim that is no thread's generation: skipped and logged, never a reason to delete nothing fleet-wide. */
interface JunkVolumeClaim {
    junk: string;
}

/**
 * A claim of the task volume listing (issue #775): null when it is not an identified object at all (the
 * list proved nothing), `junk` when it is one whose root label names no thread it is a generation of.
 */
const asVolumeClaim = (value: unknown, board: string): ListedVolumeClaim | JunkVolumeClaim | 'foreign' | null => {
    const item = asIdentified<{
        metadata: {
            name: string;
            uid: string;
            labels?: Record<string, string>;
            deletionTimestamp?: string;
            creationTimestamp?: string;
        };
    }>(value);
    if (item === null) return null;
    const { name, uid, labels, deletionTimestamp, creationTimestamp } = item.metadata;
    if (labels?.[TASK_BOARD_LABEL] !== board) return 'foreign';
    const root = labels?.[TASK_ROOT_LABEL];
    if (typeof root !== 'string' || !isLease(root) || generationOfName(root, name) === null) {
        return {
            junk: `task volume claim ${name}: its root label (${String(root)}) names no thread it is a generation of`,
        };
    }
    return {
        root: root.toLowerCase(),
        name,
        uid,
        createdAtMs: typeof creationTimestamp === 'string' ? parseRfc3339(creationTimestamp) : null,
        terminating: deletionTimestamp !== undefined,
    };
};

/**
 * Every task volume claim, by its root label, all generations — the unschedulable-labelled included —
 * grouped by thread (issue #775). Null when the list proved nothing: a refused call, an absent
 * collection, or a claim that cannot be named a generation of its labelled root. A claim already
 * terminating is on its way out and left out.
 */
const scanVolumes = async (deps: K8sDeps): Promise<VolumeListing | null> => {
    const read = await readTypedList(
        deps,
        `${taskVolumesPath(deps.config.k8sNamespace)}?labelSelector=${encodeURIComponent(TASK_ROOT_LABEL)}`,
        'listing the task volumes',
        { entry: (value) => asVolumeClaim(value, boardIdentity(deps.config)), once: true }
    );
    if (read.kind !== 'value') return null;
    const threads = new Map<string, VolumeThread>();
    const skipped: string[] = [];
    for (const claim of read.value) {
        if (claim === 'foreign') continue;
        if ('junk' in claim) {
            skipped.push(claim.junk);
            continue;
        }
        if (claim.terminating) continue;
        const thread = threads.get(claim.root) ?? { root: claim.root, volumes: [] };
        thread.volumes.push({ name: claim.name, uid: claim.uid, createdAtMs: claim.createdAtMs });
        threads.set(claim.root, thread);
    }
    return { threads: [...threads.values()], skipped };
};

/** Deletes every listed generation, each under the uid it was listed with; one that fails is the next round's. */
const reapVolumes = async (deps: K8sDeps, thread: VolumeThread): Promise<readonly string[] | ReapInconclusive> => {
    const removed: string[] = [];
    let unconfirmed: string | null = null;
    for (const volume of thread.volumes) {
        const path = `${taskVolumesPath(deps.config.k8sNamespace)}/${volume.name}`;
        const result = await deleteNamed(deps.request, path, volume.uid);
        if (result === 'removed') removed.push(`volume ${volume.name}`);
        if (result === 'failed') unconfirmed ??= `deleting volume ${volume.name} failed`;
    }
    return unconfirmed === null ? removed : { removed, inconclusive: unconfirmed };
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
    sleep = abortableSleep,
}: {
    config: DriverConfig;
    request: K8sRequest;
    sleep?: (ms: number) => Promise<void>;
}): ReaperArm {
    const deps: K8sDeps = { config, request, sleep };
    return {
        scan: () => scan(deps),
        reap: (group, verdict) => reap(deps, group, verdict),
        scanVolumes: () => scanVolumes(deps),
        reapVolumes: (thread) => reapVolumes(deps, thread),
    };
}
