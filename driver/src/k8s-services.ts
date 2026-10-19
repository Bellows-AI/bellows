import type { BoardJob, ServiceStatus } from './board.js';
import { jobPodsPath, podLogPath } from './k8s-auxspec.js';
import { groupsOf, stepHostFor, stepHostOf } from './k8s-group.js';
import { runnerName } from './k8s-podspec.js';
import { HTTP_ERROR_STATUS, livePodOfItems, parse } from './k8s-transport.js';
import type { K8sContainerStatus, K8sDeps, K8sPod } from './k8s-transport.js';
import {
    type DeadService,
    Inconclusive,
    type RunOutcome,
    SERVICE_LOG_TAIL_LINES,
    SERVICE_READY_POLL_MS,
    SERVICE_RESTART_TIMEOUT_MS,
    SERVICE_RESTART_TIMEOUT_S,
} from './runner.js';
import { awaitServicesRunning, ServicesNotRunning, throwIfStoodDown } from './service-restart.js';
import { groupServices, type ServiceSpec } from './services.js';
import { runServiceGenerationStep, type StepHost } from './supervised-steps.js';
import { SERVICE_NOT_ACKED_EXIT, serviceContainerOf } from './supervisor-contract.js';

/**
 * A declared service under kubernetes (issue #773): a native sidecar of the attempt's task pod,
 * specced with the group (`k8s-podspec.ts`) and reached on the pod's loopback by its declared name.
 * Nothing here creates or deletes an object: readiness and death are read off the pod's
 * `initContainerStatuses`, and a restart is the supervisor's bump of the service's generation
 * (`scripts/service-generation-bump.sh`, a `restart` step), which the sidecar's liveness probe
 * turns into a kubelet restart with a fresh writable layer. The services end with the pod.
 */

/** Why the kubelet restarted a sidecar the driver never asked to: the candidates, in the operator's words. */
export const KUBELET_RESTART_NOTE =
    'restarted by the kubelet: it crashed or failed its liveness probe; the image needs sh, cat and a writable /tmp';

/** Waiting reasons a sidecar does not recover from by waiting: the dead one it is. */
const DEAD_WAITING_REASONS: ReadonlySet<string> = new Set([
    'CrashLoopBackOff',
    'ImagePullBackOff',
    'ErrImagePull',
    'InvalidImageName',
    'CreateContainerConfigError',
]);

/** One declared service's sidecar as the pod reports it. */
export interface SidecarStatus extends ServiceStatus {
    state: 'running' | 'exited' | 'pending';
    restartCount: number;
    exitCode: number | null;
    /** The kubelet's words for its last ending: `reason: message`, or null. */
    ending: string | null;
}

/** The kubelet's words for a container's last ending, current or previous. */
function endingOf(status: K8sContainerStatus | undefined): { exitCode: number | null; ending: string | null } {
    const ended = status?.state?.terminated ?? status?.lastState?.terminated;
    const waiting = status?.state?.waiting;
    const words = ended ?? (waiting && DEAD_WAITING_REASONS.has(waiting.reason ?? '') ? waiting : undefined);
    const reason = words?.reason ?? null;
    const message = words?.message ?? null;
    return {
        exitCode: ended?.exitCode ?? null,
        ending: reason && message ? `${reason}: ${message}` : (reason ?? message),
    };
}

/**
 * The declared services' sidecars in one listed pod — pure and exported for the pinning: running,
 * `exited` for one terminated or held on a reason waiting cannot cure, `pending` otherwise (one
 * not yet started, or not yet listed in the pod's status), with its restart count.
 */
export function sidecarStatuses(pod: K8sPod, specs: readonly ServiceSpec[]): SidecarStatus[] {
    return specs.map(({ name, image }) => {
        const status = pod.status?.initContainerStatuses?.find((s) => s.name === serviceContainerOf(name));
        const waiting = status?.state?.waiting?.reason;
        const state = status?.state?.running
            ? 'running'
            : status?.state?.terminated || DEAD_WAITING_REASONS.has(waiting ?? '')
              ? 'exited'
              : 'pending';
        return { name, image, state, restartCount: status?.restartCount ?? 0, ...endingOf(status) };
    });
}

/** The attempt's task pod, as listed now; a list that cannot be read, or lists none, proves nothing. */
async function taskPod(deps: K8sDeps, job: BoardJob): Promise<K8sPod> {
    const listed = await deps
        .request('GET', jobPodsPath(deps.config.k8sNamespace, runnerName(job)))
        .catch((e: Error) => {
            throw new Inconclusive(`the task pod could not be listed: ${e.message}`);
        });
    if (listed.status >= HTTP_ERROR_STATUS) {
        throw new Inconclusive(`the task pod could not be listed (HTTP ${listed.status})`);
    }
    const pod = livePodOfItems(parse<{ items?: K8sPod[] }>(listed.body).items ?? []);
    if (!pod) throw new Inconclusive('the task pod is not listed');
    return pod;
}

/** The attempt's service sidecars as its task pod reports them now; throws `Inconclusive` on a read that proves nothing. */
export async function readSidecars(deps: K8sDeps, job: BoardJob): Promise<SidecarStatus[]> {
    return sidecarStatuses(await taskPod(deps, job), groupServices(deps.config, job));
}

/** The restart counts each attempt's sidecars stood at once the driver last saw them ready (D8): growth past one is a death. */
const baselinesOf = (deps: K8sDeps): Map<string, Map<string, number>> => {
    deps.serviceBaselines ??= new Map();
    return deps.serviceBaselines;
};

const recordBaseline = (deps: K8sDeps, job: BoardJob, statuses: readonly SidecarStatus[]): void => {
    baselinesOf(deps).set(job.leaseToken, new Map(statuses.map(({ name, restartCount }) => [name, restartCount])));
};

/** The attempt's services are the pod's: their release is the end of what the driver remembers of them. */
export function forgetServices(deps: K8sDeps, job: BoardJob): void {
    baselinesOf(deps).delete(job.leaseToken);
}

/**
 * Which of `names` have not acknowledged their current generation, read by the supervisor (a
 * `restart` step in its `acked` mode). A lost supervisor is thrown as it is (`stepLost`); any other
 * answer it cannot give is a read that failed.
 */
async function unacked(host: StepHost, job: BoardJob, names: readonly string[]): Promise<Set<string>> {
    const read = await runServiceGenerationStep(host, job, 'acked', names);
    if (read.exitCode === 0) return new Set();
    if (read.exitCode === SERVICE_NOT_ACKED_EXIT) return new Set(read.stdout.split('\n').filter(Boolean));
    throw new Error(`the services' acknowledgements could not be read: ${(read.stderr || read.stdout).trim()}`);
}

/** The listing a readiness wait polls: running and acknowledged is `running`, running alone still `starting`. */
async function readyListing(
    deps: K8sDeps,
    host: StepHost,
    job: BoardJob,
    last: { statuses: SidecarStatus[] }
): Promise<(ServiceStatus & { reason?: string | null })[]> {
    const statuses = await readSidecars(deps, job);
    last.statuses = statuses;
    const running = statuses.filter(({ state }) => state === 'running').map(({ name }) => name);
    const waiting = running.length === statuses.length ? await unacked(host, job, running) : new Set(running);
    return statuses.map(({ name, image, state, restartCount, ending }) => ({
        name,
        image,
        state: state === 'running' && waiting.has(name) ? 'starting' : state,
        reason: restartCount > 0 ? [ending, KUBELET_RESTART_NOTE].filter(Boolean).join('; ') : ending,
    }));
}

/**
 * The setup step's start of the declared services (`Runner.startServices`): the sidecars came up
 * with the attempt's group — the sync's, or one made now for an attempt that synced none — and this
 * answers `null` once every one runs and has acknowledged its generation, so `environment.setup`
 * never races a sidecar still pulling or booting. A sidecar that dies first throws
 * `ServicesNotRunning`; a pod that could not be read to the end of the budget, `Inconclusive`.
 */
export async function startServiceFleet(
    deps: K8sDeps,
    job: BoardJob,
    signal?: AbortSignal
): Promise<RunOutcome | null> {
    const specs = groupServices(deps.config, job);
    if (specs.length === 0) return null;
    const host = await stepHostFor(deps, job);
    const last = { statuses: [] as SidecarStatus[] };
    await awaitServicesRunning(specs, () => readyListing(deps, host, job, last), deps.sleep, {
        signal,
        after: 'the start',
    });
    recordBaseline(deps, job, last.statuses);
    return null;
}

/** A dead sidecar's last log lines: its previous container's when the kubelet restarted it. */
async function logTailOf(deps: K8sDeps, pod: string, status: SidecarStatus): Promise<string> {
    const path = `${podLogPath(deps.config.k8sNamespace, pod, SERVICE_LOG_TAIL_LINES, serviceContainerOf(status.name))}${
        status.restartCount > 0 ? '&previous=true' : ''
    }`;
    const log = await deps.request('GET', path).catch(() => null);
    return log && log.status < HTTP_ERROR_STATUS ? log.body : '';
}

/**
 * The attempt's dead services (issues #423, #773 D8): a sidecar not running for a reason waiting
 * cannot cure, or one the kubelet restarted since the driver last saw it ready — its restart count
 * past the baseline — with the kubelet's words and its last log lines. A pod that cannot be read
 * throws `Inconclusive`: dead is never inferred from it. A log that cannot be read costs its tail.
 */
export async function deadServices(deps: K8sDeps, job: BoardJob): Promise<DeadService[]> {
    if (groupServices(deps.config, job).length === 0 || !groupsOf(deps).has(job.leaseToken)) return [];
    const pod = await taskPod(deps, job);
    const statuses = sidecarStatuses(pod, groupServices(deps.config, job));
    const baseline = baselinesOf(deps).get(job.leaseToken);
    const out: DeadService[] = [];
    for (const status of statuses) {
        const restarted = status.restartCount > (baseline?.get(status.name) ?? 0);
        if (status.state !== 'exited' && !restarted) continue;
        const reason = restarted ? [status.ending, KUBELET_RESTART_NOTE].filter(Boolean).join('; ') : status.ending;
        out.push({
            name: status.name,
            image: status.image,
            state: status.state === 'exited' ? 'exited' : 'restarted',
            exitCode: status.exitCode,
            reason,
            logTail: await logTailOf(deps, pod.metadata?.name ?? '', status),
        });
    }
    return out;
}

/** One restart's SERVICE_RESTART_TIMEOUT_MS budget: spent by the poll count or the clock, whichever is more. */
interface RestartBudget {
    started: number;
    polls: number;
    signal: AbortSignal;
}

const spentOf = (budget: RestartBudget): number =>
    Math.max(budget.polls * SERVICE_READY_POLL_MS, Date.now() - budget.started);

/** The pace between a restart's reads, counted against its budget. */
async function pace(deps: K8sDeps, budget: RestartBudget): Promise<void> {
    budget.polls += 1;
    await deps.sleep(SERVICE_READY_POLL_MS);
}

/**
 * Bumps every service's generation once each has acknowledged its current one (R2-4), waiting out
 * the bump's refusal meanwhile, and answers the sidecars as they stood at the bump. A pod that
 * cannot be read is read again; one never read to the end of the budget throws `Inconclusive`.
 */
async function bumpWhenAcked(
    deps: K8sDeps,
    job: BoardJob,
    names: readonly string[],
    budget: RestartBudget
): Promise<SidecarStatus[]> {
    const host = stepHostOf(deps);
    for (;;) {
        throwIfStoodDown(budget.signal);
        const counts = await readSidecars(deps, job).catch((e: Error) => {
            if (spentOf(budget) >= SERVICE_RESTART_TIMEOUT_MS) throw e;
            return null;
        });
        const bumped = counts ? await runServiceGenerationStep(host, job, 'bump', names) : null;
        if (counts && bumped?.exitCode === 0) return counts;
        if (bumped && bumped.exitCode !== SERVICE_NOT_ACKED_EXIT) {
            throw new Error(
                `the services' generations could not be bumped: ${(bumped.stderr || bumped.stdout).trim()}`
            );
        }
        if (bumped && spentOf(budget) >= SERVICE_RESTART_TIMEOUT_MS) {
            const unackedNames = bumped.stdout.split('\n').filter(Boolean);
            throw new ServicesNotRunning(
                `service ${unackedNames.map((name) => `"${name}"`).join(', ')} never acknowledged its generation ` +
                    `${SERVICE_RESTART_TIMEOUT_S}s on`
            );
        }
        await pace(deps, budget);
    }
}

/**
 * The pre-gate restart (issues #560, #773 D9): EVERY declared service is restarted, as the fleet it
 * is (R1-4). The bump waits until each has acknowledged its current generation; then each sidecar's
 * restart count must grow past what it was at the bump, and each run and acknowledge the new one —
 * the bump and the waits sharing one SERVICE_RESTART_TIMEOUT_MS budget. One that restarts again
 * after that crashed on its way up. The baselines reset for all of them. A lost supervisor is thrown
 * as it is (`stepLost`), and a pod that could not be read to the end, `Inconclusive`.
 */
export async function restartServiceFleet(deps: K8sDeps, job: BoardJob, signal: AbortSignal): Promise<void> {
    const specs = groupServices(deps.config, job);
    if (specs.length === 0) return;
    const budget: RestartBudget = { started: Date.now(), polls: 0, signal };
    const names = specs.map(({ name }) => name);
    const before = new Map((await bumpWhenAcked(deps, job, names, budget)).map((s) => [s.name, s.restartCount]));
    const host = stepHostOf(deps);
    const last = { statuses: [] as SidecarStatus[] };
    await awaitServicesRunning(
        specs,
        async () =>
            (await readyListing(deps, host, job, last)).map((listed, at) => {
                const now = last.statuses[at]!;
                const was = before.get(now.name) ?? 0;
                // Not yet restarted, or still on its way back: neither is the answer yet.
                if (now.restartCount <= was) return { ...listed, state: 'restarting' };
                if (now.restartCount > was + 1) return { ...listed, state: 'exited' };
                return listed.state === 'exited' ? { ...listed, state: 'restarting' } : listed;
            }),
        deps.sleep,
        { timeoutMs: Math.max(0, SERVICE_RESTART_TIMEOUT_MS - spentOf(budget)), signal }
    );
    recordBaseline(deps, job, last.statuses);
}
