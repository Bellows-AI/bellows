import type { BoardJob } from './board.js';
import { executorImage } from './config.js';
import { ARTIFACT_LIMIT, Inconclusive, reportTail, tailKept } from './runner.js';
import type { Read } from './runner.js';
import { jobPath, jobPodsPath, podLogPath } from './k8s-auxspec.js';
import { anyOf, pollFor } from './poll.js';
import { nonEmpty, stringsOnly } from './k8s-shapes.js';
import { asPod, asStartupPod, validCounters } from './k8s-pod-shapes.js';
import { ledgerOf, RunnerAbandoned, RunnerKilled, vanishedRunner } from './k8s-kill.js';
import { runnerName } from './k8s-podspec.js';
import {
    containerFailure,
    containerStatusOf,
    ERROR_PREVIEW_CHARS,
    HTTP_BAD_REQUEST,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    HTTP_SERVER_ERROR_STATUS,
    boundedBy,
    HTTP_TOO_MANY_REQUESTS,
    isMalformedRequest400,
    isRecord,
    livePodOfItems,
    LOG_TAIL_LINES,
    LOG_READ_MS,
    POLL_MAX_CONSECUTIVE_FAILURES,
    POLL_MS,
    readAnswer,
    refusal,
    waitOf,
    withSignal,
} from './k8s-transport.js';
import type { K8sDeps, K8sJobStatus, K8sPod, K8sResponse } from './k8s-transport.js';
import { heldWords, startupCauseOf, StartupRefused } from './startup-cause.js';
import { type HeldImage, heldOf, heldUnpullable } from './k8s-held.js';
import {
    AGENT_CONTAINER,
    SUPERVISOR_CONTAINER,
    DRIVER_LOST_LOSS,
    SUPERVISOR_EXIT,
    type SupervisorReport,
} from './supervisor-contract.js';

/**
 * The kubernetes executor's job-status polling: reading one Job to a terminal state (bounded by
 * the same retry patience every verdict-carrying read shares), the live-output tail, and the
 * three concrete pollers built on it — the runner's own status poll, and the sync/reclaim aux
 * Jobs'. See docs/kubernetes.md's "Live output here is the pod log" and "The startup sync is
 * ported the same way" for the design this file implements.
 */

/** A Job's status object, read as one of its three states — never both `succeeded` and `failed`. */
export function jobOutcome(status: K8sJobStatus): 'succeeded' | 'failed' | 'pending' {
    if ((status.succeeded ?? 0) >= 1) return 'succeeded';
    if ((status.failed ?? 0) >= 1) return 'failed';
    return 'pending';
}

/**
 * One GET with the same bounded patience the status poll has. Used for the reads that carry the
 * run's verdict once it has finished: the pod list (exit code) and the log (output). An apiserver
 * answering 503 for a moment is not this run's verdict — reporting a failure here would blame the
 * command for the API server's problem and re-run finished work. The same patience covers the
 * API server's own pre-handler `400 Bad Request` (issue #308): a malformed-request answer from
 * Go's `net/http`, transient by nature, retried like a 5xx — a genuine JSON `Status` 400 is an
 * API refusal and returns immediately.
 */
export async function readVerdict(
    deps: K8sDeps,
    path: string,
    what: string,
    ms = POLL_MAX_CONSECUTIVE_FAILURES * POLL_MS
): Promise<K8sResponse> {
    let last: { error: unknown } | { response: K8sResponse } | undefined;
    let failures = 0;
    const answered = await pollFor<K8sResponse>({ ...waitOf(deps, ms), everyMs: POLL_MS }, async (deadline) => {
        try {
            const response = await boundedBy(deps, deadline).request('GET', path);
            if (
                response.status !== HTTP_TOO_MANY_REQUESTS &&
                response.status < HTTP_SERVER_ERROR_STATUS &&
                !isMalformedRequest400(response.status, response.body)
            ) {
                return response;
            }
            last = { response };
        } catch (error) {
            last = { error };
        }
        failures += 1;
    });
    if (answered) return answered;
    if (last && 'error' in last) throw last.error;
    throw new Error(
        `${what} answered ${last?.response.status} ${failures} times in a row: ` +
            `${last?.response.body.slice(0, ERROR_PREVIEW_CHARS)}`
    );
}

/** `readVerdict` for a whole pod log: the time a full transfer needs (`LOG_READ_MS`), not a request's. */
export const readLogVerdict = (deps: K8sDeps, path: string, what: string): Promise<K8sResponse> =>
    readVerdict(deps, path, what, LOG_READ_MS);

/** The answer of a typed read whose object the apiserver confirmed absent (404). */
export const ABSENT = Symbol('absent');

/**
 * A read Job: an identifiable object (`metadata.uid`, which the apiserver always sets and a
 * replacement under the same name never shares) whose `status` is a record too — `{}` for a fresh
 * Job — with valid counts (#869). A Job that cannot say which incarnation it is proves nothing about
 * one: the confirmation, the finish and the retry read it, and none may take it for ours.
 */
export interface ReadJobObject {
    metadata: { uid: string; annotations?: Record<string, string> };
    status: K8sJobStatus;
}

export const asJob = (value: unknown): ReadJobObject | null => {
    if (!isRecord(value) || !isRecord(value.status) || !validCounters(value.status)) return null;
    if (!isRecord(value.metadata) || !nonEmpty(value.metadata.uid)) return null;
    const { annotations } = value.metadata;
    return annotations === undefined || stringsOnly(annotations) ? (value as unknown as ReadJobObject) : null;
};

/** A Job as a verdict read needs it: a record with a `status` record of valid counts; its identity is not asked. */
const asJobStatus = (value: unknown): K8sJobStatus | null =>
    isRecord(value) && isRecord(value.status) && validCounters(value.status) ? (value.status as K8sJobStatus) : null;

/**
 * One GET as a typed read (#869): the value `shape` makes of the body, `absent` on a 404, or
 * `inconclusive` — a transport failure past the verdict reads' retries (`once`: no retry), a
 * non-2xx answer, or a body that is not JSON, not a `Status`, or not the shape asked for. Never
 * `{}` or `null`, and never a throw.
 */
export async function readTyped<T>(
    deps: K8sDeps,
    path: string,
    what: string,
    { shape, once = false }: { shape: (value: unknown) => T | null; once?: boolean }
): Promise<Read<T>> {
    let response: K8sResponse;
    try {
        response = once ? await deps.request('GET', path) : await readVerdict(deps, path, what);
    } catch (e) {
        return { kind: 'inconclusive', reason: `${what}: ${(e as Error).message}` };
    }
    return readAnswer(response, what, shape);
}

/** The list shape: every entry `entry` accepts, or null for a body with no list or any entry it refuses. */
const listOf =
    <T>(entry: (value: unknown) => T | null) =>
    (body: unknown): T[] | null => {
        if (!isRecord(body) || !Array.isArray(body.items)) return null;
        const items = body.items.map(entry);
        return items.every((item) => item !== null) ? (items as T[]) : null;
    };

/** `readTyped` of a list: every entry `entry` accepts, or inconclusive for a body with no list or any entry it refuses. */
export function readTypedList<T>(
    deps: K8sDeps,
    path: string,
    what: string,
    { entry, once = false }: { entry: (value: unknown) => T | null; once?: boolean }
): Promise<Read<T[]>> {
    return readTyped(deps, path, what, { shape: listOf(entry), once });
}

/** A pod list already fetched, read as a typed answer (#869): the pods `entry` accepts, else absent or inconclusive. */
export const podsOf = (response: K8sResponse, what: string, entry: (value: unknown) => K8sPod | null = asPod) =>
    readAnswer(response, what, listOf(entry));

/** `readTyped` on the throwing channel (#824): `ABSENT` on a 404, an `Inconclusive` throw for a read that proves nothing. */
export async function readObject<T>(
    deps: K8sDeps,
    path: string,
    what: string,
    options: { shape: (value: unknown) => T | null; once?: boolean }
): Promise<T | typeof ABSENT> {
    const read = await readTyped(deps, path, what, options);
    if (read.kind === 'inconclusive') throw new Inconclusive(read.reason);
    return read.kind === 'absent' ? ABSENT : read.value;
}

/** `readObject` of a list. */
export async function readList<T>(
    deps: K8sDeps,
    path: string,
    what: string,
    options: { entry: (value: unknown) => T | null; once?: boolean }
): Promise<T[] | typeof ABSENT> {
    const read = await readTypedList(deps, path, what, options);
    if (read.kind === 'inconclusive') throw new Inconclusive(read.reason);
    return read.kind === 'absent' ? ABSENT : read.value;
}

/**
 * Whether a terminal Job's own conditions show the kubelet's `activeDeadlineSeconds` fired. A
 * current cluster (observed on v1.37) first marks it `FailureTarget` — already counting the pod
 * failed, the pod still terminating — and adds `Failed` only once the pod is gone. The poll reads
 * the first terminal status it sees, so both spellings are the deadline; knowing only `Failed`
 * reported a gate that ran long as "exit 1, empty output".
 */
export function timedOutOf(status: K8sJobStatus): boolean {
    return (status.conditions ?? []).some(
        (condition) =>
            (condition.type === 'Failed' || condition.type === 'FailureTarget') &&
            condition.reason === 'DeadlineExceeded'
    );
}

/**
 * The one reading of "can this Job's image be pulled at all?", shared by every Job poll (issue
 * #302; the gate's `checkGateImagePullable`, generalized): a container blocked on its image names
 * the kubelet's reason and message, so the poll can fail right away instead of burning the
 * deadline and reporting a timeout or an unreadable verdict over what is really "no such image".
 * A container that is running or terminated has answered the image question. One that is still
 * waiting — `ContainerCreating` covers the whole first pull — has not: the pull can still fail
 * after this tick, so the watch keeps reading the pod list. A pod-list blink or a pod with no
 * container status yet answers "nothing seen" — the caller keeps polling.
 *
 * Beside it, for the group start (#824 D11): `waiting`, the first container held by a reason the
 * pod never recovers from on its own — the pull reasons, an invalid image name, a container config
 * the kubelet refuses — and `podState`, what the last list proves about the start: `unread` (no
 * answer, no evidence), `none` (no pod yet), `starting` (no container running or ended) or `started`.
 */
export async function readImagePullStatus(deps: K8sDeps, jobName: string): Promise<ImagePullStatus> {
    const pods = await deps
        .request('GET', jobPodsPath(deps.config.k8sNamespace, jobName))
        .catch(() => ({ status: 0, body: '' }));
    const read = podsOf(pods, `listing the pods of ${jobName}`, asStartupPod);
    const items = read.kind === 'value' ? read.value : null;
    // Every container of the pod, not the first: the runner pod holds the agent, the supervisor and
    // the exporter, and any one of them blocked on its image holds the whole run. The init list is
    // read first (#773 D10): a sidecar held on its image keeps every main container initializing.
    const pod = items === null ? undefined : livePodOfItems(items);
    const status = pod?.status;
    const containers = status?.containerStatuses ?? [];
    const holder = [...(status?.initContainerStatuses ?? []), ...containers].find((c) =>
        STUCK_REASONS.has(c.state?.waiting?.reason ?? '')
    );
    const waiting = holder?.state?.waiting;
    const held = heldOf(holder, pod);
    const startedAny = containers.some((c) => c.state?.terminated !== undefined || c.state?.running !== undefined);
    const agentStarted = containers.some(
        (c) => c.name === AGENT_CONTAINER && (c.state?.terminated !== undefined || c.state?.running !== undefined)
    );
    const agentEnded = containers.some((c) => c.name === AGENT_CONTAINER && c.state?.terminated !== undefined);
    const podState: PodStartState =
        items === null ? 'unread' : !livePodOfItems(items) ? 'none' : startedAny ? 'started' : 'starting';
    const disrupted = isDisrupted(pod);
    const stuck = waiting?.reason ? { reason: waiting.reason, message: waiting.message ?? '' } : null;
    if (stuck && PULL_REASONS.has(stuck.reason)) {
        return {
            blocked: pullDetail(stuck),
            containerSeen: true,
            waiting: stuck,
            held,
            podState,
            agentStarted,
            agentEnded,
            volumeAffinity: null,
            disrupted,
        };
    }
    const containerSeen =
        containers.length > 0 &&
        containers.every((c) => c.state?.terminated !== undefined || c.state?.running !== undefined);
    return {
        blocked: null,
        containerSeen,
        waiting: stuck,
        held,
        podState,
        agentStarted,
        agentEnded,
        volumeAffinity: volumeAffinityOf(pod),
        disrupted,
    };
}

/** The control plane marked the pod a disruption target, or the kubelet evicted it: it is being taken away. */
const isDisrupted = (pod: K8sPod | undefined): boolean =>
    pod !== undefined &&
    (pod.status?.reason === 'Evicted' ||
        (pod.status?.conditions ?? []).some((c) => c.type === 'DisruptionTarget' && c.status === 'True'));

export type PodStartState = 'unread' | 'none' | 'starting' | 'started';

export interface ImagePullStatus {
    blocked: string | null;
    containerSeen: boolean;
    waiting: { reason: string; message: string } | null;
    /** The container `waiting` holds, with the image its status names (#773 D10); null when none is held. */
    held: HeldImage | null;
    podState: PodStartState;
    /** The agent container is running or ended: once released, the run has happened. */
    agentStarted: boolean;
    /** The pod list was read and the agent container's state is `terminated` (#920): the one proof it is over. */
    agentEnded: boolean;
    /** The scheduler's words when the pod is held Pending by its volume's node affinity (#775); else null. */
    volumeAffinity: string | null;
    /** The control plane marked the pod a disruption target, or the kubelet evicted it: it is being taken away. */
    disrupted: boolean;
}

const NODES_AVAILABLE = /^0\/(\d+) nodes are available:([^.]*)/;
const AFFINITY_COUNT = /(?:^|[\s,])(\d+) node\(s\) had volume node affinity conflict/;

/**
 * The scheduler's words for a pod EVERY node refused because of where its volume lives, else null: the
 * volume is faulted only when the affinity count equals the node count. A mixed message ("2 Insufficient
 * cpu, 3 node(s) had volume node affinity conflict") or one that does not parse proves a healthy volume
 * and is an ordinary transient wait.
 */
const volumeAffinityOf = (
    pod: { status?: { conditions?: { type?: string; status?: string; message?: string }[] } } | undefined
) => {
    const message = pod?.status?.conditions?.find((c) => c.type === 'PodScheduled' && c.status === 'False')?.message;
    const available = message ? NODES_AVAILABLE.exec(message) : null;
    const conflicts = available ? AFFINITY_COUNT.exec(available[2] ?? '') : null;
    return available && conflicts && Number(available[1]) > 0 && conflicts[1] === available[1]
        ? (message ?? null)
        : null;
};

const PULL_REASONS: ReadonlySet<string> = new Set(['ImagePullBackOff', 'ErrImagePull']);
const STUCK_REASONS: ReadonlySet<string> = new Set([...PULL_REASONS, 'InvalidImageName', 'CreateContainerConfigError']);

const pullDetail = (waiting: { reason: string; message: string }): string =>
    waiting.reason + (waiting.message ? ` — ${waiting.message.slice(0, ERROR_PREVIEW_CHARS)}` : '');

/**
 * What a group pod's held container proves about its start (#824 D11): a refusal typed by the cause
 * the kubelet's reason and words prove, a refusal whose words prove none (a plain `Error`, left to
 * the lease), or null — nothing held, or a back-off that names no cause of its own while the caller
 * can still read on for the pull failure that does (`waitOutBackOff`).
 */
export function startRefusalOf(image: string, pull: ImagePullStatus, waitOutBackOff: boolean): Error | null {
    const { waiting } = pull;
    if (!waiting) return null;
    const held = pull.held ?? { role: 'executor' };
    const message =
        waiting.reason === 'CreateContainerConfigError'
            ? `the ${heldWords(held)} container cannot start: ${pullDetail(waiting)}`
            : heldUnpullable(image, pull, pullDetail(waiting));
    const cause = startupCauseOf({ waitingReason: waiting.reason, message: waiting.message });
    if (cause) return new StartupRefused(message, cause, held);
    if (waitOutBackOff && waiting.reason === 'ImagePullBackOff') return null;
    return new Error(message);
}

/**
 * One verdict-carrying read of a Job's status, translated to the four shapes every caller below
 * branches on: gone, an unexpected status, still running, or a terminal outcome. `readVerdict`
 * owns the transport/429/5xx/malformed-400 retry bound and THROWS once it is exhausted — every
 * caller propagates that (`pollRunnerJobUntilTerminal`, the gate poll), wrapping it in its own shape when it needs to.
 */
export type JobStatusResult =
    | { kind: 'notFound' }
    | { kind: 'error'; status: number; body: string }
    | { kind: 'pending' }
    | { kind: 'terminal'; outcome: 'succeeded' | 'failed'; status: K8sJobStatus };

export async function readJobStatus(deps: K8sDeps, jobName: string, what: string): Promise<JobStatusResult> {
    const response = await readVerdict(deps, jobPath(deps.config.k8sNamespace, jobName), what);
    if (response.status === HTTP_NOT_FOUND) return { kind: 'notFound' };
    if (response.status >= HTTP_ERROR_STATUS) return { kind: 'error', status: response.status, body: response.body };
    const read = readAnswer(response, what, asJobStatus);
    if (read.kind !== 'value') throw new Inconclusive(read.kind === 'inconclusive' ? read.reason : `${what}: absent`);
    const status = read.value;
    const outcome = jobOutcome(status);
    return outcome === 'pending' ? { kind: 'pending' } : { kind: 'terminal', outcome, status };
}

/**
 * The pod carries the exit code; the Job object does not. Found by the label the Job controller
 * stamps on every pod it owns, not by guessing the generated name — the same discovery every
 * verdict read below shares, with the same bounded patience `readVerdict` gives every other
 * verdict-carrying read. When the Job succeeded but its pod is already gone (garbage-collected
 * before the list), the Job status IS the exit code: this Job runs one pod and never retries it,
 * so a success can only have counted an exit-0 termination. A re-claim's replaced attempt's pod
 * can still be listed while it terminates, carrying the same job-name label — skipped, so the
 * exit code and the log are always this run's. The log read has no retry at all: the pod may be
 * gone for good, and the answer is already known to be "whatever we can get". `tail` is the line
 * tail the log is read at (null: the whole log); `truncated` says the transport kept only its end.
 * `strict` (an adoption's read, #824) takes nothing unconfirmed for "no pod" or "no output": a pod
 * list that is not one, or a log that failed past the retries, throws `Inconclusive`.
 */
export async function readJobPodVerdict(
    deps: K8sDeps,
    jobName: string,
    {
        succeeded,
        container,
        tail = LOG_TAIL_LINES,
        strict = false,
    }: { succeeded: boolean; container?: string; tail?: number | null; strict?: boolean },
    what: string
): Promise<{ exitCode: number | null; output: string; truncated: boolean; pods: K8sPod[] }> {
    const podsPath = jobPodsPath(deps.config.k8sNamespace, jobName);
    const listed = await readList(deps, podsPath, what, { entry: asPod });
    const pods = listed === ABSENT ? [] : listed;
    const pod = strict ? runnerPodOf(pods) : livePodOfItems(pods);
    // `container` names the one whose verdict this is when the pod holds several (the runner pod's
    // agent); an aux pod's only container is read by position, as ever.
    const exitCode = containerStatusOf(pod, container)?.state?.terminated?.exitCode ?? (succeeded ? 0 : null);
    let output = '';
    let truncated = false;
    if (pod?.metadata?.name && strict) {
        const log = await readPodLog(deps, podLogPath(deps.config.k8sNamespace, pod.metadata.name, tail, container));
        output = log.body;
        truncated = log.truncated === true;
    } else if (pod?.metadata?.name) {
        let log: K8sResponse | undefined;
        try {
            log = await deps.request(
                'GET',
                podLogPath(deps.config.k8sNamespace, pod.metadata.name, tail, container),
                undefined,
                { timeoutMs: LOG_READ_MS }
            );
        } catch {
            // Incomplete below: the transfer failed, which is not an empty log.
        }
        if (log && log.status < HTTP_ERROR_STATUS) {
            output = log.body;
            truncated = log.truncated === true;
        } else {
            // A log that failed to transfer is incomplete, never empty and whole; only a pod the
            // apiserver says is gone, or a container it says never started, has no output to lose.
            truncated = !(log && logIsNone(log));
        }
    }
    return { exitCode, output, truncated, pods };
}

/** A pod log refusal that says its container never started, in the kubelet's own words — never any 400. */
export const neverStartedLog = (body: string): boolean => /is waiting to start|is not available/i.test(body);

/** A log answer that says there is none to read: the pod is gone (404) or its container never started. */
export const logIsNone = (log: K8sResponse): boolean =>
    log.status === HTTP_NOT_FOUND || (log.status === HTTP_BAD_REQUEST && neverStartedLog(log.body));

/**
 * The runner's own pod, as an adoption reads it (#824): the live one, else the one being deleted —
 * its Job runs one pod, so the listed pod is the run's whatever its deletion, and a node drained
 * after (or while) its supervisor finalized leaves that pod's report and log to read.
 */
export function runnerPodOf(pods: K8sPod[]): K8sPod | undefined {
    return livePodOfItems(pods) ?? pods[0];
}

/**
 * A pod log as a confirmed read: the log, or an empty one for a pod the apiserver says is gone (404)
 * or a container it says never started (`neverStartedLog`). Anything else past the verdict reads'
 * retries throws `Inconclusive`.
 */
async function readPodLog(deps: K8sDeps, path: string): Promise<K8sResponse> {
    const what = 'reading the runner pod log';
    let log: K8sResponse;
    try {
        log = await readLogVerdict(deps, path, what);
    } catch (e) {
        throw new Inconclusive(`${what}: ${(e as Error).message}`);
    }
    if (logIsNone(log)) {
        return { status: log.status, body: '' };
    }
    if (log.status >= HTTP_ERROR_STATUS) throw new Inconclusive(`${what} answered ${log.status}`);
    return log;
}

/**
 * Why a runner Job that failed inside its deadline was taken away rather than ended by its agent
 * (issue #560), or null when its pod says the agent ended it: no live pod left (deleted, drained,
 * its node removed), or one the kubelet evicted or the control plane marked a disruption target.
 */
export function runnerLossOf(pods: readonly K8sPod[]): string | null {
    const live = livePodOfItems([...pods]);
    const pod = live ?? pods[0];
    const disruption = pod?.status?.conditions?.find((c) => c.type === 'DisruptionTarget' && c.status === 'True');
    const evicted = pod?.status?.reason === 'Evicted';
    const said = disruption
        ? [disruption.reason, disruption.message]
        : evicted
          ? [pod?.status?.reason, pod?.status?.message]
          : [];
    const detail = said.filter(Boolean).join(': ');
    if (live && !disruption && !evicted) return null;
    const what = live
        ? 'the runner pod was taken away before it exited'
        : 'the runner pod was deleted before it exited';
    return `${what} (${detail || 'evicted, drained or its node removed'})`;
}

/**
 * The mid-run live output tail, best effort: discovers the runner's pod once and remembers it,
 * then reads its log tail on every poll that has one — every failure here (not scheduled yet, a
 * 503, a dropped connection) costs freshness, never the run.
 */
async function tailRunnerOutput(
    deps: K8sDeps,
    job: BoardJob,
    podName: string | null,
    onOutput: (tail: string) => void
): Promise<string | null> {
    let resolvedPodName = podName;
    if (resolvedPodName === null) {
        try {
            const pods = await deps.request('GET', jobPodsPath(deps.config.k8sNamespace, runnerName(job)));
            // Skipping terminating pods for the same reason the final read does: a replaced
            // attempt's pod carries the same label, and its log is not this run's output.
            const read = podsOf(pods, 'listing the runner pods');
            resolvedPodName = (read.kind === 'value' && livePodOfItems(read.value)?.metadata?.name) || null;
        } catch {
            // Not scheduled yet, or the API server blinked. The next poll looks again.
        }
    }
    if (resolvedPodName !== null) {
        try {
            const log = await deps.request(
                'GET',
                podLogPath(deps.config.k8sNamespace, resolvedPodName, undefined, AGENT_CONTAINER)
            );
            if (log.status < HTTP_ERROR_STATUS) onOutput(reportTail(log.body));
        } catch {
            // The log endpoint hiccups on a pod that is only starting. Freshness waits a poll.
        }
    }
    return resolvedPodName;
}

/**
 * The runner Job's status — unless this driver killed it: the kill ends the run at once, whatever
 * the Job still reads, since a kill whose teardown could not be confirmed (issue #821) leaves the
 * Job suspended, listed and reporting nothing.
 */
function readUnlessKilled(deps: K8sDeps, job: BoardJob): Promise<JobStatusResult> {
    if (ledgerOf(deps).was(job).hard) return Promise.reject(new RunnerKilled(runnerName(job)));
    return readJobStatus(deps, runnerName(job), 'reading the runner job');
}

/**
 * Poll until the runner Job reports a terminal status. The kubelet-enforced activeDeadlineSeconds
 * is what guarantees the JOB eventually reaches one — the same bound that kills the docker
 * runner's container guarantees this an exit. It does not guarantee this driver can keep READING
 * it, so 429s, 5xx and transport failures are retried a bounded number of times rather than
 * treated as the run's verdict. While the Job is still pending, the poll also watches for an
 * executor image the node cannot pull (issue #302) and fails the run naming it, instead of
 * burning the deadline and reporting a timeout over what is really "no such image".
 */
async function runStartSeen(
    deps: K8sDeps,
    job: BoardJob,
    image: string
): Promise<{ seen: boolean; agentEnded: boolean }> {
    // A held container is the run's start refused (#824 D11): typed when its words prove a cause,
    // plain (the lease) otherwise — with no bound here but the Job's deadline, a back-off that names
    // no cause is no reason to wait. A released agent that is running or ended has run: a container
    // held beside it (an exporter whose Secret went away) is no refused start of the run.
    const pull = await readImagePullStatus(deps, runnerName(job));
    const refused = pull.agentStarted ? null : startRefusalOf(image, pull, false);
    if (refused) throw refused;
    return { seen: pull.containerSeen || pull.agentStarted, agentEnded: pull.agentEnded };
}

/** One pod read of the poll: the start seen, and the agent container's end told once (#920). */
async function watchStart(
    deps: K8sDeps,
    job: BoardJob,
    image: string,
    seen: { container: boolean; told: boolean; agentEnded: (() => void) | undefined }
): Promise<void> {
    const start = await runStartSeen(deps, job, image);
    seen.container = start.seen;
    if (start.agentEnded && seen.agentEnded) {
        seen.agentEnded();
        seen.told = true;
    }
}

export async function pollRunnerJobUntilTerminal(
    deps: K8sDeps,
    job: BoardJob,
    watch: {
        onOutput?: ((tail: string) => void) | undefined;
        /** True once the task supervisor reported the agent over and its exporter drained: the group outlives it. */
        over?: (() => boolean) | undefined;
        /** Called once the pod list proves the agent container terminated before the supervisor reported (#920). */
        agentEnded?: (() => void) | undefined;
        podName?: string | null;
    } = {}
): Promise<{ timedOut: boolean; jobSucceeded: boolean }> {
    const { onOutput, over, agentEnded } = watch;
    const podName = watch.podName ?? null;
    const image = executorImage(deps.config, job.executorType);
    const seen = { container: false, told: false, agentEnded };
    let pod = podName;
    const terminal = { timedOut: false, jobSucceeded: false };
    // No bound of its own, on purpose: the kubelet's activeDeadlineSeconds and the run deadline
    // (run-deadline.ts, whose kill aborts the ledger signal) bound it.
    // Every request and pause of the poll ends on the kill, not at the next poll.
    // An abandoned attempt (#829) ends the poll too: the group is the next holder's, not this loop's to read.
    const live = withSignal(deps, anyOf(ledgerOf(deps).signal(job), ledgerOf(deps).abandoned(job)));
    const polled = await pollFor<{ timedOut: boolean; jobSucceeded: boolean }>(
        {
            ...waitOf(live, Infinity),
            everyMs: POLL_MS,
            abandoned: () =>
                ledgerOf(deps).was(job).stopped
                    ? new RunnerKilled(runnerName(job))
                    : new RunnerAbandoned(runnerName(job)),
        },
        async () => {
            const result = await readUnlessKilled(live, job);
            if (result.kind === 'notFound') {
                // Gone without this driver deleting it — fenced away or removed by hand. Its verdict can
                // never arrive, so waiting longer is holding a slot for nothing.
                throw vanishedRunner(deps, job);
            }
            if (result.kind === 'error') throw new Error(refusal(result, 'reading the runner job')!);
            if (result.kind === 'terminal') {
                return { timedOut: timedOutOf(result.status), jobSucceeded: result.outcome === 'succeeded' };
            }
            // The task group outlives the agent: its supervisor's report — the agent is over and the
            // exporter drained — is the end of the run, with the Job still serving the attempt's steps.
            if (over?.()) return terminal;
            if (!seen.container || (agentEnded && !seen.told)) await watchStart(live, job, image, seen);
            if (onOutput) pod = await tailRunnerOutput(live, job, pod, onOutput);
        }
    );
    return polled!;
}

/**
 * The pod carries the exit code; the Job object does not. Found by the label the Job controller
 * stamps on every pod it owns, not by guessing the generated name. When the Job succeeded but its
 * pod is already gone — garbage-collected before the list — the Job status IS the exit code: this
 * Job runs one pod and never retries it, so a success can only have counted an exit-0 termination.
 */
export async function readRunnerVerdict(
    deps: K8sDeps,
    job: BoardJob,
    jobSucceeded: boolean,
    {
        report = null,
        strict = false,
    }: { report?: Pick<SupervisorReport, 'agentExit' | 'outcome'> | null; strict?: boolean } = {}
): Promise<{
    exitCode: number | null;
    output: string;
    fullLog: string;
    logTruncated: boolean;
    /** The runner pod was taken away under the run (`runnerLossOf`). */
    vanished: string | null;
    /** The supervisor ended any way but finalizing (`supervisorLossOf`). */
    unfinalized: string | null;
    /** The supervisor ended the agent at the run budget (its exit 124): the run timed out. */
    supervisorDeadline: boolean;
}> {
    // The agent's verdict: its exit status and its log — the pod holds the supervisor and the
    // exporter beside it, whose own output is no part of the run's.
    // The whole log, never a line tail (issue #825): it is the artifact, and a tail would upload
    // as complete.
    const verdict = await readJobPodVerdict(
        deps,
        runnerName(job),
        { succeeded: jobSucceeded, container: AGENT_CONTAINER, tail: null, strict },
        'listing the runner pods'
    );
    // The tail for the verdict's output field, and the full log (issue #325) tail-kept at the
    // artifact cap for the loop's upload — both cut from the one pod log this read exists for,
    // truncated when either the cap or the transport cut it.
    const full = tailKept(verdict.output, ARTIFACT_LIMIT);
    const pod = strict ? runnerPodOf(verdict.pods) : livePodOfItems(verdict.pods);
    const supervisorExit = containerStatusOf(pod, SUPERVISOR_CONTAINER)?.state?.terminated?.exitCode;
    return {
        // The supervisor's report carries the agent's own exit when the kubelet's status has not caught up
        // with a pod that is still running its supervisor (the group outlives the agent).
        exitCode: verdict.exitCode ?? report?.agentExit ?? null,
        output: reportTail(verdict.output),
        fullLog: full.content,
        logTruncated: full.truncated || verdict.truncated,
        // What the run's end amounts to is `infraLossOf`'s to decide, over both executors.
        vanished: jobSucceeded ? null : runnerLossOf(verdict.pods),
        unfinalized: jobSucceeded ? null : supervisorLossOf(pod, supervisorExit),
        // The budget ended the agent: the supervisor's report says so while it still serves, and its
        // exit 124 says so once the group is over.
        supervisorDeadline: supervisorExit === SUPERVISOR_EXIT.deadline || report?.outcome === 'timed_out',
    };
}

/**
 * Why a run whose pod survived to the end was still lost: its task supervisor ended any way but
 * finalizing (an exit other than 0 and its deadline's 124 — a crash, an OOM kill, its own failure
 * 70), so nothing finalized the attempt, and the agent's exit code is no verdict on the work. The
 * attempt is interrupted — the next claim adopts the session and the checkout — never failed.
 * Null when the supervisor finalized, or left no status to read.
 */
export function supervisorLossOf(pod: K8sPod | undefined, supervisorExit: number | undefined): string | null {
    if (supervisorExit === undefined || supervisorExit === 0 || supervisorExit === SUPERVISOR_EXIT.deadline)
        return null;
    if (supervisorExit === SUPERVISOR_EXIT.lost) return DRIVER_LOST_LOSS;
    const detail = containerFailure(pod, SUPERVISOR_CONTAINER) ?? `exit ${supervisorExit}`;
    return `the task supervisor ended before it finalized the run (${detail})`;
}
