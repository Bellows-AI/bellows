import type { BoardJob } from './board.js';
import { STRATEGIC_MERGE_PATCH_CONTENT_TYPE } from './http.js';
import { jobPodsPath } from './k8s-auxspec.js';
import { gateRequests, reviewerRequests } from './k8s-podfields.js';
import { stepHostFor } from './k8s-group.js';
import { runnerName } from './k8s-podspec.js';
import { podsOf } from './k8s-poll.js';
import { HTTP_ERROR_STATUS, HTTP_OK_STATUS, type K8sDeps, livePodOfItems } from './k8s-transport.js';
import { type ReviewRun, runReviewSteps } from './review-step.js';
import type { GateSizing, ReviewerSizing } from './runner.js';
import { type GateStepRequest, runGateStep } from './supervised-steps.js';
import { GATE_CONTAINER, REVIEWER_CONTAINER, type StepResult } from './supervisor-contract.js';
import { gateImageOf } from './supervisor-plan.js';

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
    return runReviewSteps(await stepHostFor(deps, run.caller), run, signal);
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
