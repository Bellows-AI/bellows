/**
 * The batch merger's pure decisions (docs/batches.md): whether an observed PR may be merged by the
 * board, how an intent's provider answer is recorded, and whether the merged stage verifies as a
 * whole. No I/O — the board reads durable rows and GitHub, asks here, and commits the answer.
 * Requirements are GitHub's own: nothing here lets a merge past a check, a review or a protection.
 */
import { AUTOMERGE, BATCH_COMPLETION_PR } from './batch-plan.js';
import {
    assessChecks,
    assessPullRequest,
    CHECKS_FAILING,
    CHECKS_PASSING,
    CHECKS_PENDING,
    OUTCOME_READY,
    type CheckItem,
    type PrFacts,
} from './batch-observation.js';
import { recoveryBackoffMs } from './batch-recovery.js';
import { GATE_OPEN, TASK_SUCCEEDED } from './batch-schedule.js';

/** The merge method the board requests; a repository that disallows it refuses and the task is parked. */
export const MERGE_METHOD = 'squash';

/** A merge intent's lifecycle (064). `dispatching` and `uncertain` hold the repository/target's one merge slot. */
export const MERGE_DISPATCHING = 'dispatching';
export const MERGE_UNCERTAIN = 'uncertain';
export const MERGE_MERGED = 'merged';
export const MERGE_REFUSED = 'refused';
/** The fresh read before dispatch found the PR no longer what was observed: nothing was requested. */
export const MERGE_CHANGED = 'changed';
/** A fence (cancel, expiry) stood before the request was sent: nothing was requested. */
export const MERGE_FENCED = 'fenced';
/** A request the provider never accepted (an uncertain one found unmerged, a rate limit): may be tried again. */
export const MERGE_LAPSED = 'lapsed';
export const MERGE_STATES = [
    MERGE_DISPATCHING,
    MERGE_UNCERTAIN,
    MERGE_MERGED,
    MERGE_REFUSED,
    MERGE_CHANGED,
    MERGE_FENCED,
    MERGE_LAPSED,
] as const;
export type MergeState = (typeof MERGE_STATES)[number];

/** States in which the provider may already have acted: no other merge goes to the same target meanwhile. */
export const MERGE_SLOT_STATES: readonly string[] = [MERGE_DISPATCHING, MERGE_UNCERTAIN];

/** How the provider answered a merge request that did not succeed. */
export const MERGE_ERR_REFUSED = 'refused';
export const MERGE_ERR_FORBIDDEN = 'forbidden';
export const MERGE_ERR_RATE_LIMITED = 'rate_limited';
export const MERGE_ERR_UNCERTAIN = 'uncertain';
/** The request never left the board (no installation token): nothing can have been merged. */
export const MERGE_ERR_NOT_SENT = 'not_sent';
export type MergeErrorKind =
    | typeof MERGE_ERR_NOT_SENT
    | typeof MERGE_ERR_REFUSED
    | typeof MERGE_ERR_FORBIDDEN
    | typeof MERGE_ERR_RATE_LIMITED
    | typeof MERGE_ERR_UNCERTAIN;

/** How long a dispatching intent may stand before it is treated as uncertain (the process may have died mid-request). */
export const MERGE_LEASE_MS = 300_000;
/** Requests the provider never accepted, per task attempt, before the task needs a person. */
export const MERGE_MAX_LAPSES = 3;

/** What the board needs of the stored observation to decide on a merge. */
export interface MergeObservation {
    attempt: number;
    outcome: string | null;
    stale: boolean;
    error: string | null;
    baseBranch: string | null;
    headSha: string | null;
}

export interface MergeCandidate {
    policy: string;
    completionKind: string;
    execution: string;
    gate: string;
    /** Cancelled, expired or finished: nothing is requested behind a fence. */
    fenced: boolean;
    /** The task's current attempt; an observation of an earlier one describes something it no longer is. */
    attempt: number;
    targetBranch: string;
    observation: MergeObservation | null;
}

export type MergeJudgement = { merge: true } | { merge: false; reason: string };

/** Whether the stored observation permits a merge request now. Anything short of `ready` and fresh waits. */
export function judgeMergeCandidate(candidate: MergeCandidate): MergeJudgement {
    const no = (reason: string): MergeJudgement => ({ merge: false, reason });
    if (candidate.policy !== AUTOMERGE) return no('the stage policy is not automerge');
    if (candidate.fenced) return no('the batch is cancelled, expired or finished');
    if (candidate.completionKind !== BATCH_COMPLETION_PR) return no('the task completes by acceptance, not a merge');
    if (candidate.execution !== TASK_SUCCEEDED || candidate.gate !== GATE_OPEN)
        return no('the task is not awaiting a merge');
    const observed = candidate.observation;
    if (!observed) return no('the PR has not been observed yet');
    if (observed.attempt !== candidate.attempt) return no('the observation is of an earlier attempt');
    if (observed.error !== null) return no(`the PR could not be read (${observed.error})`);
    if (observed.stale) return no('the observation is stale; a refresh is pending');
    if (observed.baseBranch !== candidate.targetBranch) {
        return no(`the PR targets ${observed.baseBranch ?? 'an unknown branch'}, not ${candidate.targetBranch}`);
    }
    if (observed.outcome !== OUTCOME_READY) return no(`the PR is ${observed.outcome ?? 'not assessed'}, not ready`);
    if (observed.headSha === null) return no('the observation names no head revision');
    return { merge: true };
}

export type FreshJudgement =
    | { proceed: true; headSha: string }
    | { proceed: false; kind: 'merged' | 'changed'; reason: string };

/**
 * The recheck made just before a request is sent, on a fresh read: the head must still be the one
 * the intent was made for, the target the task's own, and GitHub's requirements still satisfied.
 * A PR already merged (by a person, or by an earlier request) is reconciled, never requested again.
 */
export function judgeFreshFacts(intent: { headSha: string; targetBranch: string }, facts: PrFacts): FreshJudgement {
    if (facts.merged) return { proceed: false, kind: 'merged', reason: 'the PR is already merged' };
    if (facts.baseBranch !== intent.targetBranch) {
        return { proceed: false, kind: 'changed', reason: `the PR now targets ${facts.baseBranch}` };
    }
    if (facts.headSha !== intent.headSha) {
        return { proceed: false, kind: 'changed', reason: `the head moved from ${intent.headSha} to ${facts.headSha}` };
    }
    const assessed = assessPullRequest(facts);
    if (assessed.outcome !== OUTCOME_READY) {
        return { proceed: false, kind: 'changed', reason: `the PR is now ${assessed.outcome}, not ready` };
    }
    return { proceed: true, headSha: facts.headSha };
}

/** An uncertain request, reconciled against the PR as GitHub now reports it: merged, or never accepted. */
export const reconcileUncertainMerge = (facts: Pick<PrFacts, 'merged'>): typeof MERGE_MERGED | typeof MERGE_LAPSED =>
    facts.merged ? MERGE_MERGED : MERGE_LAPSED;

/** Milliseconds before a lapsed request may be tried again. */
export const mergeRetryDelayMs = (lapses: number, retryAfterMs: number | null): number =>
    Math.max(recoveryBackoffMs(lapses), retryAfterMs ?? 0);

/** The combined verification of a merged stage (064). */
export const VERIFY_PASSED = 'passed';
export const VERIFY_PENDING = 'pending';
export const VERIFY_FAILED = 'failed';
export const VERIFY_UNKNOWN = 'unknown';
export type VerificationState =
    | typeof VERIFY_PASSED
    | typeof VERIFY_PENDING
    | typeof VERIFY_FAILED
    | typeof VERIFY_UNKNOWN;

export interface StageVerificationEvidence {
    /** Each merged task's PR merge commit; null when GitHub did not report one. */
    merges: readonly { task: string; sha: string | null }[];
    /** The target branch as it stands now. */
    target: {
        branch: string;
        headSha: string;
        /** Whether the tip contains each merge commit, by sha. */
        contains: Readonly<Record<string, boolean>>;
        requiredContexts: readonly string[] | null;
        checks: readonly CheckItem[];
    };
}

export interface StageVerification {
    state: VerificationState;
    detail: string;
    /** The target tip judged; null when it could not be read. */
    headSha: string | null;
}

/**
 * Whether the target, after the stage's merges, is a verified whole: every merged change is on the
 * tip and the tip's checks pass. Only a confirmed pass advances the stage; a failure is a signal a
 * person acts on, never a completion, and anything unreadable waits rather than passing.
 */
export function judgeStageVerification(evidence: StageVerificationEvidence): StageVerification {
    const { merges, target } = evidence;
    const headSha = target.headSha;
    const result = (state: VerificationState, detail: string): StageVerification => ({ state, detail, headSha });
    if (merges.length === 0) return result(VERIFY_PASSED, 'no merged change to verify');
    const unknown = merges.find((merge) => merge.sha === null);
    if (unknown) return result(VERIFY_UNKNOWN, `the merge commit of task "${unknown.task}" could not be read`);
    const absent = merges.find((merge) => target.contains[merge.sha!] !== true);
    if (absent) {
        return result(
            VERIFY_FAILED,
            `${absent.sha} (task "${absent.task}") is not on ${target.branch} at ${headSha}; the merged change was rewritten or reverted`
        );
    }
    const { state, evidence: items } = assessChecks(target.requiredContexts, target.checks);
    const names = items.map((item) => `${item.name} ${item.state}`).join(', ');
    if (state === CHECKS_PASSING) return result(VERIFY_PASSED, `${target.branch} at ${headSha} passes its checks`);
    if (state === CHECKS_FAILING)
        return result(VERIFY_FAILED, `checks on ${target.branch} at ${headSha} fail: ${names}`);
    if (state === CHECKS_PENDING)
        return result(VERIFY_PENDING, `checks on ${target.branch} at ${headSha} are running: ${names}`);
    return result(
        VERIFY_PENDING,
        `no passing checks are reported for ${target.branch} at ${headSha}${names ? `: ${names}` : ''}`
    );
}
