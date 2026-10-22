/**
 * The batch PR observer's pure decisions (docs/batches.md): what GitHub's facts about a task's PR
 * mean, when to look again, and which findings a recovery may act on. No I/O — the board reads the
 * provider outside any lock, asks here, and commits the answer only if the task is still bound to
 * what was read. Observation supplies facts; recovery (batch-recovery.ts) decides what to do.
 */
import { BATCH_RETRY_BACKOFF_BASE_MS, MAX_EVIDENCE_ITEMS, recoveryBackoffMs } from './batch-recovery.js';

export const PR_OPEN = 'open';
export const PR_CLOSED = 'closed';
export const PR_MERGED = 'merged';
export type PrState = typeof PR_OPEN | typeof PR_CLOSED | typeof PR_MERGED;

/** A required check's state; `unknown` is "the board cannot say", never a pass. */
export const CHECKS_PENDING = 'pending';
export const CHECKS_FAILING = 'failing';
export const CHECKS_PASSING = 'passing';
export const CHECKS_MISSING = 'missing';
export const CHECKS_UNKNOWN = 'unknown';
export type ChecksState =
    | typeof CHECKS_PENDING
    | typeof CHECKS_FAILING
    | typeof CHECKS_PASSING
    | typeof CHECKS_MISSING
    | typeof CHECKS_UNKNOWN;

export const MERGEABLE_CLEAN = 'clean';
export const MERGEABLE_CONFLICTING = 'conflicting';
export const MERGEABLE_UNKNOWN = 'unknown';
export type Mergeability = typeof MERGEABLE_CLEAN | typeof MERGEABLE_CONFLICTING | typeof MERGEABLE_UNKNOWN;

export const REVIEW_NONE = 'none';
export const REVIEW_SATISFIED = 'satisfied';
export const REVIEW_REQUIRED = 'required';
export const REVIEW_UNKNOWN = 'unknown';
export type ReviewState = typeof REVIEW_NONE | typeof REVIEW_SATISFIED | typeof REVIEW_REQUIRED | typeof REVIEW_UNKNOWN;

/** What an observation concluded about the PR itself. */
export const OUTCOME_MERGED = 'merged';
export const OUTCOME_CLOSED = 'closed_unmerged';
export const OUTCOME_CHECKS_FAILING = 'checks_failing';
export const OUTCOME_CONFLICTING = 'conflicting';
export const OUTCOME_CHECKS_PENDING = 'checks_pending';
export const OUTCOME_CHECKS_MISSING = 'checks_missing';
export const OUTCOME_REVIEW_REQUIRED = 'review_required';
export const OUTCOME_UNKNOWN = 'unknown';
export const OUTCOME_READY = 'ready';
export type ObservationOutcome =
    | typeof OUTCOME_MERGED
    | typeof OUTCOME_CLOSED
    | typeof OUTCOME_CHECKS_FAILING
    | typeof OUTCOME_CONFLICTING
    | typeof OUTCOME_CHECKS_PENDING
    | typeof OUTCOME_CHECKS_MISSING
    | typeof OUTCOME_REVIEW_REQUIRED
    | typeof OUTCOME_UNKNOWN
    | typeof OUTCOME_READY;

/** Why a read produced no assessment. Never a pass, never repairable. */
export const READ_NOT_FOUND = 'not_found';
export const READ_FORBIDDEN = 'forbidden';
export const READ_RATE_LIMITED = 'rate_limited';
export const READ_TRANSPORT = 'transport';
export const READ_BINDING = 'binding';
export type ReadErrorKind =
    | typeof READ_NOT_FOUND
    | typeof READ_FORBIDDEN
    | typeof READ_RATE_LIMITED
    | typeof READ_TRANSPORT
    | typeof READ_BINDING;

/** Transient failures keep the last assessment (no phantom revision); the rest withdraw it. */
const TRANSIENT_READ_ERRORS: readonly string[] = [READ_RATE_LIMITED, READ_TRANSPORT];
export const isTransientReadError = (kind: string): boolean => TRANSIENT_READ_ERRORS.includes(kind);

/** The refresh cadence of an eligible active PR. */
export const OBSERVE_INTERVAL_MS = BATCH_RETRY_BACKOFF_BASE_MS;
/** Mergeability is computed lazily by GitHub; an unanswered one is asked again soon. */
export const OBSERVE_MERGEABILITY_RETRY_MS = 20_000;

const EVIDENCE_NAME_LIMIT = 200;
const EVIDENCE_URL_LIMIT = 500;
const EVIDENCE_DETAIL_LIMIT = 300;

export interface CheckItem {
    name: string;
    state: ChecksState;
    url: string | null;
    detail: string | null;
}

/** One required or relevant context that is not passing, as a person or a repair prompt reads it. */
export interface CheckEvidence {
    name: string;
    state: ChecksState;
    url: string | null;
    detail: string | null;
}

/** The provider's answer, normalized by the client: facts only, no judgement. */
export interface PrFacts {
    /** The repository the PR belongs to (the base repository), `owner/name`. */
    repo: string;
    number: number;
    url: string;
    state: typeof PR_OPEN | typeof PR_CLOSED;
    merged: boolean;
    mergedAt: string | null;
    mergeCommitSha: string | null;
    /** When GitHub last stamped activity on the PR (push, review, comment); null when it sent none. */
    updatedAt: string | null;
    baseBranch: string;
    headSha: string;
    /** The target branch's tip, or null when it could not be read. */
    targetSha: string | null;
    /** `true` clean, `false` conflicting, null while GitHub computes it. */
    mergeable: boolean | null;
    /** Required status contexts; null when protection could not be read, empty when none are required. */
    requiredContexts: readonly string[] | null;
    /** Approving reviews the target requires; null when unreadable. */
    requiredApprovals: number | null;
    approvals: number | null;
    checks: readonly CheckItem[];
}

export interface Assessment {
    outcome: ObservationOutcome;
    prState: PrState;
    mergeability: Mergeability;
    checks: ChecksState;
    review: ReviewState;
    /** True only for a confirmed failing check or a confirmed conflict on the assessed head. */
    repairable: boolean;
    /** The non-passing contexts, failing first, bounded. */
    evidence: readonly CheckEvidence[];
}

const clip = (value: string | null, limit: number): string | null => (value === null ? null : value.slice(0, limit));

/** Failing outranks pending outranks missing outranks unknown outranks passing. */
const CHECK_RANK: Record<ChecksState, number> = {
    failing: 4,
    pending: 3,
    missing: 2,
    unknown: 1,
    passing: 0,
};

const worst = (states: readonly ChecksState[]): ChecksState =>
    states.reduce<ChecksState>((a, b) => (CHECK_RANK[b] > CHECK_RANK[a] ? b : a), CHECKS_PASSING);

/**
 * The state of the checks that matter. With a known set of required contexts only those count and
 * an unreported one is `missing`; with none required every reported check counts and no report at
 * all is `missing`; with an unreadable requirement nothing can be called passing or failing.
 */
export function assessChecks(
    requiredContexts: readonly string[] | null,
    items: readonly CheckItem[]
): { state: ChecksState; evidence: CheckEvidence[] } {
    const byName = new Map(items.map((item) => [item.name, item]));
    const relevant: CheckEvidence[] = [];
    let state: ChecksState;
    if (requiredContexts === null) {
        state = CHECKS_UNKNOWN;
        relevant.push(...items);
    } else if (requiredContexts.length > 0) {
        for (const name of requiredContexts) {
            relevant.push(byName.get(name) ?? { name, state: CHECKS_MISSING, url: null, detail: 'not reported' });
        }
        state = worst(relevant.map((item) => item.state));
    } else if (items.length === 0) {
        state = CHECKS_MISSING;
    } else {
        relevant.push(...items);
        state = worst(items.map((item) => item.state));
    }
    const evidence = relevant
        .filter((item) => item.state !== CHECKS_PASSING)
        .sort((a, b) => CHECK_RANK[b.state] - CHECK_RANK[a.state] || a.name.localeCompare(b.name))
        .slice(0, MAX_EVIDENCE_ITEMS)
        .map((item) => ({
            name: item.name.slice(0, EVIDENCE_NAME_LIMIT),
            state: item.state,
            url: clip(item.url, EVIDENCE_URL_LIMIT),
            detail: clip(item.detail, EVIDENCE_DETAIL_LIMIT),
        }));
    return { state, evidence };
}

const reviewOf = (facts: Pick<PrFacts, 'requiredApprovals' | 'approvals'>): ReviewState => {
    if (facts.requiredApprovals === null) return REVIEW_UNKNOWN;
    if (facts.requiredApprovals === 0) return REVIEW_NONE;
    if (facts.approvals === null) return REVIEW_UNKNOWN;
    return facts.approvals >= facts.requiredApprovals ? REVIEW_SATISFIED : REVIEW_REQUIRED;
};

const mergeabilityOf = (mergeable: boolean | null): Mergeability =>
    mergeable === null ? MERGEABLE_UNKNOWN : mergeable ? MERGEABLE_CLEAN : MERGEABLE_CONFLICTING;

/**
 * What the facts mean. A merged or closed PR is settled whatever its checks say; an open one is
 * judged most-actionable first, and only a confirmed failing check or conflict is repairable —
 * pending, missing and unknown checks, unknown mergeability and a pending review never are.
 */
export function assessPullRequest(facts: PrFacts): Assessment {
    const { state: checks, evidence } = assessChecks(facts.requiredContexts, facts.checks);
    const mergeability = mergeabilityOf(facts.mergeable);
    const review = reviewOf(facts);
    const base = { mergeability, checks, review, evidence };
    if (facts.merged) return { ...base, outcome: OUTCOME_MERGED, prState: PR_MERGED, repairable: false };
    if (facts.state === PR_CLOSED) return { ...base, outcome: OUTCOME_CLOSED, prState: PR_CLOSED, repairable: false };
    const open = (outcome: ObservationOutcome, repairable = false): Assessment => ({
        ...base,
        outcome,
        prState: PR_OPEN,
        repairable,
    });
    if (checks === CHECKS_FAILING) return open(OUTCOME_CHECKS_FAILING, true);
    if (mergeability === MERGEABLE_CONFLICTING) return open(OUTCOME_CONFLICTING, true);
    if (checks === CHECKS_PENDING) return open(OUTCOME_CHECKS_PENDING);
    if (checks === CHECKS_MISSING) return open(OUTCOME_CHECKS_MISSING);
    if (checks === CHECKS_UNKNOWN || mergeability === MERGEABLE_UNKNOWN) return open(OUTCOME_UNKNOWN);
    if (review === REVIEW_REQUIRED) return open(OUTCOME_REVIEW_REQUIRED);
    return open(OUTCOME_READY);
}

/**
 * The identity of what was assessed: the head the checks ran on, the target the conflict was
 * judged against, the outcome and the evidence. Two observations with one fingerprint are the same
 * observation — a refresh that finds nothing new neither bumps the revision nor triggers recovery.
 */
export function observationFingerprint(
    facts: Pick<PrFacts, 'headSha' | 'targetSha'>,
    assessment: Pick<Assessment, 'outcome' | 'evidence'>
): string {
    const evidence = assessment.evidence.map((item) => `${item.name}=${item.state}`).join(',');
    return [facts.headSha, facts.targetSha ?? '-', assessment.outcome, evidence].join('|');
}

/** The fingerprint of a withdrawn assessment: a definitive read error is one stable identity. */
export const errorFingerprint = (kind: string): string => `error:${kind}`;

/**
 * Milliseconds until the next look. A success is the steady interval (sooner while GitHub has not
 * computed mergeability); a failure backs off exponentially from the base to the cap and never
 * looks sooner than the provider's Retry-After asks.
 */
export function nextObservationDelayMs(
    state: { ok: true; mergeabilityUnknown: boolean } | { ok: false; failures: number; retryAfterMs: number | null }
): number {
    if (state.ok) return state.mergeabilityUnknown ? OBSERVE_MERGEABILITY_RETRY_MS : OBSERVE_INTERVAL_MS;
    return Math.max(recoveryBackoffMs(state.failures), state.retryAfterMs ?? 0);
}

/** Whether `a` and `b` name one repository: GitHub owner/name is case-insensitive. */
export const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
