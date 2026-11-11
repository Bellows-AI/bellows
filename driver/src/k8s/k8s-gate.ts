import type { BoardJob } from '../board/board.js';
import { STRATEGIC_MERGE_PATCH_CONTENT_TYPE } from '../http.js';
import { jobPodsPath, podLogPath, previousPodLogPath } from './k8s-auxspec.js';
import { gateRequests, reviewerRequests } from './k8s-podfields.js';
import { stepHostFor } from './k8s-group.js';
import { runnerName } from './k8s-podspec.js';
import { podsOf } from './k8s-poll.js';
import {
    HTTP_ERROR_STATUS,
    HTTP_OK_STATUS,
    type K8sContainerStatus,
    type K8sDeps,
    type K8sRequestOptions,
    livePodOfItems,
} from './k8s-transport.js';
import {
    REVIEWER_LOG_TAIL_LINES,
    REVIEWER_READ_MS,
    type ReviewRun,
    reviewerReadSignal,
    reviewerStateNote,
    reviewIsLost,
    runReviewSteps,
    withReviewerNote,
} from '../review/review-step.js';
import type { GateSizing, ReviewerSizing } from '../runner.js';
import { type GateStepRequest, runGateStep } from '../supervised-steps.js';
import { GATE_CONTAINER, REVIEWER_CONTAINER, type StepResult } from '../supervisor-contract.js';
import { gateImageOf } from '../supervisor-plan.js';

/**
 * The kubernetes half of the gates (issue #773): a gate is a supervised step in the attempt's pod,
 * whose gate sidecar runs it (`k8s-podspec.ts`), and the sidecar is resized in place between the
 * agent's run and the verify. No Job, Secret or pod of its own.
 */

/** One gate in the attempt's group, made on demand for an attempt whose sync made none. */
export async function runGateInGroup(
    deps: K8sDeps,
    job: BoardJob,
    gate: GateStepRequest,
    signal?: AbortSignal
): Promise<StepResult> {
    return runGateStep(await stepHostFor(deps, job), job, gate, signal);
}

/** One review in the caller's group, made on demand like a gate's (issue #774). */
export async function runReviewInGroup(deps: K8sDeps, run: ReviewRun, signal?: AbortSignal): Promise<StepResult> {
    const result = await runReviewSteps(await stepHostFor(deps, run.caller), run, signal);
    if (!reviewIsLost(result, signal)) return result;
    return withReviewerNote(result, await readReviewer(deps, run.caller, signal));
}

/** The reviewer sidecar's status as text ("running", "terminated 2 (Error)"), and how often the kubelet restarted it. */
function sidecarStateOf(status: K8sContainerStatus): { state: string; restarts: number | null } | { why: string } {
    const { running, terminated, waiting } = status.state ?? {};
    const exit = (t: { exitCode?: number; reason?: string }) =>
        `${typeof t.exitCode === 'number' ? ` ${t.exitCode}` : ''}${t.reason ? ` (${t.reason})` : ''}`;
    let state: string;
    if (running) state = 'running';
    else if (terminated) state = `terminated${exit(terminated)}`;
    else if (waiting) state = `waiting${waiting.reason ? ` (${waiting.reason})` : ''}`;
    else return { why: 'the sidecar status names no state' };
    const restarts =
        Number.isInteger(status.restartCount) && (status.restartCount as number) >= 0
            ? (status.restartCount as number)
            : null;
    const last = status.lastState?.terminated;
    if (restarts) state += `, restarted ${restarts} times${last ? `, last exit${exit(last)}` : ''}`;
    return { state, restarts };
}

/** What the pod list says of the reviewer sidecar: its state text (or why there is none), its restarts, and the pod to read the log of. */
interface SidecarRead {
    state: string | null;
    why: string;
    restarts: number | null;
    pod?: string;
}

async function readSidecar(deps: K8sDeps, caller: BoardJob, options: K8sRequestOptions): Promise<SidecarRead> {
    try {
        const listed = await deps.request(
            'GET',
            jobPodsPath(deps.config.k8sNamespace, runnerName(caller)),
            undefined,
            options
        );
        const read = podsOf(listed, 'listing the reviewer pod');
        if (read.kind !== 'value') return { state: null, why: read.reason, restarts: null };
        const pod = livePodOfItems(read.value);
        const status = pod?.status?.initContainerStatuses?.find((s) => s.name === REVIEWER_CONTAINER);
        const found = { ...(pod?.metadata?.name ? { pod: pod.metadata.name } : {}) };
        if (!status) return { state: null, why: 'the pod lists no reviewer sidecar', restarts: null, ...found };
        const parsed = sidecarStateOf(status);
        return 'state' in parsed
            ? { state: parsed.state, why: '', restarts: parsed.restarts, ...found }
            : { state: null, why: parsed.why, restarts: null, ...found };
    } catch (e) {
        return { state: null, why: (e as Error).message, restarts: null };
    }
}

/**
 * The reviewer sidecar's state and last log lines, under one 5 s bound: the pod listed anew, the
 * log of the instance that died when the kubelet restarted it, else the current one. Evidence only:
 * an unread answer is "state unknown" / "logs unavailable" and one log read is all there is.
 */
async function readReviewer(deps: K8sDeps, caller: BoardJob, signal?: AbortSignal): Promise<string> {
    const options = { signal: reviewerReadSignal(signal), timeoutMs: REVIEWER_READ_MS };
    const { state, why, restarts, pod } = await readSidecar(deps, caller, options);
    const restarted = restarts !== null && restarts > 0;
    let tail: string[] | null = null;
    if (pod) {
        const namespace = deps.config.k8sNamespace;
        const path = restarted
            ? previousPodLogPath(namespace, pod, REVIEWER_LOG_TAIL_LINES, REVIEWER_CONTAINER)
            : podLogPath(namespace, pod, REVIEWER_LOG_TAIL_LINES, REVIEWER_CONTAINER);
        try {
            const log = await deps.request('GET', path, undefined, options);
            if (ok(log.status)) tail = log.body.split('\n');
        } catch {
            // logs unavailable
        }
    }
    return reviewerStateNote({ state, why, tail, ...(restarted ? { beforeRestart: restarts } : {}) });
}

const ok = (status: number): boolean => status >= HTTP_OK_STATUS && status < HTTP_ERROR_STATUS;

/**
 * Asks the kubelet to resize one sidecar's requests (`pods/<pod>/resize`), a strategic merge patch
 * naming that container alone, so no other container of the pod is touched. The pod is listed on
 * every call, never remembered. Best-effort: false for a group without it, a list or patch that
 * failed or was refused — the work runs either way, at whatever size the pod has.
 */
async function resizeSidecar(
    deps: K8sDeps,
    job: BoardJob,
    container: string,
    requests: { cpu: string; memory: string }
): Promise<boolean> {
    try {
        const namespace = deps.config.k8sNamespace;
        const listed = await deps.request('GET', jobPodsPath(namespace, runnerName(job)));
        const read = podsOf(listed, 'listing the gate pod');
        const pod = read.kind === 'value' ? livePodOfItems(read.value)?.metadata?.name : undefined;
        if (!pod) return false;
        const patch = { spec: { initContainers: [{ name: container, resources: { requests } }] } };
        const path = `/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(pod)}/resize`;
        return ok(
            (
                await deps.request('PATCH', path, patch, {
                    contentType: STRATEGIC_MERGE_PATCH_CONTENT_TYPE,
                })
            ).status
        );
    } catch {
        return false;
    }
}

/** Resizes the gate sidecar (issue #773); false for a group with no gate. */
export async function resizeGateSidecar(deps: K8sDeps, job: BoardJob, phase: GateSizing): Promise<boolean> {
    if (!gateImageOf(job)) return false;
    return resizeSidecar(deps, job, GATE_CONTAINER, gateRequests(deps.config, phase));
}

/** Resizes the reviewer sidecar (issue #774); false for a claim that lists no reviewer profile. */
export async function resizeReviewerSidecar(deps: K8sDeps, job: BoardJob, phase: ReviewerSizing): Promise<boolean> {
    if (!job.reviewerProfiles?.length) return false;
    return resizeSidecar(deps, job, REVIEWER_CONTAINER, reviewerRequests(deps.config, phase));
}
