import type { BoardJob } from './board.js';
import { executorImage } from './config.js';
import { jobPath } from './k8s-auxspec.js';
import { ledgerOf, RunnerKilled } from './k8s-kill.js';
import { launch, prepare, releaseClaimAfterGroupEnd } from './k8s-fence.js';
import { jobsPath, runnerJobSpec, runnerName } from './k8s-podspec.js';
import { isLease } from './k8s-shapes.js';
import { asIdentified } from './k8s-pod-shapes.js';
import {
    asJob,
    jobOutcome,
    type PodStartState,
    readImagePullStatus,
    readTyped,
    readTypedList,
    startRefusalOf,
} from './k8s-poll.js';
import { heldUnpullable } from './k8s-held.js';
import {
    GROUP_END_WAIT_MS,
    type GroupRef,
    holderUnconfirmed,
    type IncarnationUids,
    markEnding,
    retryUnconfirmed,
} from './k8s-teardown.js';
import { HOLDER_LABEL, JOB_LABEL, LEASE_LABEL } from './labels.js';
import { boundedBy, POLL_MS, waitOf, withSignal } from './k8s-transport.js';
import { anyOf, pollFor } from './poll.js';
import type { K8sDeps } from './k8s-transport.js';
import type { RunSession } from './runner.js';
import { StartupRefused } from './startup-cause.js';
import {
    attachSteps,
    awaitFirstContact,
    GROUP_UP_WAIT_MS,
    orderFinish,
    releaseSteps,
    type StepHost,
    stepHostOf,
} from './supervised-steps.js';

/**
 * The kubernetes task group of one attempt (issue #771): the one Job whose pod holds the supervisor,
 * the agent and the exporter, created by the attempt's first step — the sync — and ended by its
 * last, rather than by the agent's exit. Everything the attempt does on the task worktree that is
 * not the agent's own work (the sync, the tree probe, the review snapshot, the publish, the
 * helpers) is a step the supervisor runs; none of it is a Job or a container of its own. This file
 * is the group's lifecycle: create (under the checkout fence), wait for its supervisor, end it, and
 * the supervisor-only group a thread with no attempt needs for its reclaim.
 */

/** What this process remembers of an attempt's group: the run the pod was specced for. */
export interface TaskGroup {
    startedAt: string;
    session: RunSession | null;
    /** Whether the group runs an agent: only such a Job is a run a later claim may adopt. */
    agent: boolean;
    /** The incarnation this runner created: its teardown deletes that one only. */
    uids: IncarnationUids;
}

/** The attempt's own task group: its runner Job, named by its lease token. */
export const runnerGroupOf = (job: BoardJob, uids?: IncarnationUids): GroupRef => ({
    pair: job,
    jobName: runnerName(job),
    ...(uids ? { uids } : {}),
});

/**
 * Forgets the attempt's group, its end marked pending first — synchronously, before anything is
 * awaited — so no concurrent hand-back of the claim slips in while it is torn down. Answers what
 * the runner knew of it (its incarnation), or undefined for a group it never created.
 */
export function forgetGroup(deps: K8sDeps, job: BoardJob): TaskGroup | undefined {
    const known = groupsOf(deps).get(job.leaseToken);
    markEnding(deps, runnerGroupOf(job, known?.uids));
    groupsOf(deps).delete(job.leaseToken);
    return known;
}

/** One listed Job, as much of it as names an earlier group of a holder. */
interface ListedGroupJob {
    metadata: { name: string; uid: string; labels: Record<string, string> };
}

/** A listed group Job (#869): identified by name and uid, and carrying the lease its pair is named by. */
const asHolderGroup = (value: unknown): ListedGroupJob | null => {
    const item = asIdentified<ListedGroupJob>(value);
    return item && isLease(item.metadata.labels?.[LEASE_LABEL]) ? item : null;
};

/**
 * Every group a checkout holder can have left: its attempt's runner group, and each reclaim group
 * labelled as serving it (`HOLDER_LABEL`) — listed, each named by the uid it was listed under.
 * Null when the list proves nothing: the caller acts on none of them.
 */
export async function holderGroupsOf(deps: K8sDeps, job: BoardJob, holder: string): Promise<GroupRef[] | null> {
    const path = `${jobsPath(deps.config.k8sNamespace)}?labelSelector=${encodeURIComponent(
        `${JOB_LABEL}=${job.id},${HOLDER_LABEL}=${holder}`
    )}`;
    const listed = await readTypedList<ListedGroupJob>(deps, path, 'listing the holder groups', {
        entry: asHolderGroup,
        once: true,
    });
    if (listed.kind !== 'value') return null;
    const groups: GroupRef[] = [runnerGroupOf({ ...job, leaseToken: holder })];
    for (const item of listed.value) {
        const { name, uid, labels } = item.metadata;
        groups.push({ pair: { ...job, leaseToken: labels[LEASE_LABEL]! }, jobName: name, uids: { job: uid } });
    }
    return groups;
}

/** The attempt groups this runner created, by lease token: one per attempt, never shared. */
export const groupsOf = (deps: K8sDeps): Map<string, TaskGroup> => {
    deps.groups ??= new Map();
    return deps.groups;
};

/**
 * Waits until the group's supervisor has pulled from the driver at least once, failing at once on a
 * held container whose words prove why (issue #302; typed by #824 D11) and past `GROUP_UP_WAIT_MS` —
 * elapsed time, not a count of polls (`awaitFirstContact`) — on anything else; a driver kill ends the wait at once. At the bound, a pod the platform was still
 * bringing up (none yet, or none of its containers started) is a transient refusal; a back-off that
 * never named its cause, a supervisor that runs without answering, or lists that never answered prove
 * nothing, and are left to the lease.
 */
async function awaitSupervisor(deps: K8sDeps, job: BoardJob, jobName: string): Promise<void> {
    const image = executorImage(deps.config, job.executorType);
    const seen: { last: PodStartState; unproven: string | null } = { last: 'unread', unproven: null };
    const contacted = await awaitFirstContact(stepHostOf(deps), job, {
        sleep: deps.sleep,
        signal: ledgerOf(deps).signal(job),
        probe: async ({ deadline, signal }) => {
            const pull = await readImagePullStatus(withSignal(boundedBy(deps, deadline), signal), jobName);
            const refused = startRefusalOf(image, pull, true);
            if (refused) throw refused;
            if (pull.blocked) seen.unproven = heldUnpullable(image, pull, pull.blocked);
            if (pull.podState !== 'unread') seen.last = pull.podState;
        },
    });
    if (contacted) return;
    if (seen.unproven) throw new Error(seen.unproven);
    const why = `the task supervisor of ${jobName} never came up within ${GROUP_UP_WAIT_MS}ms`;
    if (seen.last === 'none' || seen.last === 'starting') throw new StartupRefused(why, 'transient');
    throw new Error(why);
}

/**
 * Creates the attempt's group once, under the checkout fence: the claim, the sweep of the job's
 * other attempts, the env Secret and the Job, then waits for the supervisor. A second call — the run
 * after the sync — finds it and answers it; a run specced for another session is refused, because
 * a pod's containers cannot change after it exists.
 */
export async function ensureGroup(
    deps: K8sDeps,
    job: BoardJob,
    session: RunSession | null,
    signal?: AbortSignal
): Promise<TaskGroup> {
    const known = groupsOf(deps).get(job.leaseToken);
    if (known) {
        if (known.session?.id !== session?.id || known.session?.resume !== session?.resume) {
            throw new Error(`the task group of job ${job.id} was specced for another session than the run's`);
        }
        return known;
    }
    // A lease the ledger says was stopped gets no group: a step that awaited (a credential) must not
    // revive the attempt a kill already ended, before the fence, a Secret or the Job.
    if (ledgerOf(deps).was(job).stopped) throw new RunnerKilled(runnerName(job));
    const kill = anyOf(ledgerOf(deps).signal(job), signal);
    await prepare(deps, job, kill);
    // A fresh supervisor answers the token from here: not one a kill already took away.
    attachSteps(stepHostOf(deps), job);
    const startedAt = new Date().toISOString();
    const uids = await launch(deps, job, runnerJobSpec(deps.config, job, session, startedAt), kill);
    const group: TaskGroup = { startedAt, session, agent: job.agent !== false, uids };
    groupsOf(deps).set(job.leaseToken, group);
    await awaitSupervisor(deps, job, runnerName(job));
    return group;
}

/**
 * The step host of an attempt whose first step is not its sync — an adopted run, or a gate or
 * service step before any sync: a group is created for it on demand, a supervisor and no agent.
 * A group the sync already created is simply answered. The claim the group took is the group's end's to
 * give back (`finishGroup`), never this call's.
 */
export async function stepHostFor(deps: K8sDeps, job: BoardJob): Promise<StepHost> {
    if (!groupsOf(deps).has(job.leaseToken)) await ensureGroup(deps, { ...job, agent: false }, null);
    return stepHostOf(deps);
}

/** Ends the attempt's group now, acknowledged, and hands the checkout back only once its end is confirmed. */
export async function takeGroupDown(deps: K8sDeps, job: BoardJob): Promise<void> {
    const known = forgetGroup(deps, job);
    releaseSteps(stepHostOf(deps), job);
    await releaseClaimAfterGroupEnd(deps, job, { groups: [runnerGroupOf(job, known?.uids)] });
}

/** How a Job stood at the end of the wait: `unread` when its last read proved nothing (#869). */
type JobEnd = 'ended' | 'running' | 'unread';

/**
 * Whether the Job ended (or is gone) within `ms`, read at the poll pace and bounded by the time it
 * takes as well as the polls. A read that proves nothing is no evidence of either: it waits on and,
 * as the last word, answers `unread`.
 */
export async function jobEndsWithin(deps: K8sDeps, name: string, ms: number): Promise<JobEnd> {
    let last: JobEnd = 'running';
    const ended = await pollFor<true>({ ...waitOf(deps, ms), everyMs: POLL_MS }, async (deadline) => {
        const read = await readTyped(
            boundedBy(deps, deadline),
            jobPath(deps.config.k8sNamespace, name),
            'reading the task group',
            {
                shape: asJob,
            }
        );
        if (read.kind === 'absent') return true;
        if (read.kind === 'value' && jobOutcome(read.value.status) !== 'pending') return true;
        last = read.kind === 'value' ? 'running' : 'unread';
    });
    return ended ? 'ended' : last;
}

/**
 * Ends the attempt's group: the supervisor is ordered to finish, finalizes and exits, and the Job
 * ends with it, waited for within the bound. A Job that ran an agent and ended by itself is KEPT — its Secrets
 * deleted, acknowledged, and no live writer pod left confirms the end — so a replacement claim
 * can adopt the finished run if this driver is lost before its verdict lands; one that did not end
 * in the bound is ended destructively (Secrets, Job, confirmation). Only a confirmed end hands the
 * checkout claim back. Idempotent, and a no-op for an attempt that never created one (or whose
 * group a kill already took away). Never throws.
 */
export async function finishGroup(deps: K8sDeps, job: BoardJob): Promise<void> {
    if (!groupsOf(deps).has(job.leaseToken)) {
        // A group already taken away (a kill) whose end went unconfirmed is ended again here, and
        // its claim given back once it is.
        if (holderUnconfirmed(deps, job.leaseToken) && (await retryUnconfirmed(deps, job.leaseToken))) {
            await releaseClaimAfterGroupEnd(deps, job);
        }
        return;
    }
    const known = forgetGroup(deps, job)!;
    await orderFinish(stepHostOf(deps), job).catch(() => undefined);
    // A supervisor-only group ran no agent: its Job is no run to adopt, and ends destructively.
    // An unread Job is never deleted on that: held, kept, and ended again once it reads (`retryUnconfirmed`).
    const keep = (await jobEndsWithin(deps, runnerName(job), GROUP_END_WAIT_MS)) !== 'running' && known.agent;
    await releaseClaimAfterGroupEnd(deps, job, { groups: [{ ...runnerGroupOf(job, known.uids), keep }] });
}
