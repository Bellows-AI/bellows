import { describe, expect, it } from 'vitest';
import {
    addressedKeys,
    BODY_MAX,
    boundCollection,
    GENERAL_LIMIT,
    type ReviewCollection,
    TOTAL_OUTPUT_BYTES,
    THREAD_COMMENTS_LIMIT,
    THREADS_LIMIT,
    TRUNCATED_MARKER,
} from '../src/forge/review-collection.js';

const empty = (): ReviewCollection => ({
    version: 1,
    schema: 'review-collect/v1',
    ref: { owner: 'grp/sub', repo: 'web', number: 1 },
    general: [],
    reviews: [],
    inline: [],
    threads: [],
    addressed: [],
    requestedReviewers: { users: [], teams: [] },
    decision: null,
    pendingChecks: 0,
    truncated: { sections: [], bodies: 0, diffHunks: 0, threads: 0, total: false },
    error: null,
});
const note = (id: number, body = 'b') => ({
    id: String(id),
    databaseId: id,
    author: 'rev-one',
    body,
    createdAt: null,
});
const thread = (id: number, comments = [note(id)]) => ({
    id: `d${id}`,
    isResolved: false,
    isOutdated: false,
    path: null,
    line: null,
    comments,
});
const item = (id: number, body = 'b') => ({
    id,
    author: 'rev-one',
    body,
    createdAt: null,
    path: null,
    line: null,
    diffHunk: null,
    inReplyToId: null,
    reviewId: null,
});

describe('boundCollection', () => {
    it('keeps a small collection as it is', () => {
        const full = { ...empty(), general: [item(1)], threads: [thread(1)] };
        expect(boundCollection(full)).toEqual(full);
    });

    it('caps each section and names it', () => {
        const full = {
            ...empty(),
            general: Array.from({ length: GENERAL_LIMIT + 1 }, (_, i) => item(i + 1)),
            threads: Array.from({ length: THREADS_LIMIT + 1 }, (_, i) => thread(i + 1)),
        };
        const bounded = boundCollection(full);
        expect(bounded.general).toHaveLength(GENERAL_LIMIT);
        expect(bounded.threads).toHaveLength(THREADS_LIMIT);
        expect(bounded.truncated.sections).toEqual(['general', 'threads']);
    });

    it('caps a thread\'s comments and cuts a long body, counting both', () => {
        const comments = Array.from({ length: THREAD_COMMENTS_LIMIT + 1 }, (_, i) => note(i + 1));
        const long = 'x'.repeat(BODY_MAX + 5);
        const bounded = boundCollection({
            ...empty(),
            general: [item(1, long)],
            threads: [thread(1, comments)],
        });
        expect(bounded.threads[0]?.comments).toHaveLength(THREAD_COMMENTS_LIMIT);
        expect(bounded.truncated).toMatchObject({ threads: 1, bodies: 1, sections: ['thread-comments'] });
        expect(bounded.general[0]?.body).toBe(`${'x'.repeat(BODY_MAX)}${TRUNCATED_MARKER}`);
    });

    it('collapses a collection past the total bound to `truncated.total`, with no section', () => {
        const big = 'y'.repeat(BODY_MAX);
        const threads = Array.from({ length: THREADS_LIMIT }, (_, i) =>
            thread(i + 1, Array.from({ length: THREAD_COMMENTS_LIMIT }, (_, j) => note(i * 100 + j + 1, big)))
        );
        const bounded = boundCollection({ ...empty(), threads, addressed: ['thread:d1'] });
        expect(bounded.truncated.total).toBe(true);
        expect(bounded.threads).toEqual([]);
        expect(JSON.stringify(bounded).length).toBeLessThan(TOTAL_OUTPUT_BYTES);
    });
});

describe('addressedKeys', () => {
    it('reads every marker of every body, sorted and unique', () => {
        const marked = (key: string) => `ok\n\n<!-- factory-review-reconcile addressed ${key} -->`;
        expect(addressedKeys([marked('thread:b'), marked('general:3'), marked('thread:b'), 'plain'])).toEqual([
            'general:3',
            'thread:b',
        ]);
    });
});
