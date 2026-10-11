/**
 * The pure decisions behind a batch's PR gates: whether one task's recorded PR satisfies its
 * completion, whether the board may attempt a merge, and whether a stage may release the next.
 * Evidence is addressed by `(repo, target branch, PR number)` and carries the revisions it was
 * observed at, never a bare PR number or SHA. A run's success or a manual done is not an input:
 * only the observed PR state is, so neither can satisfy a gate. Every refusal is an explicit
 * reason; nothing here bypasses a permission, a protection rule or a stale observation.
 */

import { type BATCH_COMPLETION_ACCEPTED, BATCH_COMPLETION_PR, type BatchPolicy } from './batch-plan.js';

export const PR_GATE_REASONS = [
    'no_pr',
    'wrong_target',
    'closed_unmerged',
    'stale_evidence',
    'checks_pending',
    'checks_failing',
    'review_required',
    'protection_required',
    'missing_permissions',
    'awaiting_human_merge',
] as const;
export type PrGateReason = (typeof PR_GATE_REASONS)[number];

export const STAGE_GATE_REASONS = [
    'tasks_open',
    'verification_missing',
    'verification_failed',
    'revisions_missing',
] as const;
export type StageGateReason = (typeof STAGE_GATE_REASONS)[number];

export type PrState = 'open' | 'merged' | 'closed';
export type ChecksState = 'passing' | 'pending' | 'failing';
export type ReviewState = 'approved' | 'required' | 'changes_requested';

/** What the board last observed of one task's PR. */
export interface ObservedPr {
    repo: string;
    /** The branch the PR merges into. */
    base: string;
    number: number;
    state: PrState;
    /** The PR head the checks and reviews were observed at. */
    headSha: string;
    /** The target branch tip the checks were observed against. */
    baseSha: string;
    checks: ChecksState;
    review: ReviewState;
    /** Branch protection the board's credential cannot satisfy, e.g. an unmet code-owner rule. */
    protectionBlocked: boolean;
    /** The board's credential may merge into this target. */
    canMerge: boolean;
    /** The merge commit, once merged. */
    mergedSha?: string;
}

/** The task's own target, as frozen with the batch. */
export interface TaskTarget {
    repo: string;
    branch: string;
}

/** The live tips, read just before acting. */
export interface LiveRevisions {
    headSha: string;
    baseSha: string;
}

export type PrGate =
    | { ok: true; mergedSha: string; repo: string; branch: string }
    | { ok: false; reason: PrGateReason };

/**
 * Whether a task's PR completion is satisfied: merged, into the task's own target, with a merge
 * commit recorded. Anything else is a named reason.
 */
export function evaluatePrGate(target: TaskTarget, pr: ObservedPr | null): PrGate {
    if (!pr) return { ok: false, reason: 'no_pr' };
    if (pr.repo !== target.repo || pr.base !== target.branch) return { ok: false, reason: 'wrong_target' };
    if (pr.state === 'closed') return { ok: false, reason: 'closed_unmerged' };
    if (pr.state === 'merged') {
        return pr.mergedSha
            ? { ok: true, mergedSha: pr.mergedSha, repo: pr.repo, branch: pr.base }
            : { ok: false, reason: 'stale_evidence' };
    }
    return { ok: false, reason: 'awaiting_human_merge' };
}

export type MergeDecision = { merge: true } | { merge: false; reason: PrGateReason };

/**
 * Whether the board may dispatch a merge now. Human policy never merges. Automerge refuses on
 * evidence whose head or target tip has moved since it was observed: the checks it recorded
 * describe a different commit graph, so they must be rerun and re-observed first.
 */
export function decideMerge(
    policy: BatchPolicy,
    target: TaskTarget,
    pr: ObservedPr | null,
    live: LiveRevisions
): MergeDecision {
    if (policy !== 'automerge') return { merge: false, reason: 'awaiting_human_merge' };
    if (!pr) return { merge: false, reason: 'no_pr' };
    if (pr.repo !== target.repo || pr.base !== target.branch) return { merge: false, reason: 'wrong_target' };
    if (pr.state === 'closed') return { merge: false, reason: 'closed_unmerged' };
    if (pr.state === 'merged') return { merge: false, reason: 'stale_evidence' };
    if (pr.headSha !== live.headSha || pr.baseSha !== live.baseSha) return { merge: false, reason: 'stale_evidence' };
    if (!pr.canMerge) return { merge: false, reason: 'missing_permissions' };
    if (pr.protectionBlocked) return { merge: false, reason: 'protection_required' };
    if (pr.checks === 'failing') return { merge: false, reason: 'checks_failing' };
    if (pr.checks === 'pending') return { merge: false, reason: 'checks_pending' };
    if (pr.review !== 'approved') return { merge: false, reason: 'review_required' };
    return { merge: true };
}

/** The outcome of one task, as the stage gate reads it. */
export type TaskOutcome =
    | { completion: typeof BATCH_COMPLETION_PR; required: boolean; gate: PrGate }
    | { completion: typeof BATCH_COMPLETION_ACCEPTED; required: boolean; accepted: boolean };

export type StageVerification =
    | { state: 'missing' }
    | { state: 'failed' }
    | { state: 'passed'; revisions: Record<string, string> };

export type StageGate =
    | { ok: true; revisions: Record<string, string> }
    | { ok: false; reason: StageGateReason; count?: number };

/**
 * Whether a stage may release the next one: every required task satisfied by its own evidence,
 * and the combined result verified. `revisions` maps each target key the stage changed to the
 * revision the next stage starts from; it is the per-target prerequisite snapshot.
 */
export function evaluateStageGate(
    outcomes: readonly TaskOutcome[],
    verification: StageVerification,
    changedTargets: readonly string[]
): StageGate {
    const open = outcomes.filter(
        (outcome) =>
            outcome.required && (outcome.completion === BATCH_COMPLETION_PR ? !outcome.gate.ok : !outcome.accepted)
    );
    if (open.length > 0) return { ok: false, reason: 'tasks_open', count: open.length };
    if (verification.state === 'missing') return { ok: false, reason: 'verification_missing' };
    if (verification.state === 'failed') return { ok: false, reason: 'verification_failed' };
    const missing = changedTargets.filter((key) => !verification.revisions[key]);
    if (missing.length > 0) return { ok: false, reason: 'revisions_missing', count: missing.length };
    return { ok: true, revisions: verification.revisions };
}

/** The key one merge attempt serializes on: per repository target, across batches. */
export function mergeLockKey(repo: string, branch: string): string {
    return `${repo}\u0000${branch}`;
}
