import { describe, expect, it } from 'vitest';
import type { ThreadActivity } from '../src/api/useJobActivity.js';
import { figure } from '../src/components/usage/usage-format.js';
import { coverageNote, taskStats } from '../src/task-stats.js';
import { NO_TOKENS, activityAnswer, job, runUsage, taskUsage, usageBlock } from './tasks-fixtures.js';

/**
 * The task statistics read model (issues #530, #847, #848): the totals are the canonical task's usage
 * (review runs included, never re-summed from the thread), a missing measurement stays null (rendered
 * "—"), a measured zero stays 0, and a run still going marks the figures provisional.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const REVIEW = '33333333-3333-4333-8333-333333333333';

describe('taskStats', () => {
    it('takes the totals from task.usage, so a review absent from the thread is counted once and listed', () => {
        const task = taskUsage(A, [
            runUsage(A, 'run', { input: 100, output: 10, cacheRead: 1000, cacheCreation: 5 }),
            runUsage(B, 'follow-up', { input: 50, output: 5, cacheRead: 500, cacheCreation: 0 }),
            runUsage(REVIEW, 'review', { input: 7, output: 3 }, { reviewOf: B }),
        ]);
        const activity: ThreadActivity = {
            [A]: activityAnswer(A, { input: 100, output: 10, cacheRead: 1000, cacheCreation: 5 }, task),
            [B]: activityAnswer(B, { input: 50, output: 5, cacheRead: 500, cacheCreation: 0 }, task),
        };
        const stats = taskStats([job({ id: A, agentTurns: 3 }), job({ id: B, agentTurns: 4 })], activity);

        expect(stats.usage?.tokens).toEqual({ input: 157, output: 18, cacheRead: 1500, cacheCreation: 5 });
        expect(stats.reviews).toBe(1);
        expect(stats.agentTurns).toEqual({ value: 7, measured: 2, runs: 2 });
        expect(stats.runs.map((run) => run.label)).toEqual(['Run 1', 'Run 2', 'Review of run 2']);
        expect(stats.runs.map((run) => run.kind)).toEqual(['run', 'follow-up', 'review']);
        expect(stats.runs[2]!.operational).toBe(false);
        expect(stats.provisional).toBe(false);
        expect(stats.telemetry).toBe('measured');
    });

    it('reads the task total, not the latest run or a re-sum of the runs', () => {
        const task = taskUsage(A, [runUsage(A, 'run', { input: 100 })], {
            block: { tokens: { ...NO_TOKENS, input: 999 } },
        });
        const stats = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 100 }, task) });
        expect(stats.usage?.tokens.input).toBe(999);
        expect(stats.runs[0]!.usage?.tokens.input).toBe(100);
    });

    it('keeps a shared-session follow-up as its own row of the thread', () => {
        const task = taskUsage(A, [runUsage(A, 'run', { input: 10 }), runUsage(B, 'follow-up', { input: 20 })]);
        const stats = taskStats([job({ id: A }), job({ id: B })], { [B]: activityAnswer(B, { input: 20 }, task) });
        expect(stats.runs.map((run) => [run.label, run.kind, run.usage?.tokens.input])).toEqual([
            ['Run 1', 'run', 10],
            ['Run 2', 'follow-up', 20],
        ]);
    });

    it('shows the run-unassigned amount as its own row, not as a run', () => {
        const owned = usageBlock(
            { input: 5 },
            { unassigned: [{ reason: 'no-segment', tokens: { ...NO_TOKENS, input: 5 } }] }
        );
        const task = taskUsage(A, [runUsage(A, 'run', { input: 10 })], { taskOwned: owned });
        const stats = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 10 }, task) });
        expect(stats.taskOwned).toBe(owned);
        expect(stats.runs).toHaveLength(1);
        expect(stats.usage?.tokens.input).toBe(15);
    });

    it('marks a run whose job row is gone', () => {
        const gone = runUsage(REVIEW, 'run', { input: 1 }, { operational: false });
        const task = taskUsage(A, [runUsage(A, 'run', { input: 10 }), gone]);
        const stats = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 10 }, task) });
        expect(stats.runs.map((run) => [run.label, run.operational])).toEqual([
            ['Run 1', true],
            ['Earlier run', false],
        ]);
    });

    it('counts an adopted run once: the same job under a second claim adds no run and no usage', () => {
        const first = runUsage(A, 'run', { input: 10 });
        const base = taskUsage(A, [first]);
        const adopted = { ...base, runs: [first, { ...first, endedAt: '2026-09-01T12:09:00.000Z' }] };
        const before = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 10 }, base) });
        const after = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 10 }, adopted) });
        expect(after.runs.map((run) => run.id)).toEqual([A]);
        expect(after.runs[0]!.usage).toEqual(before.runs[0]!.usage);
    });

    it('names the newest thread run as the latest, however many earlier runs were answered', () => {
        const task = taskUsage(A, [runUsage(A, 'run', { input: 1 }), runUsage(B, 'follow-up', { input: 2 })]);
        const stats = taskStats([job({ id: A }), job({ id: B })], {
            [A]: activityAnswer(A, { input: 1 }, task),
            [B]: activityAnswer(B, { input: 2 }, task),
        });
        expect(stats.latest?.id).toBe(B);
        expect(taskStats([], {}).latest).toBeNull();
    });

    it('tells a measured zero from an unmeasured figure, per run and per type', () => {
        const task = taskUsage(A, [runUsage(A, 'run', { input: 0 }), runUsage(B, 'follow-up', null)]);
        const activity: ThreadActivity = {
            [A]: activityAnswer(A, { input: 0 }, task),
            [B]: activityAnswer(B, null, task),
        };
        const stats = taskStats([job({ id: A, agentTurns: 0 }), job({ id: B, agentTurns: null })], activity);
        expect(stats.agentTurns.value).toBe(0);
        expect(stats.usage?.tokens).toEqual({ ...NO_TOKENS, input: 0 });
        expect(stats.runs.map((run) => run.telemetry)).toEqual(['measured', 'none']);
        expect(stats.runs[0]!.usage?.tokens).toEqual({ ...NO_TOKENS, input: 0 });
        expect(coverageNote('Agent turns', stats.agentTurns)).toBe('Agent turns measured for 1 of 2 runs.');
        expect(figure(stats.runs[1]!.agentTurns)).toBe('—');
        expect(figure(stats.runs[0]!.agentTurns)).toBe('0');
        expect(figure(stats.usage!.tokens.output)).toBe('—');
    });

    it('keeps the task unreadable, not zero, when nothing was answered, and separates loading from unavailable', () => {
        const loading = taskStats([job({ id: A }), job({ id: B })], {});
        expect(loading.telemetry).toBe('loading');
        const refused = taskStats([job({ id: A }), job({ id: B })], { [B]: 'unavailable', [A]: 'unavailable' });
        expect(refused.usage).toBeNull();
        expect(refused.agentTurns.value).toBeNull();
        expect(refused.telemetry).toBe('unavailable');
        expect(refused.runs.map((run) => run.telemetry)).toEqual(['unavailable', 'unavailable']);
    });

    it('reads every run of the thread from the task carried by the newest run answer alone', () => {
        const task = taskUsage(A, [runUsage(A, 'run', { input: 100 }), runUsage(B, 'follow-up', null)]);
        const stats = taskStats([job({ id: A }), job({ id: B })], { [B]: activityAnswer(B, null, task) });
        expect(stats.runs.map((run) => run.telemetry)).toEqual(['measured', 'none']);
        expect(stats.runs[0]!.usage?.tokens).toEqual({ ...NO_TOKENS, input: 100 });
        expect(stats.runs[1]!.usage?.state).toBe('unmeasured');
    });

    it('marks a run still going, or a provisional task block, as provisional', () => {
        const live = taskStats([job({ id: A, status: 'running', finishedAt: null })], {});
        expect(live.provisional).toBe(true);
        expect(live.runs[0]!.live).toBe(true);
        const task = taskUsage(A, [runUsage(A, 'run', { input: 1 })], { block: { provisional: true } });
        const done = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 1 }, task) });
        expect(done.provisional).toBe(true);
    });

    it('carries per-type partial coverage and precision from the block, never re-derived', () => {
        const block = {
            coverage: {
                input: { measured: 1, contributors: 2 },
                output: { measured: 2, contributors: 2 },
                cacheRead: { measured: 2, contributors: 2 },
                cacheCreation: { measured: 0, contributors: 2 },
            },
        };
        const task = taskUsage(A, [runUsage(A, 'run', { input: 1 })], { block });
        const stats = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 1 }, task) });
        expect(stats.usage?.coverage.input).toEqual({ measured: 1, contributors: 2 });
    });
});
