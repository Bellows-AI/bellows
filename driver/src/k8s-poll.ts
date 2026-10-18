import type { BoardJob } from './board.js';
import { executorImage } from './config.js';
import { ARTIFACT_LIMIT, reportTail, tailKept } from './runner.js';
import { jobPath, jobPodsPath, podLogPath } from './k8s-auxspec.js';
import { vanishedRunner } from './k8s-kill.js';
import { runnerName } from './k8s-podspec.js';
import {
    containerFailure,
    containerStatusOf,
    ERROR_PREVIEW_CHARS,
    expectOk,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    HTTP_SERVER_ERROR_STATUS,
    HTTP_TOO_MANY_REQUESTS,
    isMalformedRequest400,
    livePod,
    livePodOfItems,
    LOG_TAIL_LINES,
    parse,
    POLL_MAX_CONSECUTIVE_FAILURES,
    POLL_MS,
    refusal,
} from './k8s-transport.js';
import type { K8sDeps, K8sJobStatus, K8sPod, K8sPodList, K8sResponse } from './k8s-transport.js';
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
function jobOutcome(status: K8sJobStatus): 'succeeded' | 'failed' | 'pending' {
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
 * The one unpullable-image message shape every poll shares; the role word is the only variation —
 * the gate names its own declared image ("gate"), the runner and aux Jobs name the executor's.
 */
export function unpullableImage(role: 'gate' | 'executor', image: string, blocked: string): string {
    return `the ${role} image "${image}" cannot be pulled: ${blocked}`;
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
 */
export async function readImagePullStatus(
    deps: K8sDeps,
    jobName: string
): Promise<{ blocked: string | null; containerSeen: boolean }> {
    const pods = await deps
        .request('GET', jobPodsPath(deps.config.k8sNamespace, jobName))
        .catch(() => ({ status: 0, body: '' }));
    // Every container of the pod, not the first: the runner pod holds the agent, the supervisor and
    // the exporter, and any one of them blocked on its image holds the whole run.
    const containers = livePod(pods.body)?.status?.containerStatuses ?? [];
    for (const container of containers) {
        const waiting = container.state?.waiting;
        if (waiting?.reason === 'ImagePullBackOff' || waiting?.reason === 'ErrImagePull') {
            return {
                blocked:
                    waiting.reason + (waiting.message ? ` — ${waiting.message.slice(0, ERROR_PREVIEW_CHARS)}` : ''),
                containerSeen: true,
            };
        }
    }
    const containerSeen =
        containers.length > 0 &&
        containers.every((c) => c.state?.terminated !== undefined || c.state?.running !== undefined);
    return { blocked: null, containerSeen };
}

/**
 * One verdict-carrying read of a Job's status, translated to the four shapes every caller below
 * branches on: gone, an unexpected status, still running, or a terminal outcome. `readVerdict`
 * owns the transport/429/5xx/malformed-400 retry bound and THROWS once it is exhausted — every
 * caller propagates that (`pollJobToTerminal` re-throws it, `auxVerdict`,
 * `pollRunnerJobUntilTerminal`, the gate poll), wrapping it in its own shape when it needs to.
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
 * The messages one `pollJobToTerminal` caller answers its own give-up shapes with. `failed` is
 * `null` for the sync/reclaim callers, whose script prints `{ok:false,reason}` on its OWN
 * failure — a failed Job is still a verdict to read there, never a give-up reason on its own.
 */
export interface PollToTerminalMessages {
    what: string;
    notFound: (jobName: string) => string;
    errorStatus: (status: number, body: string) => string;
    failed: string | null;
}

/**
 * The pending arm's image watch for the polls whose Job runs the executor image (issue #302):
 * asks the pod whether the image is blocked — `readImagePullStatus` — and answers the failure
 * message when it is. Flips `seen.container` once any container status exists, so the pod list
 * is not re-read on later rounds after the image has pulled. Pulled out of the polls purely to
 * keep their complexity readable, the same move the gate poll makes.
 */
async function executorImageWatch(
    deps: K8sDeps,
    jobName: string,
    image: string,
    seen: { container: boolean }
): Promise<string | null> {
    const pull = await readImagePullStatus(deps, jobName);
    if (pull.blocked) return unpullableImage('executor', image, pull.blocked);
    seen.container = pull.containerSeen;
    return null;
}

/**
 * Poll one Job to a terminal status, the shape every aux Job readout shares: `readVerdict` owns
 * the transport/429/5xx/malformed-400 retry bound, a 404 means the Job is gone, any other non-2xx
 * is unexpected, and a terminal status answers `failed` on the Job's own failure (when the caller
 * names one) or null once there is a verdict to read — a Job failure with no `failed` message is
 * itself such a verdict, exactly like success. A read whose patience ran out — transport failures,
 * 429s, 5xx or the malformed-request 400 (issue #308), all infrastructure — RE-THROWS: it is not
 * this Job's verdict, and a caller that must never see a throw wraps the poll itself (the
 * opencode scrape does; the sync and reclaim callers let it propagate so the loop leaves the job
 * to its lease). Callers whose Job runs the executor image pass its name as `image`:
 * while the pod is still pending, the poll then watches for an image the node cannot pull and
 * answers `unpullableImage` the moment the pod says so (issue #302), instead of letting the Job
 * sit in ImagePullBackOff until its deadline makes the verdict unreadable.
 */
export async function pollJobToTerminal(
    deps: K8sDeps,
    jobName: string,
    messages: PollToTerminalMessages,
    image: string | null = null
): Promise<string | null> {
    const seen = { container: false };
    const pollPending = async (): Promise<string | null> => {
        if (!seen.container && image !== null) {
            const failure = await executorImageWatch(deps, jobName, image, seen);
            if (failure) return failure;
        }
        await deps.sleep(POLL_MS);
        return poll();
    };
    const poll = async (): Promise<string | null> => {
        const result = await readJobStatus(deps, jobName, messages.what);
        if (result.kind === 'notFound') return messages.notFound(jobName);
        if (result.kind === 'error') return messages.errorStatus(result.status, result.body);
        if (result.kind === 'pending') return pollPending();
        if (result.outcome === 'failed') return messages.failed;
        return null;
    };
    return poll();
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
 */
export async function readJobPodVerdict(
    deps: K8sDeps,
    jobName: string,
    { succeeded, container, tail = LOG_TAIL_LINES }: { succeeded: boolean; container?: string; tail?: number | null },
    what: string
): Promise<{ exitCode: number | null; output: string; truncated: boolean; pods: K8sPod[] }> {
    const podsResponse = await readVerdict(deps, jobPodsPath(deps.config.k8sNamespace, jobName), what);
    expectOk(podsResponse, what);
    const pods = parse<K8sPodList>(podsResponse.body).items ?? [];
    const pod = livePodOfItems(pods);
    // `container` names the one whose verdict this is when the pod holds several (the runner pod's
    // agent); an aux pod's only container is read by position, as ever.
    const exitCode = containerStatusOf(pod, container)?.state?.terminated?.exitCode ?? (succeeded ? 0 : null);
    let output = '';
    let truncated = false;
    if (pod?.metadata?.name) {
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
 * Runs one aux Job to its verdict: poll the Job to a terminal status with the same bounded
 * patience every verdict-carrying read has, then read the exit code off its pod and the output
 * off the pod's log — the same discovery (job-name label, terminating pods skipped) and the same
 * succeeded-with-no-pod convention the runner's own verdict read applies. Used by the publish
 * steps and the claude-turns close read, whose every container is exactly this shape.
 */
export async function auxVerdict(
    deps: K8sDeps,
    jobName: string,
    signal?: AbortSignal
): Promise<{ exitCode: number | null; output: string }> {
    if (signal?.aborted) throw new Error(`the job ${jobName} was cancelled`);
    const result = await readJobStatus(deps, jobName, `reading the job ${jobName}`);
    if (result.kind === 'notFound') {
        throw new Error(`the job ${jobName} no longer exists`);
    }
    if (result.kind === 'error') throw new Error(refusal(result, `reading the job ${jobName}`)!);
    if (result.kind === 'pending') {
        await deps.sleep(POLL_MS);
        return auxVerdict(deps, jobName, signal);
    }
    return readJobPodVerdict(
        deps,
        jobName,
        { succeeded: result.outcome === 'succeeded' },
        `listing the pods of ${jobName}`
    );
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
 * Poll until the runner Job reports a terminal status. The kubelet-enforced activeDeadlineSeconds
 * is what guarantees the JOB eventually reaches one — the same bound that kills the docker
 * runner's container guarantees this an exit. It does not guarantee this driver can keep READING
 * it, so 429s, 5xx and transport failures are retried a bounded number of times rather than
 * treated as the run's verdict. While the Job is still pending, the poll also watches for an
 * executor image the node cannot pull (issue #302) and fails the run naming it, instead of
 * burning the deadline and reporting a timeout over what is really "no such image".
 */
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
        const result = await readJobStatus(deps, runnerName(job), 'reading the runner job');
        if (result.kind === 'notFound') {
            // Gone without this driver deleting it — fenced away or removed by hand. Its verdict can
            // never arrive, so waiting longer is holding a slot for nothing.
            throw vanishedRunner(runnerName(job));
        }
        if (result.kind === 'error') throw new Error(refusal(result, 'reading the runner job')!);
        if (result.kind === 'terminal') {
            return { timedOut: timedOutOf(result.status), jobSucceeded: result.outcome === 'succeeded' };
        }
        // The task group outlives the agent: its supervisor's report — the agent is over and the
        // exporter drained — is the end of the run, with the Job still serving the attempt's steps.
        if (over?.()) return { timedOut: false, jobSucceeded: false };
        if (!seen.container) {
            const failure = await executorImageWatch(deps, runnerName(job), image, seen);
            if (failure) throw new Error(failure);
        }
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
    report: SupervisorReport | null = null
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
        { succeeded: jobSucceeded, container: AGENT_CONTAINER, tail: null },
        'listing the runner pods'
    );
    // The tail for the verdict's output field, and the full log (issue #325) tail-kept at the
    // artifact cap for the loop's upload — both cut from the one pod log this read exists for,
    // truncated when either the cap or the transport cut it.
    const full = tailKept(verdict.output, ARTIFACT_LIMIT);
    const supervisorExit = containerStatusOf(livePodOfItems(verdict.pods), SUPERVISOR_CONTAINER)?.state?.terminated
        ?.exitCode;
    return {
        // The supervisor's report carries the agent's own exit when the kubelet's status has not caught up
        // with a pod that is still running its supervisor (the group outlives the agent).
        exitCode: verdict.exitCode ?? report?.agentExit ?? null,
        output: reportTail(verdict.output),
        fullLog: full.content,
        logTruncated: full.truncated || verdict.truncated,
        // What the run's end amounts to is `infraLossOf`'s to decide, over both executors.
        vanished: jobSucceeded ? null : runnerLossOf(verdict.pods),
        unfinalized: jobSucceeded ? null : supervisorLossOf(livePodOfItems(verdict.pods), supervisorExit),
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
