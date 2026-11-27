/**
 * The review collection a GitLab merge request's discussions answer as (docs/workflows.md): the `review-collect/v1`
 * shape the review-reconcile block's helper scripts decide on, with the caps those scripts apply to a GitHub
 * collection. The driver imports nothing, so the shapes and caps are copies of `driver/src/review/review.ts`, pinned
 * by `server/test/review-collection.driver-copy.test.ts`. `boundCollection` mirrors `review-collect.cjs`.
 */

export const TRUNCATED_MARKER = ' […truncated by the board] ';
export const BODY_MAX = 2000;
export const ERROR_MAX = 300;
export const GENERAL_LIMIT = 50;
export const INLINE_LIMIT = 50;
export const REVIEWS_LIMIT = 20;
export const THREADS_LIMIT = 100;
export const THREAD_COMMENTS_LIMIT = 10;
const BYTES_PER_KB = 1024;
export const TOTAL_OUTPUT_BYTES = 256 * BYTES_PER_KB;
export const PLAN_TARGETS_MAX = 32;
export const PLAN_BYTES_MAX = 128 * BYTES_PER_KB;

export const ADDRESSED_PREFIX = '<!-- factory-review-reconcile addressed ';
export const ADDRESSED_SUFFIX = ' -->';
export const addressedMarker = (key: string): string => `${ADDRESSED_PREFIX}${key}${ADDRESSED_SUFFIX}`;
const ADDRESSED_MARKER = /<!-- factory-review-reconcile addressed (\S+) -->/g;

export const REVIEW_COLLECT_SCHEMA = 'review-collect/v1';
export const REVIEW_PLAN_SCHEMA = 'review-reply/plan/v1';
export const REVIEW_REPLY_SCHEMA = 'review-reply/v1';

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
    schema: typeof REVIEW_COLLECT_SCHEMA;
    ref: ReviewRef;
    general: ReviewCommentItem[];
    /** GitLab has no review bodies: always empty. */
    reviews: never[];
    /** Every GitLab diff note is in a discussion: always empty. */
    inline: ReviewCommentItem[];
    threads: ReviewThread[];
    /** The item keys a Factory reply already answered, read from every note before the caps. */
    addressed: string[];
    requestedReviewers: { users: string[]; teams: string[] };
    decision: string | null;
    pendingChecks: number;
    truncated: ReviewTruncated;
    error: string | null;
}

/** Every key a Factory reply marker names in the full `bodies`. */
export function addressedKeys(bodies: readonly string[]): string[] {
    const keys = new Set<string>();
    for (const body of bodies) for (const match of body.matchAll(ADDRESSED_MARKER)) keys.add(match[1] as string);
    return [...keys].sort();
}

const cut = (text: string, counts: { bodies: number }): string => {
    const chars = [...text];
    if (chars.length <= BODY_MAX) return text;
    counts.bodies += 1;
    return `${chars.slice(0, BODY_MAX).join('')}${TRUNCATED_MARKER}`;
};

function capped<T extends { id: string | number }>(
    rows: readonly T[],
    limit: number,
    name: string | null,
    ts: ReviewTruncated
) {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const row of rows) {
        if (seen.has(String(row.id))) continue;
        seen.add(String(row.id));
        if (out.length >= limit) {
            if (name !== null && !ts.sections.includes(name)) ts.sections.push(name);
            break;
        }
        out.push(row);
    }
    return out;
}

/**
 * The collection with the per-section caps and body cuts applied, and collapsed to `truncated.total` (no section at all)
 * when its serialization passes `TOTAL_OUTPUT_BYTES`: a reader must see "too big", never a quiet subset.
 */
export function boundCollection(full: ReviewCollection): ReviewCollection {
    const ts: ReviewTruncated = { sections: [], bodies: 0, diffHunks: 0, threads: 0, total: false };
    const counts = { bodies: 0 };
    const general = capped(full.general, GENERAL_LIMIT, 'general', ts).map((c) => ({
        ...c,
        body: cut(c.body, counts),
    }));
    const inline = capped(full.inline, INLINE_LIMIT, 'inline', ts).map((c) => ({ ...c, body: cut(c.body, counts) }));
    const kept = capped(full.threads, THREADS_LIMIT, 'threads', ts);
    const threads = kept.map((thread) => {
        const comments = capped(thread.comments, THREAD_COMMENTS_LIMIT, null, ts);
        if (thread.comments.length > comments.length) ts.threads += 1;
        return { ...thread, comments: comments.map((c) => ({ ...c, body: cut(c.body, counts) })) };
    });
    if (ts.threads > 0) ts.sections.push('thread-comments');
    ts.bodies = counts.bodies;
    const bounded: ReviewCollection = { ...full, general, inline, threads, truncated: ts };
    if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= TOTAL_OUTPUT_BYTES) return bounded;
    return {
        ...full,
        general: [],
        inline: [],
        threads: [],
        addressed: [],
        truncated: { sections: [], bodies: 0, diffHunks: 0, threads: 0, total: true },
    };
}
