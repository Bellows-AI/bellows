import type { BoardJob } from '../board/board.js';
import { claimPath, jobPath, podsPath, secretsPath } from './k8s-auxspec.js';
import { secretName } from './k8s-podspec.js';
import { asPod } from './k8s-pod-shapes.js';
import { asJob, jobOutcome, type ReadJobObject, readTyped, readTypedList } from './k8s-poll.js';
import { pollFor } from '../poll.js';
import { boundedBy, HTTP_CONFLICT, HTTP_NOT_FOUND, is2xx, POLL_MS, waitOf } from './k8s-transport.js';
import type { K8sDeps, K8sPod, K8sResponse } from './k8s-transport.js';
import type { Read } from '../runner.js';
import { HOLDER_LABEL, JOB_LABEL, LEASE_LABEL } from '../labels.js';

/**
 * The acknowledged end of one runner Job — an attempt's task group (issue
 * #821). Nothing can find an attempt's Secrets once its Job is gone (the driver has no `list` on
 * secrets, and every later pass derives their names from a listed Job), so the Secrets go first,
 * each delete's answer read; a refused one leaves the Job suspended rather than deleted, its pod
 * ended and the Job still listed for the fence and the reaper to derive the Secrets from. Only a
 * Job read gone with no writer pod left is ended; anything short of that is held, recorded
 * against the checkout holder, and the claim is kept (`releaseClaimAfterGroupEnd`).
 */

/**
 * How long ending a group may wait for its Job and its writer pods to be gone — above the runner
 * pod's default 30 s termination grace period, since a Foreground delete keeps the Job readable
 * until the kubelet has ended its pod.
 */
export const GROUP_END_WAIT_MS = 45_000;

/**
 * How one acknowledged delete landed: removed now, already gone (404), another incarnation under
 * the name (409 on a uid precondition: not this caller's to touch), or anything else.
 */
export type SecretDelete = 'removed' | 'gone' | 'superseded' | 'failed';

/** The DeleteOptions naming one incarnation, when the caller knows the uid it created. */
const preconditioned = (uid: string | undefined): unknown =>
    uid ? { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid } } : undefined;

/** A delete's answer as a `SecretDelete`; a 409 is another incarnation only under a uid precondition. */
function deleteAnswer(response: K8sResponse, uid: string | undefined): SecretDelete {
    if (response.status === HTTP_NOT_FOUND) return 'gone';
    if (uid && response.status === HTTP_CONFLICT) return 'superseded';
    return is2xx(response.status) ? 'removed' : 'failed';
}

/** Deletes one Secret by name — that incarnation only, given its uid — and reads the answer; a transport rejection is `failed`. */
export async function deleteSecretAcked(deps: K8sDeps, name: string, uid?: string): Promise<SecretDelete> {
    try {
        const body = preconditioned(uid);
        const path = `${secretsPath(deps.config.k8sNamespace)}/${name}`;
        return deleteAnswer(await (body ? deps.request('DELETE', path, body) : deps.request('DELETE', path)), uid);
    } catch {
        return 'failed';
    }
}

/**
 * The pods that can still write the attempt's tree: every pod of the (job, lease) pair — its runner
 * pod, whose gate and service sidecars go with it (issue #773), and any aux pod of the pair.
 */
export const writerPodsPath = (namespace: string, pair: BoardJob): string =>
    `${podsPath(namespace)}?labelSelector=${encodeURIComponent(`${JOB_LABEL}=${pair.id},${LEASE_LABEL}=${pair.leaseToken}`)}`;

/**
 * One runner Job and the (job, lease) pair its Secrets and pods are named and labelled by. `keep`
 * is a Job that ended by itself: its end is confirmed without deleting it, so the finished run
 * stays for a replacement claim to adopt.
 */
export interface GroupRef {
    pair: BoardJob;
    jobName: string;
    keep?: boolean;
    /**
     * The incarnation this caller created, recorded the moment each create answers: its teardown
     * deletes that one only (uid preconditions), so a late teardown never reaches a replacement.
     */
    uids?: IncarnationUids;
}

/** The one input of every teardown and of its retries: what the creator knows, kept as-is. */
export type TeardownIdentity = GroupRef;

/** The uids a Job's and its Secret's create answered. */
export interface IncarnationUids {
    job: string;
    secret?: string;
}

/**
 * Whether a group's end is confirmed (`ended`), not (`held`: the checkout claim is kept), or the
 * name now holds another incarnation (`superseded`: nothing of it touched, and no claim given back
 * on its behalf).
 */
export type GroupEnd = 'ended' | 'held' | 'superseded';

/** A pod that ran to its end — `Succeeded` or `Failed` — writes nothing any more. */
const FINISHED_PHASES: readonly string[] = ['Succeeded', 'Failed'];

/** Whether the Job reads gone or, for a kept one, terminal: no runner of it is left to write. */
function jobOver(read: Read<ReadJobObject>, keep: boolean): boolean {
    if (read.kind === 'absent') return true;
    return keep && read.kind === 'value' && jobOutcome(read.value.status) !== 'pending';
}

/**
 * Whether no live pod is listed at `path` (null: the list proves nothing — a transport failure, a
 * refusal, a body that is no list of named pods). A list answering 404 is empty, as the fence reads one.
 */
async function noLivePod(deps: K8sDeps, path: string, what: string): Promise<boolean | null> {
    const pods = await readTypedList<K8sPod>(deps, path, what, { entry: asPod, once: true });
    if (pods.kind === 'inconclusive') return null;
    return pods.kind === 'absent' || pods.value.every((pod) => FINISHED_PHASES.includes(pod.status?.phase ?? ''));
}

/** Whether no live writer pod is listed (null: the list proves nothing). */
const noLiveWriter = (deps: K8sDeps, pair: BoardJob): Promise<boolean | null> =>
    noLivePod(deps, writerPodsPath(deps.config.k8sNamespace, pair), 'listing the writer pods');

/** Whether a read Job is another incarnation than the one this caller created. */
const anotherIncarnation = (read: Read<ReadJobObject>, uids: IncarnationUids | undefined): boolean => {
    if (uids === undefined || read.kind !== 'value') return false;
    const uid = read.value.metadata?.uid;
    return uid !== undefined && uid !== uids.job;
};

/**
 * The pods of every group serving checkout `holder` (`HOLDER_LABEL`, stamped on its pod
 * template): what a recovery that reaps that holder's claim must find none of live.
 */
export const holderPodsPath = (namespace: string, job: BoardJob, holder: string): string =>
    `${podsPath(namespace)}?labelSelector=${encodeURIComponent(`${JOB_LABEL}=${job.id},${HOLDER_LABEL}=${holder}`)}`;

/** Whether no live pod of a group serving `holder` is listed; null when the list proves nothing. */
export const holderWritersRead = (deps: K8sDeps, job: BoardJob, holder: string): Promise<boolean | null> =>
    noLivePod(deps, holderPodsPath(deps.config.k8sNamespace, job, holder), 'listing the holder pods');

/** Whether no live pod of a group serving `holder` is listed; an unreadable list is told to `unproven`. */
export async function holderQuiet(
    deps: K8sDeps,
    job: BoardJob,
    holder: string,
    unproven: (reason: string) => void
): Promise<boolean> {
    const gone = await holderWritersRead(deps, job, holder);
    if (gone === null) unproven('listing the holder pods proved nothing');
    return gone === true;
}

/** Whether no live pod of a group serving `holder` is listed; an unreadable list proves nothing (false). */
export async function holderWritersGone(deps: K8sDeps, job: BoardJob, holder: string): Promise<boolean> {
    return (await holderWritersRead(deps, job, holder)) === true;
}

/** One group Job read, once: the Job, its confirmed absence, or an answer that proves nothing. */
const readGroupJob = (deps: K8sDeps, jobName: string): Promise<Read<ReadJobObject>> =>
    readTyped(deps, jobPath(deps.config.k8sNamespace, jobName), 'reading the group Job', { shape: asJob, once: true });

/** Polls, bounded by `GROUP_END_WAIT_MS`, until the Job is over and no live writer pod is listed. */
export async function confirmEnded(deps: K8sDeps, { pair, jobName, keep = false, uids }: GroupRef): Promise<GroupEnd> {
    const ended = await pollFor<GroupEnd>(
        { ...waitOf(deps, GROUP_END_WAIT_MS), everyMs: POLL_MS },
        async (deadline) => {
            const round = boundedBy(deps, deadline);
            const read = await readGroupJob(round, jobName);
            if (read.kind === 'inconclusive') return 'held';
            // A replacement under the same name: its pods share the labels, and none of it is ours.
            if (anotherIncarnation(read, uids)) return 'superseded';
            if (!jobOver(read, keep)) return;
            const none = await noLiveWriter(round, pair);
            if (none === null) return 'held';
            if (none) return 'ended';
        }
    );
    return ended ?? 'held';
}

/** An identity's Secret: its own, by the uid its create answered when known. */
async function deleteSecretsOf(deps: K8sDeps, group: GroupRef): Promise<SecretDelete[]> {
    return [await deleteSecretAcked(deps, secretName(group.pair), group.uids?.secret)];
}

/** The Secrets first, acknowledged; then the Job, Foreground — a kept one is not deleted; then the confirmation. */
async function endJob(deps: K8sDeps, group: GroupRef): Promise<GroupEnd> {
    const path = jobPath(deps.config.k8sNamespace, group.jobName);
    const answers = await deleteSecretsOf(deps, group);
    if (answers.includes('superseded')) return 'superseded';
    if (answers.includes('failed')) {
        // The pod ends, the Job stays listed: the anchor the next pass derives the Secrets from. A
        // kept Job already ended, and stays listed as it is. A known incarnation is named by uid.
        const suspend = { ...(group.uids ? { metadata: { uid: group.uids.job } } : {}), spec: { suspend: true } };
        if (!group.keep) await deps.request('PATCH', path, suspend).catch(() => undefined);
        return 'held';
    }
    if (group.keep) return confirmEnded(deps, group);
    const deleted = await deleteJobOf(deps, group, path);
    if (deleted === 'superseded') return 'superseded';
    if (deleted === 'failed') return 'held';
    return confirmEnded(deps, group);
}

/** The Job's Foreground delete — that incarnation only, given its uid; a transport rejection is `failed`. */
async function deleteJobOf(deps: K8sDeps, group: GroupRef, path: string): Promise<SecretDelete> {
    try {
        const body = preconditioned(group.uids?.job);
        const target = `${path}?propagationPolicy=Foreground`;
        return deleteAnswer(
            await (body ? deps.request('DELETE', target, body) : deps.request('DELETE', target)),
            group.uids?.job
        );
    } catch {
        return 'failed';
    }
}

/**
 * Marks a group's end pending against `holder`, synchronously — before the caller forgets the
 * group or awaits anything — so no concurrent hand-back releases the claim mid-teardown. Only a
 * confirmed `ended` (or a `superseded`) clears it.
 */
export function markEnding(deps: K8sDeps, identity: TeardownIdentity, holder: string = identity.pair.leaseToken): void {
    const held = heldOf(deps);
    const groups = held.get(holder) ?? new Map<string, TeardownIdentity>();
    // An identity already recorded keeps what it knows: a later mark never drops a uid.
    groups.set(identity.jobName, { ...groups.get(identity.jobName), ...identity });
    held.set(holder, groups);
}

/** The groups not yet confirmed ended, by the checkout holder they keep the claim for: whole identities. */
const heldOf = (deps: K8sDeps): Map<string, Map<string, TeardownIdentity>> => {
    deps.unconfirmed ??= new Map();
    return deps.unconfirmed;
};

/**
 * Ends one runner Job, acknowledged, and records the answer against `holder` — the checkout
 * claim's holder token. A later `ended` of the same Job clears an earlier `held`. Never throws.
 */
export async function endRunnerJob(
    deps: K8sDeps,
    identity: TeardownIdentity,
    holder: string = identity.pair.leaseToken
): Promise<GroupEnd> {
    markEnding(deps, identity, holder);
    const recorded = heldOf(deps).get(holder)?.get(identity.jobName) ?? identity;
    const end = await endJob(deps, recorded);
    const held = heldOf(deps);
    const groups = held.get(holder) ?? new Map<string, TeardownIdentity>();
    if (end === 'held') groups.set(identity.jobName, recorded);
    else groups.delete(identity.jobName);
    if (groups.size > 0) held.set(holder, groups);
    else held.delete(holder);
    // Another incarnation now answers to the holder: its claim is that one's to give back.
    if (end === 'superseded') {
        deps.superseded ??= new Set();
        deps.superseded.add(holder);
    }
    return end;
}

/** Whether any group this runner ended under `holder` is still unconfirmed, or another incarnation replaced it. */
export function holderUnconfirmed(deps: K8sDeps, holder: string): boolean {
    return (deps.unconfirmed?.get(holder)?.size ?? 0) > 0 || deps.superseded?.has(holder) === true;
}

/**
 * Ends every unconfirmed group of `holder` again, each Job read first (#869): one gone or ended is
 * ended with `keep` — its run is adoptable, and was never reason to delete; one read still pending
 * did not end the first time and is ended destructively; one that cannot be read stays unconfirmed
 * and held, for the next call. True once none is left unconfirmed.
 */
export async function retryUnconfirmed(deps: K8sDeps, holder: string): Promise<boolean> {
    // The recorded identity as-is — its uid fences included.
    for (const identity of [...(deps.unconfirmed?.get(holder)?.values() ?? [])]) {
        const read = await readGroupJob(deps, identity.jobName);
        if (read.kind === 'inconclusive') continue;
        await endRunnerJob(deps, { ...identity, keep: jobOver(read, true) }, holder);
    }
    return !holderUnconfirmed(deps, holder);
}

/**
 * Deletes the checkout claim under the uid precondition: true when removed. Gone (404) or replaced (409) is a
 * settled claim; any other refusal, or a throw, is told to `unproven` (a leaked claim costs one takeover).
 */
export async function deleteClaim(
    deps: K8sDeps,
    job: BoardJob,
    uid: string,
    unproven: (reason: string) => void
): Promise<boolean> {
    try {
        const { status } = await deps.request('DELETE', claimPath(deps.config.k8sNamespace, job), {
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            preconditions: { uid },
        });
        if (!is2xx(status) && status !== HTTP_NOT_FOUND && status !== HTTP_CONFLICT) {
            unproven(`deleting the claim answered ${status}`);
        }
        return is2xx(status);
    } catch {
        unproven('deleting the claim failed');
        return false;
    }
}
