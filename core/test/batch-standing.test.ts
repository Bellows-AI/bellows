import { describe, expect, it } from 'vitest';
import { batchStanding, batchWaitResult, type StandingRecord } from '../src/index.js';

const PR = 'https://example.test/o/api/pull/9';

const task = (key: string, execution: string, extra: Record<string, unknown> = {}) => ({
    key,
    stage: 'build',
    execution,
    pr: 'none',
    waitReason: null,
    ...extra,
});

const record = (
    status: string,
    tasks: StandingRecord['tasks'],
    extra: Partial<StandingRecord> = {}
): StandingRecord => ({ status, cancelledAt: null, expiredAt: null, tasks, verification: [], ...extra });

const verified = (state: string, detail: string | null = null) => ({
    stage: 'build',
    state,
    detail,
    headSha: 'cd89f3d2',
});

/** The report's rows: every task acts as `action` unless named in `over`. */
const report = (keys: string[], action = 'merge', over: Record<string, string> = {}) =>
    keys.map((key) => ({ key, next: { action: over[key] ?? action } }));

describe('batchStanding', () => {
    it('is succeeded once the board completed the batch with every task succeeded', () => {
        const done = record('completed', [task('a', 'succeeded')]);
        expect(batchStanding(done, report(['a'])).verdict).toBe('succeeded');
    });

    it('keeps running while a task moves, and while every task is done but the board has not completed the batch', () => {
        expect(batchStanding(record('running', [task('a', 'running')]), report(['a'])).verdict).toBe('running');
        expect(batchStanding(record('running', [task('a', 'succeeded')]), report(['a'])).verdict).toBe('running');
    });

    it('is failed for a failed task, which beats a cancelled one', () => {
        const mixed = record('running', [task('a', 'cancelled'), task('b', 'failed')]);
        expect(batchStanding(mixed, report(['a', 'b'])).verdict).toBe('failed');
        const cancelled = record('running', [task('a', 'cancelled'), task('b', 'succeeded')]);
        expect(batchStanding(cancelled, report(['a', 'b'])).verdict).toBe('cancelled');
    });

    it('reads a completed batch whose task a person force-closed as succeeded', () => {
        const closed = task('b', 'cancelled', { closedAt: '2026-10-12T06:00:00.000Z' });
        const done = record('completed', [task('a', 'succeeded'), closed]);
        expect(batchStanding(done, report(['a', 'b'])).verdict).toBe('succeeded');
        expect(batchStanding({ ...done, status: 'running' }, report(['a', 'b'])).verdict).toBe('cancelled');
    });

    it('lists a task waiting on a person, with pr null when it has none', () => {
        const waiting = record('running', [
            task('a', 'running', { waitReason: 'human review', pr: PR }),
            task('b', 'running', { waitReason: 'a question' }),
            task('c', 'running'),
        ]);
        const standing = batchStanding(waiting, report(['a', 'b', 'c']));
        expect(standing.verdict).toBe('needs_attention');
        expect(standing.attention).toEqual([
            { key: 'a', stage: 'build', waitReason: 'human review', pr: PR },
            { key: 'b', stage: 'build', waitReason: 'a question', pr: null },
        ]);
    });

    it("reads an open PR the report's next leaves to the board as running, and hands it to a person on any other next", () => {
        const merging = record('running', [task('a', 'succeeded', { pr: PR, waitReason: 'waiting for the board' })]);
        const board = batchStanding(merging, report(['a'], 'wait'));
        expect(board.verdict).toBe('running');
        expect(board.attention).toEqual([]);
        expect(batchStanding(merging, report(['a'], 'merge')).verdict).toBe('needs_attention');
    });

    it('names every failed verification, and keeps a pending one running', () => {
        const base = [task('a', 'succeeded')];
        const failed = batchStanding(
            record('running', base, { verification: [verified('passed'), verified('failed', 'e2e failing')] }),
            report(['a'])
        );
        expect(failed.verdict).toBe('needs_attention');
        expect(failed.verificationFailures).toEqual([
            { stage: 'build', state: 'failed', detail: 'e2e failing', headSha: 'cd89f3d2' },
        ]);
        const pending = record('running', base, { verification: [verified('pending')] });
        expect(batchStanding(pending, report(['a'])).verdict).toBe('running');
        expect(batchStanding({ ...pending, status: 'completed' }, report(['a'])).verdict).toBe('running');
    });

    it('is draft for a draft, never running, and needs no report', () => {
        const draft = record('draft', [task('a', 'pending')]);
        expect(batchStanding(draft, null)).toEqual({
            verdict: 'draft',
            fence: null,
            attention: [],
            verificationFailures: [],
        });
    });

    it.each([
        ['cancelled', { status: 'cancelled', cancelledAt: 'x' }],
        ['expired', { status: 'expired', expiredAt: 'x' }],
        ['cancelled', { status: 'running', cancelledAt: 'x' }],
        ['expired', { status: 'running', expiredAt: 'x' }],
    ] as const)('a %s fence outranks the tasks, whatever they are doing', (fence, over) => {
        for (const execution of ['succeeded', 'running', 'failed']) {
            const fenced = record(over.status, [task('a', execution, { waitReason: 'x' })], over);
            const standing = batchStanding(fenced, report(['a']));
            expect(standing.verdict).toBe('cancelled');
            expect(standing.fence).toBe(fence);
        }
    });

    it('is inconclusive when the report is unread, malformed or partial, never a terminal verdict', () => {
        const done = record('completed', [task('a', 'succeeded')]);
        const failed = record('running', [task('a', 'failed')]);
        for (const unread of [null, 'nope', [{ key: 'a' }], [{ key: 'a', next: {} }], [null], report(['other'])]) {
            expect(batchStanding(done, unread as never).verdict).toBe('inconclusive');
            expect(batchStanding(failed, unread as never).verdict).toBe('inconclusive');
        }
        const withFailure = record('running', [task('a', 'succeeded')], { verification: [verified('failed')] });
        expect(batchStanding(withFailure, null).verificationFailures).toHaveLength(1);
    });

    it('agrees with the long-poll hold verdict', () => {
        const progress = (state: Partial<Parameters<typeof batchWaitResult>[0]>) =>
            batchWaitResult({ complete: false, cancelled: false, expired: false, active: 0, waiting: 0, ...state });
        // Moving: the hold keeps waiting, and so does the standing.
        expect(progress({ active: 1 })).toBeNull();
        expect(batchStanding(record('running', [task('a', 'running')]), report(['a'])).verdict).toBe('running');
        expect(progress({ waiting: 1 })).toBeNull();
        expect(
            batchStanding(record('running', [task('a', 'succeeded', { pr: PR })]), report(['a'], 'wait')).verdict
        ).toBe('running');
        // Terminal: finished.
        expect(progress({ complete: true })).toBe('terminal');
        expect(batchStanding(record('completed', [task('a', 'succeeded')]), report(['a'])).verdict).toBe('succeeded');
        // Parked: nothing moves without an operator.
        expect(progress({})).toBe('parked');
        expect(batchStanding(record('running', [task('a', 'failed')]), report(['a'])).verdict).toBe('failed');
    });
});
