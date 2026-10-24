import type { BoardJob } from '../board/board.js';
import { runnerClaimEnv } from '../claim.js';
import type { DriverConfig } from '../config.js';
import { telemetryConfig, type TelemetryConfig } from '../telemetry-config.js';
import { isSeq, LEASE_LABEL } from '../labels.js';
import { ensureTaskVolume } from './k8s-task-volume.js';
import {
    claimBody,
    claimPath,
    configmapsPath,
    jobPath,
    jobsSelectorPath,
    podsPath,
    podsSelectorPath,
    secretsPath,
} from './k8s-auxspec.js';
import {
    finishedAgentRun,
    type JobOwner,
    jobsPath,
    type ListedRunnerJob,
    runnerName,
    secretBody,
    secretName,
    type RunnerJobSpec,
} from './k8s-podspec.js';
import { asIdentified } from './k8s-pod-shapes.js';
import { jobOutcome, readTyped, readTypedList } from './k8s-poll.js';
import { isLease, nonEmpty, optionalTimestamp, stringsOnly, validRunnerSpec } from './k8s-shapes.js';
import type { Read } from '../runner.js';
import {
    deleteSecretAcked,
    endRunnerJob,
    type GroupRef,
    holderUnconfirmed,
    deleteClaim,
    holderQuiet,
    type IncarnationUids,
    retryUnconfirmed,
    type TeardownIdentity,
} from './k8s-teardown.js';
import {
    CLAIM_ROUNDS,
    expectOk,
    HTTP_CONFLICT,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    isRecord,
    JOB_ID,
    readAnswer,
    POLL_MS,
    refusal,
    REPLACE_WAIT_MS,
    boundedBy,
    waitOf,
    withSignal,
} from './k8s-transport.js';
import { pollFor } from '../poll.js';
import type { K8sClaim, K8sDeps, K8sResponse } from './k8s-transport.js';

/**
 * The re-claim fence: taking the checkout claim, sweeping a superseded attempt's leftovers, and
 * the pre/post-create claim verifies that bracket the runner Job POST. See docs/kubernetes.md's
 * "Re-claim fence by claiming the checkout, atomically" for the full protocol; this file is its
 * implementation, shared by the runner's `prepare`/`launch` and by `syncCheckout`/`reclaimWorktree`
 * (`k8s-runner.ts`), which run the same `acquireClaim`/`releaseClaimAfterGroupEnd` pair under their own Jobs.
 */

/**
 * The Secret's contents: the claim env, the loop's minted gate credentials, the task supervisor's
 * control pair and the exporter's token (each referenced by its own container only — the agent's
 * env is built from the first two and the attempt pair, never from these names) and the runner's own
 * attempt pair — the branch-ingest credential, always present, because it is how the reporter
 * authenticates at all.
 */
const runnerEnv = (config: DriverConfig, job: BoardJob): Record<string, string> => ({
    ...runnerClaimEnv(job),
    ...(job.gateEnv ?? {}),
    ...(job.supervisorEnv ?? {}),
    RUNNER_JOB_ID: job.id,
    RUNNER_LEASE_TOKEN: job.leaseToken,
    // Issue #452: the runner's telemetry config, rendered here and mounted read-only by the pod
    // spec (k8s-podspec.ts, telemetryConfigK8s) — never written inside the pod.
    ...telemetrySecretEntry(telemetryConfig(job.executorType, config.otelEndpoint)),
});

const telemetrySecretEntry = ({ file, body }: TelemetryConfig): Record<string, string> => ({ [file]: body });

/**
 * Whether the board proves this attempt holds the job's live lease — the only proof a claim with
 * no claim sequence (a hand-made one, or one an older driver wrote) is a stale holder's: the board
 * hands a job to a new claimant only once the previous lease is gone. Anything short of that proof
 * — no lookup wired, no answer, another token — is not one.
 */
async function holdsLiveLease(deps: K8sDeps, job: BoardJob): Promise<boolean> {
    const rows = await deps.leases?.([job.id]).catch(() => null);
    const row = rows?.find((lease) => lease.id === job.id);
    return row?.status === 'running' && row.leaseToken === job.leaseToken;
}

/**
 * The claim sequence a claim carries, NaN for a legacy claim that carries none. Ordered by the
 * claim sequence, never by `attempts`: a stop or an interruption refunds an attempt, and a
 * replacement must still read as newer than every claim before it. A field that is present is
 * digits within the safe integers (`asClaim`): `Number('')` is 0 and a long run of digits is
 * Infinity, and neither may read as an ordered claim (#869).
 */
const claimSeqOf = (raw: string | undefined): number => (raw === undefined ? Number.NaN : Number(raw));

/**
 * Reads the claim a 409 answered, and either recognizes it as already ours or takes it over —
 * pulled out of `acquireClaim` purely to keep that function's complexity readable. `'ours'` stops
 * the round; `'retry'` (a vanished claim, or a stale one just released) sends the caller back to
 * `acquireClaim` for another POST.
 */
async function takeOverStaleClaim(deps: K8sDeps, job: BoardJob, path: string): Promise<'ours' | 'retry'> {
    const read = await readClaimObject(deps, job, true);
    // Gone between our 409 and the read — the holder released it; race for it again.
    if (read.kind === 'absent') return 'retry';
    // An answer that is no claim proves nothing about the holder: it is never released on it.
    if (read.kind === 'inconclusive') throw new Error(read.reason);
    const claim = read.value;
    const holder = job.claimHolder ?? job.leaseToken;
    if (claim.data?.holder === holder) {
        // Our own claim, kept because a group of ours could not be confirmed ended (issue #821): a
        // retry under the same holder — a reclaim offered again — may not start beside it.
        if (!(await retryUnconfirmed(deps, holder))) {
            throw new Error(
                `job ${job.id} stands down: a group of this holder could not be confirmed ended, ` +
                    'so the checkout claim it keeps is not taken again'
            );
        }
        return 'ours';
    }
    // A claim that names no holder is no claim to order against or release (#869).
    if (!claim.data?.holder) throw new Error(`${CLAIM_READ} answered a claim with no holder`);
    const claimSeq = claimSeqOf(claim.data.claimSeq);
    if (Number.isFinite(claimSeq) && claimSeq >= job.claimSeq) {
        throw new Error(
            `job ${job.id} stands down: the checkout claim is held by a newer claim ` +
                `(${claim.data?.claimSeq} >= ${job.claimSeq})`
        );
    }
    if (!Number.isFinite(claimSeq) && !(await holdsLiveLease(deps, job))) {
        throw new Error(
            `job ${job.id} stands down: the checkout claim carries no claim sequence, and the board ` +
                'could not prove this attempt holds the live lease'
        );
    }
    const uid = claim.metadata?.uid;
    if (!uid) {
        // A read that cannot name the incarnation it read is a bad read, and garbage is never
        // proof of an older holder: an UNCONDITIONED delete here could reach a newer claim and
        // reopen both races through this one branch. Fail loud; the job goes back to its lease.
        throw new Error(`the checkout claim of job ${job.id} could not be identified: no uid on the object`);
    }
    const release = await deps.request('DELETE', path, {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        preconditions: { uid },
    });
    // 404: the holder released it first. 409: the claim we read was replaced in the meantime —
    // the next round's GET reads the new holder and orders us against it.
    const refusedRelease = refusal(release, 'releasing the checkout claim', HTTP_NOT_FOUND, HTTP_CONFLICT);
    if (refusedRelease) throw new Error(refusedRelease);
    return 'retry';
}

/**
 * Take the checkout claim, atomically. The POST is the whole mutex: the apiserver grants the name
 * to exactly one creator, so there is no window in which two attempts both hold the checkout — the
 * GET-then-POST race the label fence had is closed by construction. A `409` reads the holder: an
 * attempt number at or ahead of ours is our own replacement, and we stand down; behind ours is a
 * leftover from a driver that died holding the claim, released conditionally on the exact
 * incarnation we read.
 */
export async function acquireClaim(deps: K8sDeps, job: BoardJob, round = 1): Promise<void> {
    const path = claimPath(deps.config.k8sNamespace, job);
    if (round > CLAIM_ROUNDS) {
        throw new Error(`the checkout claim of job ${job.id} was never acquired after ${CLAIM_ROUNDS} rounds`);
    }
    const post = await deps.request('POST', configmapsPath(deps.config.k8sNamespace), claimBody(job));
    if (post.status < HTTP_ERROR_STATUS) return;
    const refused = refusal(post, 'claiming the checkout', HTTP_CONFLICT);
    if (refused) throw new Error(refused);
    if ((await takeOverStaleClaim(deps, job, path)) === 'ours') return;
    return acquireClaim(deps, job, round + 1);
}

/** The claim incarnation an earlier read observed: what a recovery that read it may act on. */
export interface ObservedClaim {
    uid: string;
    holder: string;
}

const CLAIM_READ = 'reading the checkout claim';

/**
 * A claim as far as its shape is read (#869): `metadata` and `data` records when they are there at
 * all; the uid a non-empty string, the creation time RFC 3339, the annotations strings; the holder a
 * lease (a holder that is no lease is no ownership change to act on) and the claim sequence digits
 * within the safe integers. An absent holder or sequence stays absent: the callers read it as such.
 */
const asClaim = (value: unknown): K8sClaim | null => {
    if (!isRecord(value)) return null;
    const { metadata, data } = value;
    const metadataOk =
        metadata === undefined ||
        (isRecord(metadata) &&
            (metadata.uid === undefined || nonEmpty(metadata.uid)) &&
            optionalTimestamp(metadata.creationTimestamp) &&
            (metadata.annotations === undefined || stringsOnly(metadata.annotations)));
    const dataOk =
        data === undefined ||
        (isRecord(data) &&
            (data.holder === undefined || isLease(data.holder)) &&
            (data.claimSeq === undefined || isSeq(data.claimSeq)));
    return metadataOk && dataOk ? (value as K8sClaim) : null;
};

/**
 * The job's checkout claim as a typed read (#869): the claim, its confirmed absence, or an answer
 * that proves nothing — a transport failure, a refusal, a body that is no claim. `once` is one GET;
 * otherwise the verdict reads' patience.
 */
export const readClaimObject = (deps: K8sDeps, job: BoardJob, once = false): Promise<Read<K8sClaim>> =>
    readTyped(deps, claimPath(deps.config.k8sNamespace, job), CLAIM_READ, { shape: asClaim, once });

/** What a claim read proves of the checkout: ours, taken (gone, or held by another), or unconfirmed with the reason. */
type ClaimVerdict = 'ours' | 'taken' | { unconfirmed: string };

function claimVerdict(read: Read<K8sClaim>, job: BoardJob): ClaimVerdict {
    if (read.kind === 'absent') return 'taken';
    if (read.kind === 'inconclusive') return { unconfirmed: read.reason };
    const holder = read.value.data?.holder;
    if (!holder) return { unconfirmed: `${CLAIM_READ} answered a claim with no holder` };
    return holder === (job.claimHolder ?? job.leaseToken) ? 'ours' : 'taken';
}

/** One claim read, as the incarnation it names; null when gone, unreadable or unidentifiable. */
export async function readClaim(deps: K8sDeps, job: BoardJob): Promise<ObservedClaim | null> {
    return observedOf(await readClaimObject(deps, job, true));
}

/** A claim read as the incarnation it names; null when gone, unreadable or unidentifiable. */
export function observedOf(read: Read<K8sClaim>): ObservedClaim | null {
    if (read.kind !== 'value') return null;
    const uid = read.value.metadata?.uid;
    const holder = read.value.data?.holder;
    return uid && holder ? { uid, holder } : null;
}

/**
 * THE one hand-back and the one deletion of a checkout claim (issue #821): the claim goes only
 * once every group of its holder is confirmed ended. `groups` are ended here first, through
 * `endRunnerJob`, recorded against the holder; a group of the holder still live in this runner
 * (`deps.groups`), or one ended before and still unconfirmed, keeps the claim too. `observed` is
 * the incarnation a recovery read earlier — an orphaned claim, a reaped job's — and a claim
 * replaced since is rejected before any group is ended. The delete carries the uid precondition,
 * so it can only ever reach the incarnation read; a claim gone, held by another attempt or
 * unreadable is left alone. Answers whether the claim was deleted. Never throws.
 */
export async function releaseClaimAfterGroupEnd(
    deps: K8sDeps,
    job: BoardJob,
    ends: {
        groups?: readonly GroupRef[];
        observed?: ObservedClaim;
        holderWriters?: boolean;
        /** Told why an answer it depended on proved nothing (a refused read, a group not confirmed ended). */
        onUnproven?: (reason: string) => void;
    } = {}
): Promise<boolean> {
    const unproven = ends.onUnproven ?? (() => undefined);
    const claimNow = () => readObserved(deps, job, unproven);
    // A taken-over group is addressed by its own lease (`ownGroup`); the claim is its holder's (#829).
    const holder = ends.observed?.holder ?? job.claimHolder ?? job.leaseToken;
    if (ends.observed) {
        const now = await claimNow();
        if (now?.uid !== ends.observed.uid || now.holder !== holder) return false;
    }
    // A recovery's claim goes only with no group of its holder still
    // writing — another invocation's, or a pod outliving its Job's delete.
    if ((ends.observed || ends.holderWriters) && !(await holderQuiet(deps, job, holder, unproven))) return false;
    const groups = { holder, groups: ends.groups ?? [], groupLease: groupLeaseOf(job), unproven };
    if (!(await groupsEnded(deps, groups))) return false;
    const claim = await claimNow();
    if (claim?.holder !== holder || (ends.observed && claim.uid !== ends.observed.uid)) return false;
    return deleteClaim(deps, job, claim.uid, unproven);
}

/** One claim read as its incarnation, telling `unproven` when the read proved nothing (a gone claim is proven). */
export async function readObserved(
    deps: K8sDeps,
    job: BoardJob,
    unproven: (reason: string) => void
): Promise<ObservedClaim | null> {
    const read = await readClaimObject(deps, job, true);
    if (read.kind === 'inconclusive') unproven(read.reason);
    const observed = observedOf(read);
    if (read.kind === 'value' && observed === null) unproven('the claim answered without its uid or holder');
    return observed;
}

/** The lease a taken-over attempt's group lives under (#829): `job` as the loop has it, or as `ownGroup` addresses it. */
const groupLeaseOf = (job: BoardJob): string | undefined =>
    job.groupLease ?? (job.claimHolder ? job.leaseToken : undefined);

/**
 * Ends `groups` under `holder`; true only when every group of the holder is confirmed ended and none is live here —
 * a taken-over group is recorded under its own lease (`groupLease`), the claim under its holder's.
 */
async function groupsEnded(
    deps: K8sDeps,
    {
        holder,
        groups,
        groupLease,
        unproven,
    }: {
        holder: string;
        groups: readonly GroupRef[];
        groupLease: string | undefined;
        unproven: (reason: string) => void;
    }
): Promise<boolean> {
    let held = false;
    for (const group of groups) {
        const end = await endRunnerJob(deps, group, holder);
        if (end !== 'ended') held = true;
        if (end === 'held') unproven(`group ${group.jobName} was not confirmed ended`);
    }
    const live =
        deps.groups?.has(holder) === true || (groupLease !== undefined && deps.groups?.has(groupLease) === true);
    return !held && !live && !holderUnconfirmed(deps, holder);
}

/** One kind's leftover objects — a job or a pod — the sweep found by label, with the leases they carry. */
interface SweepFleet {
    kind: string;
    basePath: string;
    /** The uid each listed object answered, by name: its delete names that incarnation only. */
    uids: Map<string, string>;
    leases: string[];
}

/** The finished agent runs the sweep spares, by Job name and by lease (Jobs are listed first). */
interface KeptRuns {
    jobs: Set<string>;
    leases: Set<string>;
}

/** One listed kind's sweep: the attempt sweeping, the kind listed, and the runs it spares so far. */
interface SweepScope {
    job: BoardJob;
    kind: string;
    kept: KeptRuns;
}

type SweptItem = ListedRunnerJob & {
    metadata: { name: string; uid: string; labels?: Record<string, string> };
};

/**
 * Whether the sweep leaves a listed object alone: the finished agent run THIS attempt adopted and
 * is continuing to its verdict (`deps.adopted`), or a pod of it — the evidence a later claim adopts
 * again if this one is lost first (issue #821). It writes nothing: its pod ran to its end. Every
 * other finished run goes, before a fresh sync can change the tree its outcome was read against.
 */
function spared(deps: K8sDeps, { job, kind, kept }: SweepScope, item: SweptItem): boolean {
    const adopted = deps.adopted?.get(job.leaseToken);
    const lease = item.metadata.labels?.[LEASE_LABEL];
    const live = adoptedLive(deps, job);
    // The adopted Job's lease, spec and ended status are readable (`sweepEntry`): this reads the evidence, never its absence.
    if (
        adopted !== undefined &&
        item.metadata.name === adopted &&
        lease !== undefined &&
        (live || finishedAgentRun(item, { ...job, leaseToken: lease }))
    ) {
        kept.jobs.add(adopted);
        kept.leases.add(lease);
        return true;
    }
    // A pod of the kept run is known by its lease as well as its `job-name`: a pod listed without
    // that label is still the run's, never a delete target for want of it.
    if (kind === 'pod' && lease !== undefined && kept.leases.has(lease)) return true;
    return kept.jobs.has(item.metadata.labels?.['job-name'] ?? '');
}

/** The named objects a label-selector list carries, and their lease labels, except those the sweep spares. */
function namedItemsOf(deps: K8sDeps, scope: SweepScope, items: SweptItem[]): Omit<SweepFleet, 'kind' | 'basePath'> {
    const found: Omit<SweepFleet, 'kind' | 'basePath'> = { uids: new Map(), leases: [] };
    for (const item of items) {
        if (spared(deps, scope, item)) continue;
        // Every listed entry carries its uid (`asIdentified`): the delete below always names it.
        found.uids.set(item.metadata.name, item.metadata.uid);
        const lease = item.metadata.labels?.[LEASE_LABEL];
        if (lease !== undefined) found.leases.push(lease);
    }
    return found;
}

/**
 * Whether the run this attempt adopted is a LIVE group it took over (#829): still running, so the
 * sweep spares it on its name and lease, not on a status that shows it ended.
 */
function adoptedLive(deps: K8sDeps, job: BoardJob): boolean {
    const adopted = deps.adopted?.get(job.leaseToken);
    if (adopted === undefined) return false;
    return [...(deps.groups ?? [])].some(
        ([lease, group]) => group.resumed === true && runnerName({ ...job, leaseToken: lease }) === adopted
    );
}

/** A Job status that shows the run ended: the adopted run is a finished one, and only that status proves it. */
const endedStatus = (status: unknown): boolean => isRecord(status) && jobOutcome(status) !== 'pending';

/**
 * One leftover as the sweep reads it (#869): an identified object whose lease label, when it has
 * one, is a lease (the `!=` selector matches an object with none) — a corrupt one would become an
 * attempt identity the sweep derives Secrets and sparing from. The Job this attempt adopted must
 * also name its lease and carry a readable spec: the sweep spares it only on that evidence, and
 * never deletes the run it read for want of it. While a run is adopted, a pod naming neither a
 * lease nor a `job-name` cannot say whether it is that run's, so its listing proves nothing.
 */
const sweepEntry =
    (adopted: string | undefined, kind: string, live: boolean) =>
    (value: unknown): SweptItem | null => {
        const item = asIdentified<SweptItem>(value);
        if (item === null) return null;
        const lease = item.metadata.labels?.[LEASE_LABEL];
        if (lease !== undefined && !isLease(lease)) return null;
        const unowned = lease === undefined && !nonEmpty(item.metadata.labels?.['job-name']);
        if (adopted !== undefined && kind === 'pod' && unowned) return null;
        const isAdopted = adopted !== undefined && item.metadata.name === adopted;
        return isAdopted && (lease === undefined || !validRunnerSpec(item.spec) || !(live || endedStatus(item.status)))
            ? null
            : item;
    };

/**
 * One label selector's leftover objects, or `null` for a kind that answered nothing of this job's
 * — `inconclusive` true the instant the kind could not be read at all, since a transport failure
 * or 429/5xx says nothing about whether its objects are gone.
 */
async function probeOneFleetKind(
    deps: K8sDeps,
    job: BoardJob,
    [kind, selectorPath, basePath]: readonly [string, string, string],
    kept: KeptRuns
): Promise<{ fleet: SweepFleet | null; inconclusive: boolean }> {
    const read = await readTypedList<SweptItem>(deps, selectorPath, `listing the leftover ${kind}s`, {
        entry: sweepEntry(deps.adopted?.get(job.leaseToken), kind, adoptedLive(deps, job)),
        once: true,
    });
    // A kind answering nothing at all has nothing of this job in it.
    if (read.kind === 'absent') return { fleet: null, inconclusive: false };
    // A transport failure, 429/5xx, or a 2xx that is no list of named objects says nothing about
    // whether the objects are gone: the round cannot free the checkout.
    if (read.kind === 'inconclusive') return { fleet: null, inconclusive: true };
    const found = namedItemsOf(deps, { job, kind, kept }, read.value);
    return { fleet: found.uids.size > 0 ? { kind, basePath, ...found } : null, inconclusive: false };
}

/**
 * One pass over the two label selectors a leftover attempt can answer on. `conclusive` is false
 * the instant any kind could not be read at all — a transport failure or 429/5xx says nothing
 * about whether the objects are gone, so the caller must not read an empty `fleets` as a free
 * checkout on an inconclusive pass.
 */
async function probeLeftoverFleets(
    deps: K8sDeps,
    job: BoardJob
): Promise<{ fleets: SweepFleet[]; conclusive: boolean }> {
    const fleets: SweepFleet[] = [];
    let conclusive = true;
    // Jobs first: the finished agent runs they spare are what spares their pods.
    const kept: KeptRuns = { jobs: new Set(), leases: new Set() };
    for (const kind of [
        ['job', jobsSelectorPath(deps.config.k8sNamespace, job), jobsPath(deps.config.k8sNamespace)],
        ['pod', podsSelectorPath(deps.config.k8sNamespace, job), podsPath(deps.config.k8sNamespace)],
    ] as const) {
        const { fleet, inconclusive } = await probeOneFleetKind(deps, job, kind, kept);
        if (fleet) fleets.push(fleet);
        if (inconclusive) conclusive = false;
    }
    return { fleets, conclusive };
}

/** Whether this attempt still (provably) holds the claim the sweep is clearing leftovers for. */
async function verifyClaimHeldForSweep(deps: K8sDeps, job: BoardJob): Promise<'ours' | 'lost' | 'unknown'> {
    // Gone or held by another is lost; an answer that proves nothing (429/5xx, a transport failure,
    // a body that is no claim, a claim with no holder) is unconfirmed — neither delete nor stand
    // down on a maybe.
    const verdict = claimVerdict(await readClaimObject(deps, job, true), job);
    if (verdict === 'ours') return 'ours';
    return verdict === 'taken' ? 'lost' : 'unknown';
}

/**
 * The Secrets of every leftover lease, by derived name, acknowledged — BEFORE any Job of theirs is
 * deleted (issue #821): a Secret has no owner, and once its Job is gone nothing can derive its name
 * again. False when any one delete failed; the round then deletes nothing.
 */
async function deleteLeftoverSecrets(deps: K8sDeps, job: BoardJob, fleets: SweepFleet[]): Promise<boolean> {
    const leases = new Set(fleets.flatMap((fleet) => fleet.leases).filter((lease) => JOB_ID.test(lease)));
    const adopted = deps.adopted?.get(job.leaseToken);
    for (const lease of leases) {
        const pair = { ...job, leaseToken: lease };
        // The adopted run's lease keeps its Job listed: its Secrets stay derivable from it, and
        // their cleanup is never what holds a recovered run back (issue #821).
        if (adopted !== undefined && runnerName(pair) === adopted) continue;
        if ((await deleteSecretAcked(deps, secretName(pair))) === 'failed') return false;
    }
    return true;
}

/** Deletes every named leftover of one sweep pass; the next pass's list is what says they are gone. */
async function deleteSweepFleets(deps: K8sDeps, fleets: SweepFleet[]): Promise<void> {
    for (const fleet of fleets) {
        for (const [leftover, uid] of fleet.uids) {
            // The incarnation listed, by its uid: never one created under the name since.
            const target = `${fleet.basePath}/${leftover}?propagationPolicy=Foreground`;
            const response = await deps.request('DELETE', target, {
                apiVersion: 'v1',
                kind: 'DeleteOptions',
                preconditions: { uid },
            });
            // A 404 is the ordinary end of an object another fence got to first; a 409 is a
            // concurrent delete of it, or — on its uid precondition — another incarnation now under
            // the name. Neither is proof it is gone: the next list says. Anything else fails loud.
            const refused = refusal(response, `deleting the leftover ${fleet.kind}s`, HTTP_NOT_FOUND, HTTP_CONFLICT);
            if (refused) throw new Error(refused);
        }
    }
}

/**
 * The sweep — the janitor that enforces the takeover. Every object the
 * `factory.job=<id>,factory.lease!=<token>` selector answers is a leftover of the attempts this
 * claim was taken FROM: deleted BY NAME, per object, with Foreground propagation, until the
 * selector answers nothing and no leftover runner remains to write the checkout once this
 * attempt's Job starts. It runs when the attempt's task group is made — at the sync, its first
 * step — before this attempt's pod and its gate and service sidecars exist. No timestamps, no
 * cutoffs, no clocks: an age filter
 * was unsound in both directions, so the sweep classifies nothing. The claim is re-read before
 * every deleting round: a stale attempt whose claim was taken over mid-sweep STANDS DOWN having
 * deleted nothing.
 */
export async function sweepClaimedFleets(deps: K8sDeps, job: BoardJob, signal: AbortSignal): Promise<void> {
    let unmet = `the fence of job ${job.id} could not confirm the checkout empty`;
    const live = withSignal(deps, signal);
    const done = await pollFor<true>({ ...waitOf(live, REPLACE_WAIT_MS), everyMs: POLL_MS }, async (deadline) => {
        // Every request of the round, the deletes included, ends by the bound and refuses once
        // the attempt is killed.
        const round = boundedBy(live, deadline);
        const { fleets, conclusive } = await probeLeftoverFleets(round, job);
        // Inconclusive: keep polling within the same bound, deleting nothing — a kind that proved
        // nothing may be the Job listing that spares the adopted run's pods (#869).
        if (!conclusive) {
            unmet = `the fence of job ${job.id} could not confirm the checkout empty`;
            return;
        }
        // Every kind answered and none has anything of this job's — the checkout is free.
        if (fleets.length === 0) return true;
        const verified = await verifyClaimHeldForSweep(round, job);
        if (verified === 'lost') {
            throw new Error(
                `job ${job.id} stands down: the checkout claim was taken over while the job label still answered`
            );
        }
        if (verified === 'unknown') {
            unmet = `the checkout claim of job ${job.id} could not be confirmed before fencing`;
            return;
        }
        if (!(await deleteLeftoverSecrets(round, job, fleets))) {
            unmet = `the leftover secrets of job ${job.id} could not be deleted`;
            return;
        }
        await deleteSweepFleets(round, fleets);
        // No delete's answer is proof the checkout is free — a 409 on a uid precondition is
        // another incarnation under the name (issue #821): only a fresh, conclusive empty list
        // lets it go.
        unmet = `the leftover objects of job ${job.id} never disappeared after their delete`;
    });
    if (done === undefined) throw new Error(`${unmet} (${REPLACE_WAIT_MS}ms)`);
}

/**
 * A post-create stand-down ends this attempt's own Job the acknowledged way (issue #821): Secrets
 * first, then the Job, confirmed gone. One that cannot be confirmed is held against this attempt's
 * token, which keeps the checkout claim until a later teardown confirms it.
 */
async function standDownOwnJob(deps: K8sDeps, identity: TeardownIdentity): Promise<void> {
    await endRunnerJob(deps, identity);
}

/**
 * The runner's arrival: `prepare` takes the checkout claim, sweeps the leftovers of the job's
 * OTHER attempts and runs the pre-create claim
 * verify; `launch` creates the Job suspended, then its env Secret, runs the post-create verify and
 * only then resumes the Job. A Secret therefore never exists without a Job the fence and the reaper
 * can derive its name from (issue #821), and no pod starts before the claim is verified.
 */
export async function prepare(deps: K8sDeps, job: BoardJob, signal: AbortSignal): Promise<void> {
    // Step one: TAKE THE CHECKOUT.
    await acquireClaim(withSignal(deps, signal), job);

    // Step two: the sweep. See sweepClaimedFleets for the invariants it upholds.
    await sweepClaimedFleets(deps, job, signal);

    // Step three: the claim must STILL be ours immediately before the Job POST — the first half
    // of the bracket that fences the POST from both sides.
    const pre = claimVerdict(await readClaimObject(withSignal(deps, signal), job), job);
    if (pre === 'taken') {
        throw new Error(
            `job ${job.id} stands down: the checkout claim was taken over before the runner job was created`
        );
    }
    if (pre !== 'ours') {
        throw new Error(
            `the checkout claim of job ${job.id} could not be confirmed before creating the runner job ` +
                `(${pre.unconfirmed})`
        );
    }

    // The thread's task volume, adopted or created: the pod mounts it by name.
    await ensureTaskVolume(deps, job, signal);
}

/** The `metadata.uid` a create answered, typed: no body, a non-JSON one or one with no uid throws. */
function uidOf(response: K8sResponse, what: string): string {
    const read = readAnswer(response, what, (value) =>
        isRecord(value) && isRecord(value.metadata) && nonEmpty(value.metadata.uid) ? value.metadata.uid : null
    );
    if (read.kind !== 'value') throw new Error(`${what} answered no uid`);
    return read.value;
}

/**
 * Creates a runner Job suspended (no pod yet), then its env Secret under `secretName`. Any failure
 * on the way — a create whose answer was lost included — ends the Job the acknowledged way
 * (`standDown`) and rethrows: a create the apiserver took is never left behind unreconciled.
 */
export async function createSuspendedWithSecret(
    deps: K8sDeps,
    spec: { metadata: { name: string; annotations?: Record<string, string> }; spec: object },
    what: { job: string; secret: string; secretBody: (owner: JobOwner) => unknown },
    { identity, standDown }: { identity: TeardownIdentity; standDown: () => Promise<unknown> }
): Promise<void> {
    try {
        const created = await deps.request('POST', jobsPath(deps.config.k8sNamespace), {
            ...spec,
            spec: { ...spec.spec, suspend: true },
        });
        expectOk(created, what.job);
        // The Secret is owned by the Job's uid: collected with it, even if this driver never ends it.
        // Recorded the moment it answers: every teardown after this names that incarnation.
        const uid = uidOf(created, what.job);
        identity.uids = { job: uid };
        const stored = await deps.request(
            'POST',
            secretsPath(deps.config.k8sNamespace),
            what.secretBody({ name: spec.metadata.name, uid })
        );
        expectOk(stored, what.secret);
        identity.uids = { job: uid, secret: uidOf(stored, what.secret) };
    } catch (e) {
        await standDown();
        throw e;
    }
}

/**
 * Resumes a Job created suspended — the incarnation its create answered, by `metadata.uid` in the
 * patch, so it never resumes another; a refusal ends it the acknowledged way and rethrows.
 */
export async function resumeJob(
    deps: K8sDeps,
    name: string,
    uid: string | undefined,
    standDown: () => Promise<unknown>
): Promise<void> {
    try {
        const resumed = await deps.request('PATCH', jobPath(deps.config.k8sNamespace, name), {
            ...(uid ? { metadata: { uid } } : {}),
            spec: { suspend: false },
        });
        expectOk(resumed, `resuming the ${name} job`);
    } catch (e) {
        await standDown();
        throw e;
    }
}

// Step four: this attempt's Job, under its own attempt-scoped name, suspended, then its Secret.
export async function launch(
    deps: K8sDeps,
    job: BoardJob,
    spec: RunnerJobSpec,
    signal: AbortSignal
): Promise<IncarnationUids> {
    // The runner's name hashes this claim's own lease token, which no other claim is ever handed:
    // no other invocation can create it again, so its teardown may fall back to the name.
    const identity: TeardownIdentity = { pair: job, jobName: runnerName(job) };
    const standDown = () => standDownOwnJob(deps, identity);
    // Creating and resuming end on the stand-down; its teardown (`standDown`) stays on `deps`, uncancelled.
    const live = withSignal(deps, signal);
    await createSuspendedWithSecret(
        live,
        spec,
        {
            job: 'creating the runner job',
            secret: 'creating the runner secret',
            secretBody: (owner) => secretBody(job, secretName(job), runnerEnv(deps.config, job), owner),
        },
        { identity, standDown }
    );

    // Step five: the claim must STILL be ours once the Job exists — the second half of the
    // bracket the pre-create verify opened. See docs/kubernetes.md for the full race analysis.
    const held = claimVerdict(await readClaimObject(live, job), job);
    if (held === 'taken') {
        await standDown();
        throw new Error(`job ${job.id} stands down: the checkout claim was taken over before the runner could start`);
    }
    if (held !== 'ours') {
        // Neither provably ours nor provably gone — and after the full patience, no runner stays
        // on a checkout its driver cannot verify.
        await standDown();
        throw new Error(
            `the checkout claim of job ${job.id} could not be confirmed after creating the runner job ` +
                `(${held.unconfirmed})`
        );
    }
    // Step six: the pod starts, under a verified claim with its Secret in place.
    await resumeJob(live, spec.metadata.name, identity.uids?.job, standDown);
    return identity.uids!;
}
