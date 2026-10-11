import { describe, expect, it } from 'vitest';
import type { JobActivity, ThreadActivity, TokenTypes } from '../src/api/useJobActivity.js';
import { coverageNote, figure, taskStats } from '../src/task-stats.js';
import { job } from './tasks-fixtures.js';

/**
 * The task statistics read model (issue #530): the totals are sums over what was MEASURED, a
 * missing measurement stays null (rendered "—"), a measured zero stays 0, and a run still going
 * marks the totals provisional.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const tokens = (input: number, output = 0, cacheRead = 0, cacheCreation = 0): TokenTypes => ({
    input,
    output,
    cacheRead,
    cacheCreation,
});

const answer = (jobId: string, totals: TokenTypes | null): JobActivity => ({
    jobId,
    sessionId: 'session',
    from: null,
    to: null,
    bucketMs: null,
    buckets: [],
    totals,
});

describe('taskStats', () => {
    it('sums token types and agent turns apart over a follow-up thread', () => {
        const activity: ThreadActivity = {
            [A]: answer(A, tokens(100, 10, 1000, 5)),
            [B]: answer(B, tokens(50, 5, 500, 0)),
        };
        const stats = taskStats([job({ id: A, agentTurns: 3 }), job({ id: B, agentTurns: 4 })], activity);
        expect(stats.tokens.value).toEqual(tokens(150, 15, 1500, 5));
        expect(stats.agentTurns).toEqual({ value: 7, measured: 2, runs: 2 });
        expect(stats.runs.map((run) => run.number)).toEqual([1, 2]);
        expect(stats.provisional).toBe(false);
        expect(coverageNote('Tokens', stats.tokens)).toBeNull();
    });

    it('tells a measured zero from an unmeasured figure', () => {
        const activity: ThreadActivity = { [A]: answer(A, tokens(0)), [B]: answer(B, null) };
        const stats = taskStats([job({ id: A, agentTurns: 0 }), job({ id: B, agentTurns: null })], activity);
        expect(stats.agentTurns.value).toBe(0);
        expect(stats.tokens.value).toEqual(tokens(0));
        expect(stats.runs.map((run) => run.telemetry)).toEqual(['measured', 'none']);
        // Partial: the totals say how many runs they cover instead of presenting as complete.
        expect(coverageNote('Tokens', stats.tokens)).toBe('Tokens measured for 1 of 2 runs.');
        expect(coverageNote('Agent turns', stats.agentTurns)).toBe('Agent turns measured for 1 of 2 runs.');
        expect(figure(stats.runs[1]!.agentTurns)).toBe('—');
        expect(figure(stats.runs[0]!.agentTurns)).toBe('0');
    });

    it('keeps every total null when nothing was measured, and separates loading from unavailable', () => {
        const stats = taskStats([job({ id: A }), job({ id: B })], { [B]: 'unavailable' });
        expect(stats.tokens.value).toBeNull();
        expect(stats.agentTurns.value).toBeNull();
        expect(stats.runs.map((run) => run.telemetry)).toEqual(['loading', 'unavailable']);
        expect(stats.loading).toBe(true);
    });

    it('marks a run still going as provisional', () => {
        const stats = taskStats([job({ id: A, status: 'running', finishedAt: null })], {});
        expect(stats.provisional).toBe(true);
        expect(stats.runs[0]!.live).toBe(true);
    });
});
