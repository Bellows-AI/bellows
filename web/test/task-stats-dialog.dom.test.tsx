import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JobActivity, ThreadActivity } from '../src/api/useJobActivity.js';
import { TaskStatsDialog } from '../src/components/TaskStatsDialog.js';
import { taskStats } from '../src/task-stats.js';
import { activityAnswer, fullTask, job, runUsage, taskUsage } from './tasks-fixtures.js';
import './dom.js';

/** The statistics modal's states (issue #848): which run it charts, and what it says when it has no figures. */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const REVIEW = '33333333-3333-4333-8333-333333333333';
const GONE = '44444444-4444-4444-8444-444444444444';

const tokens = { input: 5, output: 1, cacheRead: 2, cacheCreation: 0 };

const withBuckets = (answer: JobActivity): JobActivity => ({
    ...answer,
    bucketMs: 300_000,
    buckets: [{ start: '2026-09-01T12:00:00.000Z', tokens, edits: 0 }],
});

function open(jobs: Parameters<typeof taskStats>[0], activity: ThreadActivity) {
    render(<TaskStatsDialog open stats={taskStats(jobs, activity)} onClose={() => {}} />);
    return screen.getByRole('dialog', { name: 'Task statistics' });
}

describe('TaskStatsDialog', () => {
    it('charts the newest run, not the oldest answered one, once both runs are answered', () => {
        const task = taskUsage(A, [runUsage(A, 'run', tokens), runUsage(B, 'follow-up', tokens)]);
        const dialog = open([job({ id: A }), job({ id: B })], {
            [A]: withBuckets(activityAnswer(A, tokens, task)),
            [B]: withBuckets(activityAnswer(B, tokens, task)),
        });
        expect(within(dialog).getByRole('heading', { name: /Latest run \(Run 2\)/ })).toBeTruthy();
    });

    it('says nothing was measured when the board answered with no usage at all', () => {
        const dialog = open([job({ id: A })], { [A]: activityAnswer(A, null) });
        expect(within(dialog).getByText('No usage was measured for this selection.')).toBeTruthy();
    });

    it('marks the task provisional while a run is still going, though its block is not', () => {
        const task = taskUsage(A, [runUsage(A, 'run', tokens, { live: true })]);
        const dialog = open([job({ id: A, status: 'running', finishedAt: null })], {
            [A]: activityAnswer(A, tokens, task),
        });
        expect(within(dialog).getByText('Live: figures are provisional.')).toBeTruthy();
    });

    it('says usage is loading until a run is answered, and shows no figure meanwhile', () => {
        const dialog = open([job({ id: A }), job({ id: B })], {});
        expect(within(dialog).getByText('Loading usage…')).toBeTruthy();
        expect(dialog.querySelector('.task-stats-usage .usage-figures')).toBeNull();
    });

    it('shows an estimated task, its unlocated usage, a review, a gone run and the task-owned amount', () => {
        const dialog = open([job({ id: A })], { [A]: activityAnswer(A, tokens, fullTask(A, REVIEW, GONE)) });
        expect(within(dialog).getByText('Includes 1 review run.')).toBeTruthy();
        expect(dialog.querySelector('.task-stats-usage .usage-precision')).not.toBeNull();
        const diagnostics = within(dialog).getByRole('region', { name: 'Not in the figures above' });
        expect(diagnostics.textContent).toContain('usage whose time is unknown');
        expect(diagnostics.textContent).toContain('2 observations whose counting mode is unresolved');
        const rows = [...dialog.querySelectorAll('.task-stats-runs > table > tbody > tr[data-kind]')];
        expect(rows.map((row) => row.querySelector('th')?.textContent)).toEqual([
            expect.stringMatching(/^Run 1/),
            expect.stringMatching(/^Review of run 1 \(run no longer on the board\)/),
            expect.stringMatching(/^Earlier run \(run no longer on the board\)/),
        ]);
        const owned = within(dialog).getByRole('region', { name: 'Task-owned, not assigned to a run' });
        const reason = owned.querySelector('li[data-reason="no-segment"]')!;
        expect(reason.textContent).toContain('usage between runs of this task');
        // Each reason carries its own figures.
        expect(reason.querySelector('.usage-figures')).not.toBeNull();
    });
});
