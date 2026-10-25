import { describe, expect, it } from 'vitest';
import type { ThreadActivity } from '../src/api/useJobActivity.js';
import { coverageNote, figure, taskStats } from '../src/task-stats.js';
import { NO_TOKENS, activityAnswer, job, runUsage, taskUsage } from './tasks-fixtures.js';

/**
 * The task statistics read model (issue #530, #847): the totals are the canonical task's usage (review
 * runs included, never re-summed from the thread), a missing measurement stays null (rendered "—"), a
 * measured zero stays 0, and a run still going marks the totals provisional.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const REVIEW = '33333333-3333-4333-8333-333333333333';

describe('taskStats', () => {
    it('takes the totals from the canonical task, so a review absent from the thread is counted once', () => {
        const task = taskUsage(A, [
            runUsage(A, 'run', { input: 100, output: 10, cacheRead: 1000, cacheCreation: 5 }),
            runUsage(B, 'follow-up', { input: 50, output: 5, cacheRead: 500, cacheCreation: 0 }),
            runUsage(REVIEW, 'review', { input: 7, output: 3 }),
        ]);
        const activity: ThreadActivity = {
            [A]: activityAnswer(A, { input: 100, output: 10, cacheRead: 1000, cacheCreation: 5 }, task),
            [B]: activityAnswer(B, { input: 50, output: 5, cacheRead: 500, cacheCreation: 0 }, task),
        };
        const stats = taskStats([job({ id: A, agentTurns: 3 }), job({ id: B, agentTurns: 4 })], activity);

        expect(stats.tokens.value).toEqual({ input: 157, output: 18, cacheRead: 1500, cacheCreation: 5 });
        expect(stats.reviews).toBe(1);
        expect(stats.agentTurns).toEqual({ value: 7, measured: 2, runs: 2 });
        expect(stats.runs.map((run) => run.number)).toEqual([1, 2]);
        expect(stats.provisional).toBe(false);
        expect(coverageNote('Tokens', stats.tokens)).toBeNull();
    });

    it('tells a measured zero from an unmeasured figure, per run and per type', () => {
        const task = taskUsage(A, [runUsage(A, 'run', { input: 0 }), runUsage(B, 'follow-up', null)]);
        const activity: ThreadActivity = {
            [A]: activityAnswer(A, { input: 0 }, task),
            [B]: activityAnswer(B, null, task),
        };
        const stats = taskStats([job({ id: A, agentTurns: 0 }), job({ id: B, agentTurns: null })], activity);
        expect(stats.agentTurns.value).toBe(0);
        expect(stats.tokens.value).toEqual({ ...NO_TOKENS, input: 0 });
        expect(stats.runs.map((run) => run.telemetry)).toEqual(['measured', 'none']);
        expect(stats.runs[0]!.tokens).toEqual({ ...NO_TOKENS, input: 0 });
        // Partial: the totals say how many runs they cover instead of presenting as complete.
        expect(coverageNote('Tokens', stats.tokens)).toBe('Tokens measured for 1 of 2 runs.');
        expect(coverageNote('Agent turns', stats.agentTurns)).toBe('Agent turns measured for 1 of 2 runs.');
        expect(figure(stats.runs[1]!.agentTurns)).toBe('—');
        expect(figure(stats.runs[0]!.agentTurns)).toBe('0');
        expect(figure(stats.tokens.value!.output)).toBe('—');
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
