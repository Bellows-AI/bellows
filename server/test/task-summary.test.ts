import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../src/db/task-summary.js';

/** ISO stamps count backwards from a fixed base — `at(60)` is an hour before `at(5)`. */
const at = (minutes: number): string =>
    new Date(Date.parse('2026-09-10T12:00:00.000Z') - minutes * 60_000).toISOString();

const ID = '11111111-1111-4111-8111-111111111111';

describe('the task cursor', () => {
    const mint = (payload: Record<string, unknown>): string =>
        Buffer.from(JSON.stringify(payload)).toString('base64url');

    it('round trips through base64url', () => {
        const cursor = encodeCursor({ sort: 'newest', state: 'running', activityAt: at(3), rootId: ID });
        expect(cursor).not.toMatch(/[+/=]/);
        expect(decodeCursor(cursor, { sort: 'newest', state: 'running' })).toEqual({
            v: 1,
            sort: 'newest',
            state: 'running',
            activityAt: at(3),
            rootId: ID,
        });
    });

    it('answers null for a malformed payload', () => {
        expect(decodeCursor('not base64!!', { sort: 'newest', state: 'attention' })).toBeNull();
        expect(decodeCursor(mint({ v: 1 }), { sort: 'newest', state: 'attention' })).toBeNull();
    });

    it('binds the sort and every normalized filter', () => {
        const cursor = encodeCursor({
            sort: 'newest',
            state: 'review',
            q: 'fix',
            repo: 'a/b',
            author: 'cat',
            activityAt: at(3),
            rootId: ID,
        });
        expect(decodeCursor(cursor, { sort: 'newest', state: 'attention' })).toBeNull();
        expect(decodeCursor(cursor, { sort: 'oldest', state: 'review' })).toBeNull();
        expect(decodeCursor(cursor, { sort: 'newest', state: 'review', q: 'fix', repo: 'a/b', author: 'cat' })).toEqual(
            {
                v: 1,
                sort: 'newest',
                state: 'review',
                q: 'fix',
                repo: 'a/b',
                author: 'cat',
                activityAt: at(3),
                rootId: ID,
            }
        );
        // An absent filter is itself a bound value: a cursor minted under one must not spend under
        // the other.
        expect(decodeCursor(cursor, { sort: 'newest', state: 'review', q: 'fix', repo: 'a/b' })).toBeNull();
        expect(
            decodeCursor(cursor, { sort: 'newest', state: 'review', q: 'other', repo: 'a/b', author: 'cat' })
        ).toBeNull();
        expect(
            decodeCursor(cursor, { sort: 'newest', state: 'review', q: 'fix', repo: 'other/one', author: 'cat' })
        ).toBeNull();
        expect(
            decodeCursor(cursor, { sort: 'newest', state: 'review', q: 'fix', repo: 'a/b', author: 'other' })
        ).toBeNull();
    });

    it('answers null on a stale version', () => {
        const payload = JSON.parse(
            Buffer.from(
                encodeCursor({ sort: 'newest', state: 'running', activityAt: at(3), rootId: ID }),
                'base64url'
            ).toString()
        ) as Record<string, unknown>;
        expect(decodeCursor(mint({ ...payload, v: 99 }), { sort: 'newest', state: 'running' })).toBeNull();
    });

    it('answers null when the stamp or root id is not the shape it minted', () => {
        expect(
            decodeCursor(mint({ v: 1, sort: 'newest', state: 'running', activityAt: 'nope', rootId: ID }), {
                sort: 'newest',
                state: 'running',
            })
        ).toBeNull();
        // Parseable but not the exact ISO shape the encoder mints: it would survive decode and
        // die at the SQL cast later — a 503 where BAD_CURSOR is the truthful answer.
        expect(
            decodeCursor(mint({ v: 1, sort: 'newest', state: 'running', activityAt: 'Sept 5 2026', rootId: ID }), {
                sort: 'newest',
                state: 'running',
            })
        ).toBeNull();
        expect(
            decodeCursor(mint({ v: 1, sort: 'newest', state: 'running', activityAt: at(3), rootId: 'nope' }), {
                sort: 'newest',
                state: 'running',
            })
        ).toBeNull();
    });
});
