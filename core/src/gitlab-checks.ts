import {
    CHECKS_FAILING,
    CHECKS_PASSING,
    CHECKS_PENDING,
    CHECKS_UNKNOWN,
    type CheckItem,
    type ChecksState,
} from './batch-observation.js';

/**
 * What GitLab's pipeline, job and commit-status states mean as a `CheckItem` (docs/gitlab.md), and what an MR's
 * `detailed_merge_status` means as `PrFacts.mergeable`. Pure tables: no value GitLab sends that is not listed here
 * becomes a pass or a failure, it is `unknown`.
 */

/** Statuses of work that has not finished: pending, whatever the job allows. */
export const GITLAB_UNFINISHED: readonly string[] = [
    'created',
    'waiting_for_resource',
    'preparing',
    'pending',
    'running',
    'canceling',
    'scheduled',
];

/**
 * A job's, a pipeline's or a commit status's state. `manual` blocks until a person starts it (never a pass) unless the
 * job may fail; `canceled` says nobody confirmed the code is wrong, as GitHub's `cancelled` does.
 */
export function gitlabCheckState(status: string, allowFailure: boolean): ChecksState {
    if (status === 'success' || status === 'skipped') return CHECKS_PASSING;
    if (status === 'failed') return allowFailure ? CHECKS_PASSING : CHECKS_FAILING;
    if (GITLAB_UNFINISHED.includes(status)) return CHECKS_PENDING;
    if (status === 'manual') return allowFailure ? CHECKS_PASSING : CHECKS_UNKNOWN;
    return CHECKS_UNKNOWN;
}

export interface GitlabCheck {
    name: string;
    status: string;
    allowFailure: boolean;
    url: string | null;
    stage?: string | null;
    failureReason?: string | null;
}

const ALLOWED_TO_FAIL = 'allowed to fail';

/** One job or commit status as a check: the evidence names the job, its page, its stage and why it failed. */
export function gitlabCheckItem(check: GitlabCheck): CheckItem {
    const state = gitlabCheckState(check.status, check.allowFailure);
    const failed = check.status === 'failed';
    const where = check.stage ? `stage ${check.stage}` : null;
    const detail =
        failed && check.allowFailure
            ? ALLOWED_TO_FAIL
            : failed
              ? [where, check.failureReason].filter(Boolean).join(': ') || check.status
              : check.status;
    return { name: check.name, state, url: check.url, detail };
}

/** MR statuses GitLab is still computing, or that say nothing about the merge: read again, never `true`. */
const UNDECIDED: readonly string[] = ['unchecked', 'checking', 'preparing', 'approvals_syncing', 'not_open'];
const CONFLICTING: readonly string[] = ['conflict', 'need_rebase'];
/** Blockers the checks and the review carry on their own, or only GitLab knows: its refusal of the merge decides. */
const GITLAB_DECIDES: readonly string[] = [
    'mergeable',
    'ci_must_pass',
    'ci_still_running',
    'not_approved',
    'discussions_not_resolved',
    'draft_status',
    'blocked_status',
    'requested_changes',
    'external_status_checks',
    'jira_association_missing',
    'merge_time',
    'locked_paths',
    'locked_lfs_files',
    'security_policy_violations',
    'title_regex',
    'commits_status',
    'merge_request_blocked',
];

/** `PrFacts.mergeable`: false for a conflict, null while undecided or unrecognised (`broken_status` included). */
export function gitlabMergeable(detailedMergeStatus: string, hasConflicts: boolean): boolean | null {
    if (hasConflicts || CONFLICTING.includes(detailedMergeStatus)) return false;
    if (UNDECIDED.includes(detailedMergeStatus)) return null;
    return GITLAB_DECIDES.includes(detailedMergeStatus) ? true : null;
}
