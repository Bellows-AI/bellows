import type { BoardJob } from './board.js';
import { jobPath, podsPath, secretsPath } from './k8s-auxspec.js';
import { gateEnvSecretName, secretName } from './k8s-podspec.js';
import { HTTP_CONFLICT, HTTP_ERROR_STATUS, HTTP_NOT_FOUND, HTTP_OK_STATUS, parse, POLL_MS } from './k8s-transport.js';
import type { K8sDeps, K8sResponse } from './k8s-transport.js';
import { HOLDER_LABEL, JOB_LABEL, LEASE_LABEL, SERVICE_LABEL } from './labels.js';

/**
 * The acknowledged end of one runner Job — an attempt's task group or a reclaim group (issue
 * #821). Nothing can find an attempt's Secrets once its Job is gone (the driver has no `list` on
 * secrets, and every later pass derives their names from a listed Job), so the Secrets go first,
 * each delete's answer read; a refused one leaves the Job suspended rather than deleted, its pod
 * ended and the Job still listed for the fence and the reaper to derive the Secrets from. Only a
 * Job read gone with no writer pod left is ended; anything short of that is held, recorded
 * against the checkout holder, and the claim is kept (`releaseClaimAfterGroupEnd`).
 */

/** How long ending a group may wait for its Job and its writer pods to be gone. */
export const GROUP_END_WAIT_MS = 20_000;

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
    return response.status >= HTTP_OK_STATUS && response.status < HTTP_ERROR_STATUS ? 'removed' : 'failed';
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
 * The pods that can still write the attempt's tree: its runner, gate and readout pods — every pod
 * of the (job, lease) pair but the declared services (`!factory.service`), which mount no worktree
 * and are torn down by the loop's `releaseServices` on their own schedule.
 */
export const writerPodsPath = (namespace: string, pair: BoardJob): string =>
    `${podsPath(namespace)}?labelSelector=${encodeURIComponent(
        `${JOB_LABEL}=${pair.id},${LEASE_LABEL}=${pair.leaseToken},!${SERVICE_LABEL}`
    )}`;

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

/** One GET, or null for an answer that proves nothing — a transport rejection or a non-2xx, non-404 status. */
async function readConclusive(deps: K8sDeps, path: string): Promise<K8sResponse | null> {
    try {
        const read = await deps.request('GET', path);
        if (read.status === HTTP_NOT_FOUND) return read;
        return read.status >= HTTP_OK_STATUS && read.status < HTTP_ERROR_STATUS ? read : null;
    } catch {
        return null;
    }
}

/** A pod that ran to its end — `Succeeded` or `Failed` — writes nothing any more. */
const FINISHED_PHASES: readonly string[] = ['Succeeded', 'Failed'];

/** Whether the Job reads gone or, for a kept one, terminal: no runner of it is left to write. */
function jobOver(read: K8sResponse, keep: boolean): boolean {
    if (read.status === HTTP_NOT_FOUND) return true;
    if (!keep) return false;
    const status = parse<{ status?: { succeeded?: number; failed?: number } }>(read.body).status;
    return (status?.succeeded ?? 0) >= 1 || (status?.failed ?? 0) >= 1;
}

/** Whether no live writer pod is listed (null: the list proves nothing). A list answering 404 is empty, as the fence reads one. */
async function noLiveWriter(deps: K8sDeps, pair: BoardJob): Promise<boolean | null> {
    const pods = await readConclusive(deps, writerPodsPath(deps.config.k8sNamespace, pair));
    if (pods === null) return null;
    if (pods.status === HTTP_NOT_FOUND) return true;
    const items = parse<{ items?: { status?: { phase?: string } }[] }>(pods.body).items ?? [];
    return items.every((pod) => FINISHED_PHASES.includes(pod.status?.phase ?? ''));
}

/** Whether a read Job is another incarnation than the one this caller created. */
const anotherIncarnation = (read: K8sResponse, uids: IncarnationUids | undefined): boolean => {
    if (uids === undefined || read.status === HTTP_NOT_FOUND) return false;
    const uid = parse<{ metadata?: { uid?: string } }>(read.body).metadata?.uid;
    return uid !== undefined && uid !== uids.job;
};

/**
 * The pods of every reclaim group serving checkout `holder` (`HOLDER_LABEL`, stamped on its pod
 * template): what a recovery that reaps that holder's claim must find none of live.
 */
export const holderPodsPath = (namespace: string, job: BoardJob, holder: string): string =>
    `${podsPath(namespace)}?labelSelector=${encodeURIComponent(`${JOB_LABEL}=${job.id},${HOLDER_LABEL}=${holder}`)}`;

/** Whether no live pod of a reclaim group serving `holder` is listed; an unreadable list proves nothing (false). */
export async function holderWritersGone(deps: K8sDeps, job: BoardJob, holder: string): Promise<boolean> {
    const pods = await readConclusive(deps, holderPodsPath(deps.config.k8sNamespace, job, holder));
    if (pods === null) return false;
    if (pods.status === HTTP_NOT_FOUND) return true;
    const items = parse<{ items?: { status?: { phase?: string } }[] }>(pods.body).items ?? [];
    return items.every((pod) => FINISHED_PHASES.includes(pod.status?.phase ?? ''));
}

/** Polls, bounded by `GROUP_END_WAIT_MS`, until the Job is over and no live writer pod is listed. */
async function confirmEnded(deps: K8sDeps, { pair, jobName, keep = false, uids }: GroupRef): Promise<GroupEnd> {
    const polls = Math.ceil(GROUP_END_WAIT_MS / POLL_MS);
    for (let poll = 0; poll < polls; poll += 1) {
        if (poll > 0) await deps.sleep(POLL_MS);
        const read = await readConclusive(deps, jobPath(deps.config.k8sNamespace, jobName));
        if (read === null) return 'held';
        // A replacement under the same name: its pods share the labels, and none of it is ours.
        if (anotherIncarnation(read, uids)) return 'superseded';
        if (!jobOver(read, keep)) continue;
        const none = await noLiveWriter(deps, pair);
        if (none === null) return 'held';
        if (none) return 'ended';
    }
    return 'held';
}

/** An identity's two Secrets: its own by the uid its create answered, when known, and its gate environment's. */
async function deleteSecretsOf(deps: K8sDeps, group: GroupRef): Promise<SecretDelete[]> {
    return [
        await deleteSecretAcked(deps, secretName(group.pair), group.uids?.secret),
        await deleteSecretAcked(deps, gateEnvSecretName(group.pair)),
    ];
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
 * claim's holder token, which for a reclaim group is the reclaim's, never the group's own random
 * token. A later `ended` of the same Job clears an earlier `held`. Never throws.
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
 * Ends every unconfirmed group of `holder` again — destructively, a kept one too: it did not end
 * the first time. True once none is left unconfirmed.
 */
export async function retryUnconfirmed(deps: K8sDeps, holder: string): Promise<boolean> {
    // The recorded identity as-is — its uid fences included — only no longer kept.
    for (const identity of [...(deps.unconfirmed?.get(holder)?.values() ?? [])]) {
        await endRunnerJob(deps, { ...identity, keep: false }, holder);
    }
    return !holderUnconfirmed(deps, holder);
}
