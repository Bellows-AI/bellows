import { containerScript as script } from './container-scripts.js';

/**
 * The GitHub review collection and reply scripts (scripts/review-collect.cjs,
 * scripts/review-reply.cjs) as content-passed VALUES — a `node -e` value, never a path, never a
 * template string — so each carries its normalization, dedupe, ordering and capping logic inline.
 * Beside them, the caps and marker the scripts enforce and the verdict and plan shapes they speak,
 * which the script tests pin (scripts.test.ts, review-collect-script.test.ts,
 * review-reply-script.test.ts).
 */

export const reviewCollectScript = script('review-collect.cjs');
export const reviewReplyScript = script('review-reply.cjs');

export const TRUNCATED_MARKER = ' […truncated by the board] ';
export const BODY_MAX = 2000;
export const DIFF_HUNK_MAX = 500;
export const ERROR_MAX = 300;
export const GENERAL_LIMIT = 50;
export const INLINE_LIMIT = 50;
export const REVIEWS_LIMIT = 20;
export const THREADS_LIMIT = 100;
export const THREAD_COMMENTS_LIMIT = 10;
const BYTES_PER_KB = 1024;
const TOTAL_OUTPUT_MAX_KB = 256;
const PLAN_BYTES_MAX_KB = 128;
export const TOTAL_OUTPUT_BYTES = TOTAL_OUTPUT_MAX_KB * BYTES_PER_KB;
export const PLAN_TARGETS_MAX = 32;
export const PLAN_BYTES_MAX = PLAN_BYTES_MAX_KB * BYTES_PER_KB;

export interface ReviewRef {
    owner: string;
    repo: string;
    number: number;
}

export interface ReviewCommentItem {
    id: number;
    author: string | null;
    body: string;
    createdAt: string | null;
    path: string | null;
    line: number | null;
    diffHunk: string | null;
    inReplyToId: number | null;
    reviewId: number | null;
}

export interface SubmittedReview {
    id: number;
    author: string | null;
    state: string | null;
    body: string;
    createdAt: string | null;
    commitId: string | null;
}

export interface ReviewThreadComment {
    id: string;
    databaseId: number | null;
    author: string | null;
    body: string;
    createdAt: string | null;
}

export interface ReviewThread {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    path: string | null;
    line: number | null;
    comments: ReviewThreadComment[];
}

export interface ReviewTruncated {
    sections: string[];
    bodies: number;
    diffHunks: number;
    threads: number;
    total: boolean;
}

export interface ReviewCollection {
    version: 1;
    schema: 'review-collect/v1';
    ref: ReviewRef;
    general: ReviewCommentItem[];
    reviews: SubmittedReview[];
    inline: ReviewCommentItem[];
    threads: ReviewThread[];
    /** The item keys a Factory reply already answered, read from every comment before the caps (issue #826). */
    addressed: string[];
    requestedReviewers: { users: string[]; teams: string[] };
    decision: string | null;
    /** The head commit's check runs not yet completed. */
    pendingChecks: number;
    truncated: ReviewTruncated;
    error: string | null;
}

export type ReplyKind = 'general' | 'inline' | 'thread' | 'resolve';

export type ReviewPlanStatus = 'planned' | 'refused';
export type ReviewPlanReason = 'unknown_target' | 'already_resolved' | 'no_action' | 'no_reply_target';

export interface ReviewPlanTarget {
    id: string;
    kind: ReplyKind;
    /** Reply body for general/inline/thread targets; null for resolve targets. */
    reply: string | null;
    resolve: boolean;
    /** The thread's first comment, the only deterministic reply anchor; thread replies only. */
    firstCommentId: number | null;
    status: ReviewPlanStatus;
    reason: ReviewPlanReason | null;
}

export interface ReviewPlan {
    version: 1;
    schema: 'review-reply/plan/v1';
    ref: ReviewRef;
    targets: ReviewPlanTarget[];
}
