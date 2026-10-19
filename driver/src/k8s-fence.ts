import type { BoardJob } from './board.js';
import { runnerClaimEnv } from './claim.js';
import type { DriverConfig } from './config.js';
import { telemetryConfig, type TelemetryConfig } from './telemetry-config.js';
import { LEASE_LABEL, REVOKED_MARK } from './labels.js';
import {
    claimBody,
    claimPath,
    configmapsPath,
    jobPath,
    jobsSelectorPath,
    podsPath,
    podsSelectorPath,
    secretsPath,
    servicesPath,
    servicesSelectorPath,
} from './k8s-auxspec.js';
import {
    finishedAgentRun,
    gateEnvSecretName,
    type JobOwner,
    jobsPath,
    type ListedRunnerJob,
    runnerName,
    secretBody,
    secretName,
    type RunnerJobSpec,
} from './k8s-podspec.js';
import { isRecord, readVerdict } from './k8s-poll.js';
import {
    deleteSecretAcked,
    endRunnerJob,
    type GroupRef,
    holderUnconfirmed,
    holderWritersGone,
    type IncarnationUids,
    retryUnconfirmed,
    type TeardownIdentity,
} from './k8s-teardown.js';
import {
    answerPreview,
    CLAIM_ROUNDS,
    expectOk,
    HTTP_CONFLICT,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    HTTP_OK_STATUS,
    JOB_ID,
    parse,
    POLL_MS,
    refusal,
    REPLACE_MAX_POLLS,
} from './k8s-transport.js';
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
 * Reads the claim a 409 answered, and either recognizes it as already ours or takes it over —
 * pulled out of `acquireClaim` purely to keep that function's complexity readable. `'ours'` stops
 * the round; `'retry'` (a vanished claim, or a stale one just released) sends the caller back to
 * `acquireClaim` for another POST.
 */
async function takeOverStaleClaim(deps: K8sDeps, job: BoardJob, path: string): Promise<'ours' | 'retry'> {
    const get = await deps.request('GET', path);
    // Gone between our 409 and the read — the holder released it; race for it again.
    if (get.status === HTTP_NOT_FOUND) return 'retry';
    expectOk(get, 'reading the checkout claim');
    const claim = parse<K8sClaim>(get.body);
    if (claim.data?.holder === job.leaseToken) {
        // Our own claim, kept because a group of ours could not be confirmed ended (issue #821): a
        // retry under the same holder — a reclaim offered again — may not start beside it.
        if (!(await retryUnconfirmed(deps, job.leaseToken))) {
            throw new Error(
                `job ${job.id} stands down: a group of this holder could not be confirmed ended, ` +
                    'so the checkout claim it keeps is not taken again'
            );
        }
        return 'ours';
    }
    // Ordered by the claim sequence, never by `attempts`: a stop or a contention requeue refunds
    // an attempt, and a replacement must still read as newer than every claim before it.
    // Digits only: `Number('')` is 0, and an empty field must never read as an ordered claim.
    const claimSeq = /^\d+$/.test(claim.data?.claimSeq ?? '') ? Number(claim.data?.claimSeq) : Number.NaN;
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

/** A claim as read now: its incarnation, and whether an orphaned-claim reap revoked it. */
export interface ReadClaim extends ObservedClaim {
    revoked: boolean;
}

/** One claim read, as the incarnation it names; null when gone, unreadable or unidentifiable. */
export async function readClaim(deps: K8sDeps, job: BoardJob): Promise<ReadClaim | null> {
    let get: K8sResponse;
    try {
        get = await deps.request('GET', claimPath(deps.config.k8sNamespace, job));
    } catch {
        return null;
    }
    if (get.status < HTTP_OK_STATUS || get.status >= HTTP_ERROR_STATUS) return null;
    const claim = parse<K8sClaim>(get.body);
    const uid = claim.metadata?.uid;
    const holder = claim.data?.holder;
    return uid && holder ? { uid, holder, revoked: claim.metadata?.annotations?.[REVOKED_MARK] !== undefined } : null;
}

/**
 * Revokes the claim incarnation an orphaned-claim reap observed (issue #821): a merge patch adding
 * `REVOKED_MARK` under the reaping acquisition's token, preconditioned on the observed uid, so it
 * can only ever mark the incarnation read. A reclaim verifies its claim unrevoked before its group
 * starts (`reclaimInGroup`), so once this answers true no group of the holder created after the
 * reaper's list can run. True only on a 2xx; a refusal or a throw revokes nothing, and the reap
 * acts on nothing.
 */
export async function revokeClaim(deps: K8sDeps, job: BoardJob, observed: ObservedClaim): Promise<boolean> {
    try {
        const patched = await deps.request('PATCH', claimPath(deps.config.k8sNamespace, job), {
            metadata: { uid: observed.uid, annotations: { [REVOKED_MARK]: job.leaseToken } },
        });
        return patched.status >= HTTP_OK_STATUS && patched.status < HTTP_ERROR_STATUS;
    } catch {
        return false;
    }
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
    ends: { groups?: readonly GroupRef[]; observed?: ObservedClaim; holderWriters?: boolean } = {}
): Promise<boolean> {
    const holder = ends.observed?.holder ?? job.leaseToken;
    if (ends.observed) {
        const now = await readClaim(deps, job);
        if (now?.uid !== ends.observed.uid || now.holder !== holder) return false;
    }
    // A recovery's claim, or a reclaim's, goes only with no reclaim group of its holder still
    // writing — another invocation's, or a pod outliving its Job's delete.
    if ((ends.observed || ends.holderWriters) && !(await holderWritersGone(deps, job, holder))) return false;
    if (!(await groupsEnded(deps, holder, ends.groups ?? []))) return false;
    const claim = await readClaim(deps, job);
    if (claim?.holder !== holder || (ends.observed && claim.uid !== ends.observed.uid)) return false;
    try {
        const deleted = await deps.request('DELETE', claimPath(deps.config.k8sNamespace, job), {
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            preconditions: { uid: claim.uid },
        });
        return deleted.status >= HTTP_OK_STATUS && deleted.status < HTTP_ERROR_STATUS;
    } catch {
        // A leaked claim costs one takeover by the next claimant, nothing worse.
        return false;
    }
}

/** Ends `groups` under `holder`; true only when every group of the holder is confirmed ended and none is live here. */
async function groupsEnded(deps: K8sDeps, holder: string, groups: readonly GroupRef[]): Promise<boolean> {
    let held = false;
    for (const group of groups) {
        const end = await endRunnerJob(deps, group, holder);
        if (end !== 'ended') held = true;
    }
    return !held && !deps.groups?.has(holder) && !holderUnconfirmed(deps, holder);
}

/** Whether a claim read's status/body prove the checkout still belongs to this attempt. */
function claimReadIsOurs(read: K8sResponse, job: BoardJob): boolean {
    const claim = parse<K8sClaim>(read.body);
    const readOk = read.status >= HTTP_OK_STATUS && read.status < HTTP_ERROR_STATUS;
    return readOk && claim.data?.holder === job.leaseToken;
}

/** Whether a claim read proves the checkout was taken over — gone, or held by someone else. */
function claimReadIsTakenOver(read: K8sResponse, job: BoardJob): boolean {
    const claim = parse<K8sClaim>(read.body);
    const readOk = read.status >= HTTP_OK_STATUS && read.status < HTTP_ERROR_STATUS;
    return (
        read.status === HTTP_NOT_FOUND || (readOk && claim.data?.holder !== undefined && !claimReadIsOurs(read, job))
    );
}

/** One kind's leftover objects — a job, a pod or a service — the sweep found by label, with the leases they carry. */
interface SweepFleet {
    kind: string;
    basePath: string;
    names: string[];
    /** The uid each listed object answered, by name: its delete names that incarnation only. */
    uids: Map<string, string>;
    leases: string[];
}

type SweptItem = ListedRunnerJob & {
    metadata?: { name?: string; uid?: string; labels?: Record<string, string> };
};

/**
 * Whether the sweep leaves a listed object alone: the finished agent run THIS attempt adopted and
 * is continuing to its verdict (`deps.adopted`), or a pod of it — the evidence a later claim adopts
 * again if this one is lost first (issue #821). It writes nothing: its pod ran to its end. Every
 * other finished run goes, before a fresh sync can change the tree its outcome was read against.
 */
function spared(deps: K8sDeps, job: BoardJob, item: SweptItem, keptJobs: Set<string>): boolean {
    const adopted = deps.adopted?.get(job.leaseToken);
    const lease = item.metadata?.labels?.[LEASE_LABEL];
    if (
        adopted !== undefined &&
        item.metadata?.name === adopted &&
        lease &&
        JOB_ID.test(lease) &&
        finishedAgentRun(item, { ...job, leaseToken: lease })
    ) {
        keptJobs.add(adopted);
        return true;
    }
    return keptJobs.has(item.metadata?.labels?.['job-name'] ?? '');
}

/**
 * The named objects a label-selector list response carries, and their lease labels; null for a body
 * that is no list of objects, which proves nothing about what is left (#824).
 */
function namedItemsOf(
    deps: K8sDeps,
    job: BoardJob,
    body: string,
    keptJobs: Set<string>
): Omit<SweepFleet, 'kind' | 'basePath'> | null {
    const list = parse<unknown>(body);
    if (!isRecord(list) || !Array.isArray(list.items) || !list.items.every(isRecord)) return null;
    const items = list.items as SweptItem[];
    const found: Omit<SweepFleet, 'kind' | 'basePath'> = { names: [], uids: new Map(), leases: [] };
    for (const item of items) {
        if (!item.metadata?.name || spared(deps, job, item, keptJobs)) continue;
        found.names.push(item.metadata.name);
        if (item.metadata.uid) found.uids.set(item.metadata.name, item.metadata.uid);
        const lease = item.metadata.labels?.[LEASE_LABEL];
        if (lease) found.leases.push(lease);
    }
    return found;
}

/**
 * One label selector's leftover objects, or `null` for a kind that answered nothing of this job's
 * — `inconclusive` true the instant the kind could not be read at all, since a transport failure
 * or 429/5xx says nothing about whether its objects are gone.
 */
async function probeOneFleetKind(
    deps: K8sDeps,
    job: BoardJob,
    [kind, selectorPath, basePath]: readonly [string, string, string],
    keptJobs: Set<string>
): Promise<{ fleet: SweepFleet | null; inconclusive: boolean }> {
    let probe: K8sResponse;
    try {
        probe = await deps.request('GET', selectorPath);
    } catch {
        // A transport failure says nothing about whether the objects are gone.
        probe = { status: 0, body: '' };
    }
    // A kind answering nothing at all has nothing of this job in it.
    if (probe.status === HTTP_NOT_FOUND) return { fleet: null, inconclusive: false };
    if (probe.status >= HTTP_OK_STATUS && probe.status < HTTP_ERROR_STATUS) {
        const found = namedItemsOf(deps, job, probe.body, keptJobs);
        // A 2xx that is no list says nothing about whether the objects are gone.
        if (!found) return { fleet: null, inconclusive: true };
        return { fleet: found.names.length > 0 ? { kind, basePath, ...found } : null, inconclusive: false };
    }
    // 429/5xx/transport: inconclusive — the round cannot free the checkout.
    return { fleet: null, inconclusive: true };
}

/**
 * One pass over the three label selectors a leftover attempt can answer on. `conclusive` is false
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
    const keptJobs = new Set<string>();
    for (const kind of [
        ['job', jobsSelectorPath(deps.config.k8sNamespace, job), jobsPath(deps.config.k8sNamespace)],
        ['pod', podsSelectorPath(deps.config.k8sNamespace, job), podsPath(deps.config.k8sNamespace)],
        ['service', servicesSelectorPath(deps.config.k8sNamespace, job), servicesPath(deps.config.k8sNamespace)],
    ] as const) {
        const { fleet, inconclusive } = await probeOneFleetKind(deps, job, kind, keptJobs);
        if (fleet) fleets.push(fleet);
        if (inconclusive) conclusive = false;
    }
    return { fleets, conclusive };
}

/** Whether this attempt still (provably) holds the claim the sweep is clearing leftovers for. */
async function verifyClaimHeldForSweep(deps: K8sDeps, job: BoardJob): Promise<'ours' | 'lost' | 'unknown'> {
    try {
        const held = await deps.request('GET', claimPath(deps.config.k8sNamespace, job));
        if (held.status === HTTP_NOT_FOUND) return 'lost';
        if (held.status >= HTTP_OK_STATUS && held.status < HTTP_ERROR_STATUS) {
            // A 2xx that cannot name its holder also reads as lost, deliberately asymmetric with
            // step six: standing down deletes nothing, so garbage is safe to act on HERE — while
            // step six deletes the Job, so there the same evidence fails loud without acting.
            return parse<K8sClaim>(held.body).data?.holder === job.leaseToken ? 'ours' : 'lost';
        }
        // 429/5xx: unconfirmed — neither delete nor stand down on a maybe.
        return 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * The Secrets of every leftover lease, by derived name, acknowledged — BEFORE any Job of theirs is
 * deleted (issue #821): a Secret has no owner, and once its Job is gone nothing can derive its name
 * again. False when any one delete failed; the round then deletes nothing.
 */
/** Thrown by a sweep whose attempt stood down (`signal`): nothing more is deleted. */
const sweepAbandoned = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw new Error('the sweep was abandoned: the attempt stood down');
};

async function deleteLeftoverSecrets(
    deps: K8sDeps,
    job: BoardJob,
    fleets: SweepFleet[],
    signal?: AbortSignal
): Promise<boolean> {
    const leases = new Set(fleets.flatMap((fleet) => fleet.leases).filter((lease) => JOB_ID.test(lease)));
    const adopted = deps.adopted?.get(job.leaseToken);
    for (const lease of leases) {
        const pair = { ...job, leaseToken: lease };
        // The adopted run's lease keeps its Job listed: its Secrets stay derivable from it, and
        // their cleanup is never what holds a recovered run back (issue #821).
        if (adopted !== undefined && runnerName(pair) === adopted) continue;
        for (const name of [secretName(pair), gateEnvSecretName(pair)]) {
            sweepAbandoned(signal);
            if ((await deleteSecretAcked(deps, name)) === 'failed') return false;
        }
    }
    return true;
}

/** Deletes every named leftover of one sweep pass; the next pass's list is what says they are gone. */
async function deleteSweepFleets(deps: K8sDeps, fleets: SweepFleet[], signal?: AbortSignal): Promise<void> {
    for (const fleet of fleets) {
        for (const leftover of fleet.names) {
            sweepAbandoned(signal);
            // The incarnation listed, by its uid: never one created under the name since.
            const uid = fleet.uids.get(leftover);
            const target = `${fleet.basePath}/${leftover}?propagationPolicy=Foreground`;
            const response = await (uid
                ? deps.request('DELETE', target, { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid } })
                : deps.request('DELETE', target));
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
 * attempt's Job starts. It runs at the runner's launch, AFTER the loop already started this
 * attempt's services and ran its setup Job, so those briefly share the namespace with a dead
 * attempt's leftovers; a service of this attempt they disturbed is put back by the pre-gate
 * restart (issue #560). No timestamps, no cutoffs, no clocks: an age filter
 * was unsound in both directions, so the sweep classifies nothing. The claim is re-read before
 * every deleting round: a stale attempt whose claim was taken over mid-sweep STANDS DOWN having
 * deleted nothing.
 */
export async function sweepClaimedFleets(deps: K8sDeps, job: BoardJob, waits = 0, signal?: AbortSignal): Promise<void> {
    const nextRound = async (giveUpMessage: string): Promise<void> => {
        if (waits + 1 > REPLACE_MAX_POLLS) {
            throw new Error(`${giveUpMessage} (${REPLACE_MAX_POLLS} polls)`);
        }
        await deps.sleep(POLL_MS);
        return sweepClaimedFleets(deps, job, waits + 1, signal);
    };

    const { fleets, conclusive } = await probeLeftoverFleets(deps, job);
    // Every kind answered and none has anything of this job's — the checkout is free.
    if (fleets.length === 0) {
        if (conclusive) return;
        // Inconclusive: keep polling within the same bound instead of creating alongside what
        // may still be there.
        return nextRound(`the fence of job ${job.id} could not confirm the checkout empty`);
    }
    const verified = await verifyClaimHeldForSweep(deps, job);
    if (verified === 'lost') {
        throw new Error(
            `job ${job.id} stands down: the checkout claim was taken over while the job label still answered`
        );
    }
    if (verified === 'unknown') {
        return nextRound(`the checkout claim of job ${job.id} could not be confirmed before fencing`);
    }
    if (!(await deleteLeftoverSecrets(deps, job, fleets, signal))) {
        return nextRound(`the leftover secrets of job ${job.id} could not be deleted`);
    }
    await deleteSweepFleets(deps, fleets, signal);
    // No delete's answer is proof the checkout is free — a 409 on a uid precondition is another
    // incarnation under the name (issue #821): only a fresh, conclusive empty list lets it go.
    return nextRound(`the leftover objects of job ${job.id} never disappeared after their delete`);
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
 * OTHER attempts (the loop already started this attempt's services) and runs the pre-create claim
 * verify; `launch` creates the Job suspended, then its env Secret, runs the post-create verify and
 * only then resumes the Job. A Secret therefore never exists without a Job the fence and the reaper
 * can derive its name from (issue #821), and no pod starts before the claim is verified.
 */
export async function prepare(deps: K8sDeps, job: BoardJob): Promise<void> {
    // Step one: TAKE THE CHECKOUT.
    await acquireClaim(deps, job);

    // Step two: the sweep. See sweepClaimedFleets for the invariants it upholds.
    await sweepClaimedFleets(deps, job);

    // Step three: the claim must STILL be ours immediately before the Job POST — the first half
    // of the bracket that fences the POST from both sides.
    const pre = await readVerdict(deps, claimPath(deps.config.k8sNamespace, job), 'reading the checkout claim');
    if (claimReadIsTakenOver(pre, job)) {
        throw new Error(
            `job ${job.id} stands down: the checkout claim was taken over before the runner job was created`
        );
    }
    if (!claimReadIsOurs(pre, job)) {
        throw new Error(
            `the checkout claim of job ${job.id} could not be confirmed before creating the runner job ` +
                `(${answerPreview(pre.status, pre.body)})`
        );
    }
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
        const uid = parse<{ metadata?: { uid?: string } }>(created.body).metadata?.uid;
        if (!uid) throw new Error(`${what.job} answered no uid for the Job`);
        identity.uids = { job: uid };
        const stored = await deps.request(
            'POST',
            secretsPath(deps.config.k8sNamespace),
            what.secretBody({ name: spec.metadata.name, uid })
        );
        expectOk(stored, what.secret);
        const secret = parse<{ metadata?: { uid?: string } }>(stored.body).metadata?.uid;
        if (secret) identity.uids = { job: uid, secret };
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
export async function launch(deps: K8sDeps, job: BoardJob, spec: RunnerJobSpec): Promise<IncarnationUids> {
    // The runner's name hashes this claim's own lease token, which no other claim is ever handed:
    // no other invocation can create it again, so its teardown may fall back to the name.
    const identity: TeardownIdentity = { pair: job, jobName: runnerName(job) };
    const standDown = () => standDownOwnJob(deps, identity);
    await createSuspendedWithSecret(
        deps,
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
    let held: K8sResponse;
    try {
        held = await readVerdict(deps, claimPath(deps.config.k8sNamespace, job), 'reading the checkout claim');
    } catch (e) {
        await standDown();
        throw e;
    }
    if (claimReadIsTakenOver(held, job)) {
        await standDown();
        throw new Error(`job ${job.id} stands down: the checkout claim was taken over before the runner could start`);
    }
    if (!claimReadIsOurs(held, job)) {
        // Neither provably ours nor provably gone — and after the full patience, no runner stays
        // on a checkout its driver cannot verify.
        await standDown();
        throw new Error(
            `the checkout claim of job ${job.id} could not be confirmed after creating the runner job ` +
                `(${answerPreview(held.status, held.body)})`
        );
    }
    // Step six: the pod starts, under a verified claim with its Secret in place.
    await resumeJob(deps, spec.metadata.name, identity.uids?.job, standDown);
    return identity.uids!;
}
