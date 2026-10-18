import { randomUUID } from 'node:crypto';
import type { BoardJob } from './board.js';
import { executorImage, type DriverConfig } from './config.js';
import { clearKilled } from './k8s-kill.js';
import { deleteJob, deleteSecret } from './k8s-auxspec.js';
import { launch, prepare, releaseClaim, type RunCleanup } from './k8s-fence.js';
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
import { toolTreeReleaseScript, worktreeDir } from './publish.js';
import { readImagePullStatus, readJobStatus, unpullableImage } from './k8s-poll.js';
import { expectOk, POLL_MS } from './k8s-transport.js';
import type { K8sDeps } from './k8s-transport.js';
import type { ReclaimResult } from './publish.js';
import type { RunSession } from './runner.js';
import { noStepChannel } from './step-control.js';
import { type StepHost, orderFinish, runReclaimStep } from './supervised-steps.js';
import { SUPERVISOR_ENV } from './supervisor-contract.js';
import { secretsPath } from './k8s-auxspec.js';

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
}

/** How long a created group may take to show its supervisor — an image pull, a node scaling up. */
const GROUP_UP_WAIT_MS = 600_000;
/** How long `finish` waits for the group's Job to end by itself before it deletes it. */
const GROUP_END_WAIT_MS = 20_000;

/**
 * The group of a thread with no attempt, which a terminal reclaim has to run in: a supervisor and
 * nothing else — no agent, no exporter, no member env — under a name of its own, so it can never
 * answer to the attempt group's. The reclaim is a supervised step like every other; only the group
 * differs. Its deadline is the reclaim's own plus the wind-down, not a run's.
 */
export const reclaimGroupName = (job: BoardJob): string => `factory-reclaim-${hash16(`${job.id}|${job.leaseToken}`)}`;

/** The bound of a reclaim group: its one step's deadline, and the time to finalize. */
const RECLAIM_GROUP_SECONDS = 1200;

export function reclaimGroupSpec(config: DriverConfig, job: BoardJob): RunnerJobSpec {
    const spec = runnerJobSpec(config, { ...job, agent: false }, null);
    const worktree = worktreeDir(config, job);
    const pod = spec.spec.template.spec;
    return {
        ...spec,
        metadata: { ...spec.metadata, name: reclaimGroupName(job) },
        spec: {
            ...spec.spec,
            activeDeadlineSeconds: RECLAIM_GROUP_SECONDS,
            template: {
                ...spec.spec.template,
                spec: { ...pod, ...(worktree ? { initContainers: [releaseContainer(config, job, worktree)] } : {}) },
            },
        },
    };
}

/**
 * The tool uid's release of the tree (issue #814), before the supervisor starts and so before the
 * reclaim step: a directory a tool closed with an explicit mode is one the uid-1000 reclaim cannot
 * empty. Hardened like every container, as the tool uid, the tree's path its only input; it exits 0
 * whatever it found, and the reclaim's own verdict decides.
 */
function releaseContainer(config: DriverConfig, job: BoardJob, worktree: string): RunnerPodContainer {
    const hardened = containerHardeningField().securityContext;
    return {
        name: 'release',
        image: executorImage(config, job.executorType),
        imagePullPolicy: config.imagePullPolicy,
        securityContext: { ...hardened, runAsUser: TOOL_UID, runAsGroup: GATE_GID },
        command: ['node', '-e', toolTreeReleaseScript],
        env: [{ name: 'WORKTREE', value: worktree }],
        volumeMounts: [workspaceMount(config, workspacePath(job))],
    };
}

/** The attempt groups this runner created, by lease token: one per attempt, never shared. */
export const groupsOf = (deps: K8sDeps): Map<string, TaskGroup> => {
    deps.groups ??= new Map();
    return deps.groups;
};

/** The step channel this runner submits through; with none wired, every step is refused with the reason. */
export const stepHostOf = (deps: K8sDeps): StepHost => ({ config: deps.config, sink: deps.steps ?? noStepChannel });

/**
 * Waits until the group's supervisor has pulled from the driver at least once, failing at once on
 * an executor image the node cannot pull (issue #302) and past `GROUP_UP_WAIT_MS` on anything else.
 */
async function awaitSupervisor(deps: K8sDeps, job: BoardJob, jobName: string): Promise<void> {
    const sink = stepHostOf(deps).sink;
    const token = job.supervisorEnv?.[SUPERVISOR_ENV.controlToken];
    if (!token) return;
    const polls = Math.ceil(GROUP_UP_WAIT_MS / POLL_MS);
    for (let poll = 0; poll < polls; poll += 1) {
        if (sink.contacted(token)) return;
        const pull = await readImagePullStatus(deps, jobName);
        if (pull.blocked) {
            throw new Error(unpullableImage('executor', executorImage(deps.config, job.executorType), pull.blocked));
        }
        await deps.sleep(POLL_MS);
    }
    throw new Error(`the task supervisor of ${jobName} never came up within ${GROUP_UP_WAIT_MS}ms`);
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
    cleanup: RunCleanup
): Promise<TaskGroup> {
    const known = groupsOf(deps).get(job.leaseToken);
    if (known) {
        if (known.session?.id !== session?.id || known.session?.resume !== session?.resume) {
            throw new Error(`the task group of job ${job.id} was specced for another session than the run's`);
        }
        return known;
    }
    clearKilled(runnerName(job));
    await prepare(deps, job, cleanup);
    const startedAt = new Date().toISOString();
    await launch(deps, job, runnerJobSpec(deps.config, job, session, startedAt), cleanup);
    const group: TaskGroup = { startedAt, session };
    groupsOf(deps).set(job.leaseToken, group);
    await awaitSupervisor(deps, job, runnerName(job));
    return group;
}

/**
 * The step host of an attempt whose first step is not its sync — an adopted run, whose agent
 * already ended under an earlier claim: a group is created for it on demand, a supervisor and no
 * agent, because the gates' probe, the helpers and the publish are still its steps. A group the
 * sync already created is simply answered.
 */
export async function stepHostFor(deps: K8sDeps, job: BoardJob): Promise<StepHost> {
    if (!groupsOf(deps).has(job.leaseToken)) {
        const cleanup: RunCleanup = { holdClaim: false };
        await ensureGroup(deps, { ...job, agent: false }, null, cleanup);
        // No run follows to give the checkout back.
        if (!cleanup.holdClaim) await releaseClaim(deps, job);
    }
    return stepHostOf(deps);
}

/** Deletes the attempt's group and its Secret now, awaited: the checkout is not handed over until nothing of it can write. */
export async function takeGroupDown(deps: K8sDeps, job: BoardJob): Promise<void> {
    groupsOf(deps).delete(job.leaseToken);
    await deleteJob(deps, runnerName(job), 'Foreground');
    await deleteSecret(deps, secretName(job));
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
 * ends with it. A group that does not end in the bound is deleted. Idempotent, and a no-op for an
 * attempt that never created one (or whose group a kill already took away). Never throws.
 */
export async function finishGroup(deps: K8sDeps, job: BoardJob): Promise<void> {
    if (!groupsOf(deps).delete(job.leaseToken)) return;
    await orderFinish(stepHostOf(deps), job).catch(() => undefined);
    if (!(await jobEndsWithin(deps, runnerName(job), GROUP_END_WAIT_MS))) {
        await deleteJob(deps, runnerName(job), 'Foreground');
    }
    await deleteSecret(deps, secretName(job));
}

/**
 * The terminal reclaim, in a supervisor-only group: the thread has no attempt, so there is no
 * group to ask. The group is a supervisor and nothing else — no agent, no exporter, no member env
 * — under a lease of its own, so nothing of the thread's attempts answers to it. The caller holds
 * the checkout claim for the whole call. A group that cannot come up is a refusal, never a throw.
 */
export async function reclaimInGroup(deps: K8sDeps, job: BoardJob): Promise<ReclaimResult> {
    if (!deps.endpoint) {
        return {
            ok: false,
            removed: false,
            reason: 'this driver has no supervisor endpoint to run the reclaim through',
        };
    }
    const opened = await deps.endpoint.open();
    const group: BoardJob = {
        ...job,
        leaseToken: randomUUID(),
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: opened.url, [SUPERVISOR_ENV.controlToken]: opened.token },
    };
    const name = reclaimGroupName(group);
    try {
        const secret = await deps.request(
            'POST',
            secretsPath(deps.config.k8sNamespace),
            secretBody(group, secretName(group), group.supervisorEnv ?? {})
        );
        expectOk(secret, 'creating the reclaim group secret');
        const created = await deps.request(
            'POST',
            jobsPath(deps.config.k8sNamespace),
            reclaimGroupSpec(deps.config, group)
        );
        expectOk(created, 'creating the reclaim group');
        await awaitSupervisor(deps, group, name);
        return await runReclaimStep(stepHostOf(deps), group);
    } catch (e) {
        return { ok: false, removed: false, reason: `the worktree reclaim group failed: ${(e as Error).message}` };
    } finally {
        await orderFinish(stepHostOf(deps), group).catch(() => undefined);
        deps.endpoint.close(opened.token);
        // Foreground, awaited: the claim is handed back only once nothing of this group can write the tree.
        await deleteJob(deps, name, 'Foreground');
        await deleteSecret(deps, secretName(group));
    }
}
