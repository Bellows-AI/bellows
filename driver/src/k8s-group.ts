import { randomUUID } from 'node:crypto';
import type { BoardJob } from './board.js';
import { executorImage, type DriverConfig } from './config.js';
import { clearKilled } from './k8s-kill.js';
import {
    createSuspendedWithSecret,
    launch,
    type ObservedClaim,
    prepare,
    readClaim,
    releaseClaimAfterGroupEnd,
    resumeJob,
} from './k8s-fence.js';
import {
    hash16,
    jobsPath,
    runnerJobSpec,
    runnerName,
    secretBody,
    secretName,
    workspaceMount,
    type RunnerJobSpec,
    type RunnerPodContainer,
} from './k8s-podspec.js';
import { containerHardeningField } from './k8s-podfields.js';
import { GATE_GID, TOOL_UID, workspacePath } from './claim.js';
import { RELEASE_DEADLINE_MS, toolTreeReleaseBoundedScript, toolTreeReleaseScript, worktreeDir } from './publish.js';
import { type PodStartState, readImagePullStatus, readJobStatus, startRefusalOf, unpullableImage } from './k8s-poll.js';
import {
    endRunnerJob,
    GROUP_END_WAIT_MS,
    type GroupRef,
    holderUnconfirmed,
    type IncarnationUids,
    holderWritersGone,
    markEnding,
    retryUnconfirmed,
    type TeardownIdentity,
} from './k8s-teardown.js';
import { HOLDER_LABEL, JOB_LABEL, LEASE_LABEL } from './labels.js';
import { HTTP_ERROR_STATUS, HTTP_OK_STATUS, JOB_ID, MS_PER_SECOND, parse, POLL_MS } from './k8s-transport.js';
import type { K8sDeps } from './k8s-transport.js';
import type { ReclaimResult } from './publish.js';
import type { RunSession } from './runner.js';
import { StartupRefused } from './startup-cause.js';
import { attachSteps, orderFinish, releaseSteps, runReclaimStep, stepHostOf } from './supervised-steps.js';
import { SUPERVISOR_ENV } from './supervisor-contract.js';

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

/** How long a created group may take to show its supervisor — an image pull, a node scaling up. */
const GROUP_UP_WAIT_MS = 600_000;

/**
 * The group of a thread with no attempt, which a terminal reclaim has to run in: a supervisor and
 * nothing else — no agent, no exporter, no member env — under a name of its own, so it can never
 * answer to the attempt group's. The reclaim is a supervised step like every other; only the group
 * differs. Its deadline is the reclaim's own plus the wind-down, not a run's.
 */
export const reclaimGroupName = (job: BoardJob): string => `factory-reclaim-${hash16(`${job.id}|${job.leaseToken}`)}`;

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
    metadata?: { name?: string; uid?: string; labels?: Record<string, string> };
}

/**
 * Every group a checkout holder can have left: its attempt's runner group, and each reclaim group
 * labelled as serving it (`HOLDER_LABEL`) — listed, each named by the uid it was listed under.
 * Null when the list proves nothing: the caller acts on none of them.
 */
export async function holderGroupsOf(deps: K8sDeps, job: BoardJob, holder: string): Promise<GroupRef[] | null> {
    const path = `${jobsPath(deps.config.k8sNamespace)}?labelSelector=${encodeURIComponent(
        `${JOB_LABEL}=${job.id},${HOLDER_LABEL}=${holder}`
    )}`;
    const listed = await deps.request('GET', path).catch(() => null);
    if (!listed || listed.status < HTTP_OK_STATUS || listed.status >= HTTP_ERROR_STATUS) return null;
    const groups: GroupRef[] = [runnerGroupOf({ ...job, leaseToken: holder })];
    for (const item of parse<{ items?: ListedGroupJob[] }>(listed.body).items ?? []) {
        const lease = item.metadata?.labels?.[LEASE_LABEL];
        const name = item.metadata?.name;
        const uid = item.metadata?.uid;
        if (!lease || !JOB_ID.test(lease) || !name || !uid) return null;
        groups.push({ pair: { ...job, leaseToken: lease }, jobName: name, uids: { job: uid } });
    }
    return groups;
}

/** The bound of a reclaim group: its one step's deadline, and the time to finalize. */
const RECLAIM_GROUP_SECONDS = 1200;

export function reclaimGroupSpec(config: DriverConfig, job: BoardJob, holder: string): RunnerJobSpec {
    const spec = runnerJobSpec(config, { ...job, agent: false }, null);
    const worktree = worktreeDir(config, job);
    const pod = spec.spec.template.spec;
    // The checkout holder it serves, on the Job and its pods: how what it left is found again.
    const holderLabel = { [HOLDER_LABEL]: holder };
    return {
        ...spec,
        metadata: {
            ...spec.metadata,
            name: reclaimGroupName(job),
            labels: { ...spec.metadata.labels, ...holderLabel },
        },
        spec: {
            ...spec.spec,
            activeDeadlineSeconds: RECLAIM_GROUP_SECONDS,
            template: {
                ...spec.spec.template,
                metadata: {
                    ...spec.spec.template.metadata,
                    labels: { ...spec.spec.template.metadata.labels, ...holderLabel },
                },
                spec: { ...pod, ...(worktree ? { initContainers: [releaseContainer(config, job, worktree)] } : {}) },
            },
        },
    };
}

/**
 * The tool uid's release of the tree (issue #814), before the supervisor starts and so before the
 * reclaim step: a directory a tool closed with an explicit mode is one the uid-1000 reclaim cannot
 * empty. Hardened like every container, as the tool uid, the tree's path its only input. Bounded by
 * docker's own deadline, well inside the wait for the supervisor, and 0 whatever happened to it: the
 * reclaim's own verdict decides.
 */
function releaseContainer(config: DriverConfig, job: BoardJob, worktree: string): RunnerPodContainer {
    const hardened = containerHardeningField().securityContext;
    return {
        name: 'release',
        image: executorImage(config, job.executorType),
        imagePullPolicy: config.imagePullPolicy,
        securityContext: { ...hardened, runAsUser: TOOL_UID, runAsGroup: GATE_GID },
        command: ['sh', '-c', toolTreeReleaseBoundedScript, 'release', toolTreeReleaseScript],
        env: [
            { name: 'WORKTREE', value: worktree },
            { name: 'RELEASE_DEADLINE_SECONDS', value: String(RELEASE_DEADLINE_MS / MS_PER_SECOND) },
        ],
        volumeMounts: [workspaceMount(config, workspacePath(job))],
    };
}

/** The attempt groups this runner created, by lease token: one per attempt, never shared. */
export const groupsOf = (deps: K8sDeps): Map<string, TaskGroup> => {
    deps.groups ??= new Map();
    return deps.groups;
};

/**
 * Waits until the group's supervisor has pulled from the driver at least once, failing at once on a
 * held container whose words prove why (issue #302; typed by #824 D11) and past `GROUP_UP_WAIT_MS` —
 * elapsed time, not a count of polls — on anything else. At the bound, a pod the platform was still
 * bringing up (none yet, or none of its containers started) is a transient refusal; a back-off that
 * never named its cause, a supervisor that runs without answering, or lists that never answered prove
 * nothing, and are left to the lease.
 */
async function awaitSupervisor(deps: K8sDeps, job: BoardJob, jobName: string): Promise<void> {
    const sink = stepHostOf(deps).sink;
    const token = job.supervisorEnv?.[SUPERVISOR_ENV.controlToken];
    if (!token) return;
    const image = executorImage(deps.config, job.executorType);
    const started = Date.now();
    let last: PodStartState = 'unread';
    let unproven: string | null = null;
    for (let polls = 0; Math.max(polls * POLL_MS, Date.now() - started) < GROUP_UP_WAIT_MS; polls += 1) {
        if (sink.contacted(token)) return;
        const pull = await readImagePullStatus(deps, jobName);
        const refused = startRefusalOf(image, pull, true);
        if (refused) throw refused;
        if (pull.blocked) unproven = pull.blocked;
        if (pull.podState !== 'unread') last = pull.podState;
        await deps.sleep(POLL_MS);
    }
    if (unproven) throw new Error(unpullableImage('executor', image, unproven));
    const why = `the task supervisor of ${jobName} never came up within ${GROUP_UP_WAIT_MS}ms`;
    if (last === 'none' || last === 'starting') throw new StartupRefused(why, 'transient');
    throw new Error(why);
}

/**
 * Creates the attempt's group once, under the checkout fence: the claim, the sweep of the job's
 * other attempts, the env Secret and the Job, then waits for the supervisor. A second call — the run
 * after the sync — finds it and answers it; a run specced for another session is refused, because
 * a pod's containers cannot change after it exists.
 */
export async function ensureGroup(deps: K8sDeps, job: BoardJob, session: RunSession | null): Promise<TaskGroup> {
    const known = groupsOf(deps).get(job.leaseToken);
    if (known) {
        if (known.session?.id !== session?.id || known.session?.resume !== session?.resume) {
            throw new Error(`the task group of job ${job.id} was specced for another session than the run's`);
        }
        return known;
    }
    clearKilled(runnerName(job));
    await prepare(deps, job);
    // A fresh supervisor answers the token from here: not one a kill already took away.
    attachSteps(stepHostOf(deps), job);
    const startedAt = new Date().toISOString();
    const uids = await launch(deps, job, runnerJobSpec(deps.config, job, session, startedAt));
    const group: TaskGroup = { startedAt, session, agent: job.agent !== false, uids };
    groupsOf(deps).set(job.leaseToken, group);
    await awaitSupervisor(deps, job, runnerName(job));
    return group;
}

/** Ends the attempt's group now, acknowledged, and hands the checkout back only once its end is confirmed. */
export async function takeGroupDown(deps: K8sDeps, job: BoardJob): Promise<void> {
    const known = forgetGroup(deps, job);
    releaseSteps(stepHostOf(deps), job);
    await releaseClaimAfterGroupEnd(deps, job, { groups: [runnerGroupOf(job, known?.uids)] });
}

/** Whether the Job ended (or is gone) within `ms`, read at the poll pace. */
async function jobEndsWithin(deps: K8sDeps, name: string, ms: number): Promise<boolean> {
    const polls = Math.ceil(ms / POLL_MS);
    for (let poll = 0; poll < polls; poll += 1) {
        const read = await readJobStatus(deps, name, 'reading the task group').catch(() => null);
        if (!read || read.kind === 'error') return false;
        if (read.kind === 'notFound' || read.kind === 'terminal') return true;
        await deps.sleep(POLL_MS);
    }
    return false;
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
    const keep = (await jobEndsWithin(deps, runnerName(job), GROUP_END_WAIT_MS)) && known.agent;
    await releaseClaimAfterGroupEnd(deps, job, { groups: [{ ...runnerGroupOf(job, known.uids), keep }] });
}

/**
 * The terminal reclaim, in a supervisor-only group: the thread has no attempt, so there is no
 * group to ask. The group is a supervisor and nothing else — no agent, no exporter, no member env
 * — under a random lease of its own, labelled with the checkout holder it serves (`HOLDER_LABEL`),
 * so nothing of the thread's attempts answers to it and no other invocation ever shares its names;
 * a retry under the same holder finds what an earlier one left by that label, and waits for any of
 * it still writing. The caller holds the checkout claim for the whole call; the group's
 * end is recorded against that holder, so a group not confirmed ended keeps the claim and answers
 * as a refusal. A group that cannot come up is a refusal, never a throw.
 */
export async function reclaimInGroup(deps: K8sDeps, job: BoardJob, acquired: ObservedClaim): Promise<ReclaimResult> {
    if (!deps.endpoint) {
        return {
            ok: false,
            removed: false,
            reason: 'this driver has no supervisor endpoint to run the reclaim through',
        };
    }
    const holder = job.leaseToken;
    // A token of this invocation's own: its names are never another invocation's. What an earlier
    // invocation of this holder left is found by the holder label, and one still writing holds the
    // reclaim off — never ended here, never deleted by a name.
    if (!(await holderWritersGone(deps, job, holder))) {
        return {
            ok: false,
            removed: false,
            reason: 'an earlier reclaim group of this holder is still running',
        };
    }
    const pair: BoardJob = { ...job, leaseToken: randomUUID() };
    const name = reclaimGroupName(pair);
    const opened = await deps.endpoint.open();
    const group: BoardJob = {
        ...pair,
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: opened.url, [SUPERVISOR_ENV.controlToken]: opened.token },
    };
    let result: ReclaimResult;
    // This invocation's own identity: its random mark and, the moment each create answers, its uids.
    const identity: TeardownIdentity = { pair: group, jobName: name };
    try {
        // The Job suspended first, its Secret after, then the pod (issue #821): a Secret never
        // exists without a Job to derive it from. A failure is ended below, whatever it left.
        const noStandDown = () => Promise.resolve();
        await createSuspendedWithSecret(
            deps,
            reclaimGroupSpec(deps.config, group, holder),
            {
                job: 'creating the reclaim group',
                secret: 'creating the reclaim group secret',
                secretBody: (owner) => secretBody(group, secretName(group), group.supervisorEnv ?? {}, owner),
            },
            { identity, standDown: noStandDown }
        );
        // The claim must still be the incarnation this invocation took, unrevoked, before anything
        // runs: a create delayed past its lease may land after the row's other driver retook the
        // checkout, or after an orphaned-claim reap revoked it and listed this holder's groups.
        const now = await readClaim(deps, job);
        if (now?.uid !== acquired.uid || now.holder !== acquired.holder) {
            throw new Error('the checkout claim this reclaim took was replaced before its group could start');
        }
        if (now.revoked)
            throw new Error('the checkout claim this reclaim took was revoked before its group could start');
        await resumeJob(deps, name, identity.uids?.job, noStandDown);
        await awaitSupervisor(deps, group, name);
        result = await runReclaimStep(stepHostOf(deps), group);
    } catch (e) {
        result = { ok: false, removed: false, reason: `the worktree reclaim group failed: ${(e as Error).message}` };
    }
    await orderFinish(stepHostOf(deps), group).catch(() => undefined);
    deps.endpoint.close(opened.token);
    // The claim is handed back only once nothing of this group can write the tree.
    // Its own incarnation only, by uid: a late end never reaches a replacement under the same name.
    if ((await endRunnerJob(deps, identity, holder)) !== 'ended') {
        return {
            ...result,
            ok: false,
            reason: `the reclaim group ${name} could not be confirmed ended, so the checkout claim is kept`,
        };
    }
    return result;
}
