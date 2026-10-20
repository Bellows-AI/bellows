import type { BoardJob } from './board.js';
import { executorImage } from './config.js';
import { ARTIFACT_LIMIT, Inconclusive, reportTail, tailKept } from './runner.js';
import type { Read } from './runner.js';
import { jobPath, jobPodsPath, podLogPath } from './k8s-auxspec.js';
import {
    isCount,
    nonEmpty,
    optionalStrings,
    optionalTimestamp,
    stringsOnly,
    validContainerStatuses,
    validPodConditions,
} from './k8s-shapes.js';
import { ledgerOf, RunnerKilled, vanishedRunner } from './k8s-kill.js';
import { runnerName } from './k8s-podspec.js';
import {
    containerFailure,
    containerStatusOf,
    ERROR_PREVIEW_CHARS,
    expectOk,
    HTTP_BAD_REQUEST,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    HTTP_OK_STATUS,
    HTTP_SERVER_ERROR_STATUS,
    HTTP_TOO_MANY_REQUESTS,
    isMalformedRequest400,
    isRecord,
    livePod,
    livePodOfItems,
    LOG_TAIL_LINES,
    parse,
    POLL_MAX_CONSECUTIVE_FAILURES,
    POLL_MS,
    readAnswer,
    refusal,
} from './k8s-transport.js';
import type { K8sDeps, K8sJobStatus, K8sPod, K8sPodList, K8sResponse } from './k8s-transport.js';
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
export async function readVerdict(deps: K8sDeps, path: string, what: string, failures = 0): Promise<K8sResponse> {
    let response: K8sResponse;
    try {
        response = await deps.request('GET', path);
    } catch (e) {
        if (failures + 1 > POLL_MAX_CONSECUTIVE_FAILURES) throw e;
        await deps.sleep(POLL_MS);
        return readVerdict(deps, path, what, failures + 1);
    }
    if (
        response.status !== HTTP_TOO_MANY_REQUESTS &&
        response.status < HTTP_SERVER_ERROR_STATUS &&
        !isMalformedRequest400(response.status, response.body)
    ) {
        return response;
    }
    if (failures + 1 > POLL_MAX_CONSECUTIVE_FAILURES) {
        throw new Error(
            `${what} answered ${response.status} ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row: ` +
                `${response.body.slice(0, ERROR_PREVIEW_CHARS)}`
        );
    }
    await deps.sleep(POLL_MS);
    return readVerdict(deps, path, what, failures + 1);
}

/** The answer of a typed read whose object the apiserver confirmed absent (404). */
export const ABSENT = Symbol('absent');

/**
 * A listed or read object that names itself, as far as a decision on it reads (#869): a `metadata`
 * with a non-empty string `name`; `uid` a non-empty string, `labels` and `annotations` string maps
 * and `creationTimestamp` an RFC 3339 time when present; a `status`, when present, a record whose Job
 * counters are counts. One entry that is not this makes the whole read inconclusive; only a
 * well-formed entry out of scope is skipped by its caller.
 */
export function asNamed<T>(value: unknown): T | null {
    if (!isRecord(value) || !isRecord(value.metadata)) return null;
    const { name, uid, labels, annotations, creationTimestamp } = value.metadata;
    if (!nonEmpty(name) || (uid !== undefined && !nonEmpty(uid)) || !optionalTimestamp(creationTimestamp)) return null;
    if (labels !== undefined && !stringsOnly(labels)) return null;
    if (annotations !== undefined && !stringsOnly(annotations)) return null;
    if (value.status !== undefined && (!isRecord(value.status) || !validCounters(value.status))) return null;
    return value as T;
}

/**
 * `asNamed` for a listing a delete is decided on (#869): the entry also carries a non-empty `uid`,
 * which the apiserver always sets and the delete's precondition names. An entry without one makes
 * the whole read inconclusive — it is never deleted unconditionally.
 */
export function asIdentified<T>(value: unknown): T | null {
    const item = asNamed<{ metadata: { uid?: string } }>(value);
    return item && nonEmpty(item.metadata.uid) ? (value as T) : null;
}

/**
 * A listed or read pod (#869): named, with its deletion time, phase, words, conditions and every
 * container status — named, with a typed state — in the grammar `k8s-shapes.ts` gives them. A pod
 * with no `status` yet is a pod that has not started: no container evidence, which every consumer
 * reads as "nothing seen".
 */
export const asPod = (value: unknown): K8sPod | null => {
    const pod = asNamed<K8sPod & { metadata: { deletionTimestamp?: unknown } }>(value);
    if (pod === null || !optionalTimestamp(pod.metadata.deletionTimestamp)) return null;
    const { status } = pod;
    if (status === undefined) return pod;
    const { phase, reason, message, containerStatuses, conditions } = status;
    if (!optionalStrings(phase, reason, message) || !validPodConditions(conditions)) return null;
    return validContainerStatuses(containerStatuses) ? pod : null;
};

/**
 * A Job's `succeeded`, `failed` and `active` counts, each a non-negative integer when present, and
 * its `conditions` a list of typed records when present (#869).
 */
const validCounters = (status: Record<string, unknown>): boolean =>
    (status.conditions === undefined ||
        (Array.isArray(status.conditions) &&
            status.conditions.every((c) => isRecord(c) && typeof c.type === 'string'))) &&
    ['succeeded', 'failed', 'active'].every((field) => status[field] === undefined || isCount(status[field]));

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

/** `readTyped` of a list: every entry `entry` accepts, or inconclusive for a body with no list or any entry it refuses. */
export function readTypedList<T>(
    deps: K8sDeps,
    path: string,
    what: string,
    { entry, once = false }: { entry: (value: unknown) => T | null; once?: boolean }
): Promise<Read<T[]>> {
    const shape = (body: unknown): T[] | null => {
        if (!isRecord(body) || !Array.isArray(body.items)) return null;
        const items = body.items.map(entry);
        return items.every((item) => item !== null) ? (items as T[]) : null;
    };
    return readTyped(deps, path, what, { shape, once });
}

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
    const list = pods.status === HTTP_OK_STATUS ? parse<K8sPodList>(pods.body) : null;
    const items = Array.isArray(list?.items) ? list.items : null;
    // Every container of the pod, not the first: the runner pod holds the agent, the supervisor and
    // the exporter, and any one of them blocked on its image holds the whole run. The init list is
    // read first (#773 D10): a sidecar held on its image keeps every main container initializing.
    const pod = livePod(pods.body);
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
    const podState: PodStartState =
        items === null ? 'unread' : !livePodOfItems(items) ? 'none' : startedAny ? 'started' : 'starting';
    const stuck = waiting?.reason ? { reason: waiting.reason, message: waiting.message ?? '' } : null;
    if (stuck && PULL_REASONS.has(stuck.reason)) {
        return { blocked: pullDetail(stuck), containerSeen: true, waiting: stuck, held, podState, agentStarted };
    }
    const containerSeen =
        containers.length > 0 &&
        containers.every((c) => c.state?.terminated !== undefined || c.state?.running !== undefined);
    return { blocked: null, containerSeen, waiting: stuck, held, podState, agentStarted };
}

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
}

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
    const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
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
    let pods: K8sPod[];
    if (strict) {
        const listed = await readList(deps, podsPath, what, { entry: asPod });
        pods = listed === ABSENT ? [] : listed;
    } else {
        const podsResponse = await readVerdict(deps, podsPath, what);
        expectOk(podsResponse, what);
        pods = parse<K8sPodList>(podsResponse.body).items ?? [];
    }
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
        let log: K8sResponse;
        try {
            log = await deps.request('GET', podLogPath(deps.config.k8sNamespace, pod.metadata.name, tail, container));
        } catch {
            log = { status: 0, body: '' };
        }
        if (log.status < HTTP_ERROR_STATUS) {
            output = log.body;
            truncated = log.truncated === true;
        }
    }
    return { exitCode, output, truncated, pods };
}

/** A pod log refusal that says its container never started, in the kubelet's own words — never any 400. */
export const neverStartedLog = (body: string): boolean => /is waiting to start|is not available/i.test(body);

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
        log = await readVerdict(deps, path, what);
    } catch (e) {
        throw new Inconclusive(`${what}: ${(e as Error).message}`);
    }
    if (log.status === HTTP_NOT_FOUND || (log.status === HTTP_BAD_REQUEST && neverStartedLog(log.body))) {
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
            resolvedPodName = livePod(pods.body)?.metadata?.name ?? null;
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
async function runStartSeen(deps: K8sDeps, job: BoardJob, image: string): Promise<boolean> {
    // A held container is the run's start refused (#824 D11): typed when its words prove a cause,
    // plain (the lease) otherwise — with no bound here but the Job's deadline, a back-off that names
    // no cause is no reason to wait. A released agent that is running or ended has run: a container
    // held beside it (an exporter whose Secret went away) is no refused start of the run.
    const pull = await readImagePullStatus(deps, runnerName(job));
    const refused = pull.agentStarted ? null : startRefusalOf(image, pull, false);
    if (refused) throw refused;
    return pull.containerSeen || pull.agentStarted;
}

export async function pollRunnerJobUntilTerminal(
    deps: K8sDeps,
    job: BoardJob,
    watch: {
        onOutput?: ((tail: string) => void) | undefined;
        /** True once the task supervisor reported the agent over and its exporter drained: the group outlives it. */
        over?: (() => boolean) | undefined;
        podName?: string | null;
    } = {}
): Promise<{ timedOut: boolean; jobSucceeded: boolean }> {
    const { onOutput, over } = watch;
    const podName = watch.podName ?? null;
    const image = executorImage(deps.config, job.executorType);
    const seen = { container: false };
    const poll = async (pod: string | null): Promise<{ timedOut: boolean; jobSucceeded: boolean }> => {
        const result = await readUnlessKilled(deps, job);
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
        if (over?.()) return { timedOut: false, jobSucceeded: false };
        if (!seen.container) seen.container = await runStartSeen(deps, job, image);
        const nextPodName = onOutput ? await tailRunnerOutput(deps, job, pod, onOutput) : pod;
        await deps.sleep(POLL_MS);
        return poll(nextPodName);
    };
    return poll(podName);
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
