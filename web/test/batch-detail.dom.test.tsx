import { BATCH_COMPLETION_ACCEPTED, type BatchPlan } from '@factory-ai/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BATCH_POLL_MS } from '../src/api/useBatches.js';
import {
    addStage,
    addTask,
    blankPlan,
    type BatchRecord,
    type BatchReportView,
    type BatchTaskState,
    updateTask,
} from '../src/batch-model.js';
import { renderApp, stubFetch } from './dom.js';

/**
 * The started batch page, mounted on its route over a stubbed board: parallel progress, the human
 * gate, retry, the automatic continuation, cancellation and accept are each readable and operable.
 * The board below answers the way `server/src/routes/batches.ts` does — every control is a request
 * and the page reads the answer back. The cross-page journey (draft → save → start → task-page
 * backlink → list) stays in `e2e/batches.spec.ts`.
 */

const ID = '0f6a5b1c-2d3e-4b1f-8a6d-4e0f9a510000';
const PR = 'https://github.com/acme/widgets/pull/9';

const filled = (plan: BatchPlan, key: string): BatchPlan =>
    updateTask(plan, key, (task) => ({
        ...task,
        objective: `${key}: do it`,
        acceptance: `${key}: it works`,
        verification: 'npm test',
    }));

/** Two tasks in stage 1, one in stage 2 — the plan the e2e journey drafts. */
function twoStagePlan(): BatchPlan {
    const plan = addStage(
        addTask({ ...blankPlan('acme/widgets'), title: 'Upgrade the SDK', concurrency: 2 }, 'stage-1')
    );
    return ['task-1', 'task-2', 'task-3'].reduce(filled, plan);
}

const state = (key: string, stage: string, over: Partial<BatchTaskState> = {}): BatchTaskState => ({
    key,
    stage,
    execution: 'pending',
    pr: 'none',
    gate: 'open',
    waitReason: null,
    rootJobId: null,
    attempt: 1,
    ...over,
});

function started(plan: BatchPlan, tasks: BatchTaskState[], activeStage: string | null = 'stage-1'): BatchRecord {
    return {
        id: ID,
        status: 'running',
        version: 3,
        createdBy: null,
        startedBy: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        startedAt: '2026-09-01T00:00:00.000Z',
        cancelledAt: null,
        completedAt: null,
        expiredAt: null,
        activeStage,
        plan,
        tasks,
        verification: [],
    };
}

/** The board's batch routes over one held record and its report; writes mutate the record the way the store does. */
function board(initial: BatchRecord, initialReport: BatchReportView | null = { state: 'running', tasks: [] }) {
    let record = initial;
    /** Null answers the report read with a 404, the way a failed read lands. */
    let report = initialReport;
    const patchTask = (key: string, change: (task: BatchTaskState) => BatchTaskState) => {
        record = { ...record, tasks: record.tasks.map((task) => (task.key === key ? change(task) : task)) };
        return record;
    };
    const calls = stubFetch(({ method, url }) => {
        const prefix = `/api/batches/${ID}`;
        if (!url.startsWith(prefix)) return;
        const [action, key, taskAction] = url.slice(prefix.length).split('/').filter(Boolean);
        if (method === 'GET') return action === 'report' ? (report ?? undefined) : record;
        if (action === 'cancel') {
            record = {
                ...record,
                status: 'cancelled',
                cancelledAt: '2026-09-01T01:00:00.000Z',
                tasks: record.tasks.map((task) =>
                    ['queued', 'running', 'pending'].includes(task.execution)
                        ? { ...task, execution: 'cancelled' }
                        : task
                ),
            };
            return record;
        }
        if (action === 'tasks' && key && taskAction === 'retry') {
            return patchTask(key, (task) => ({
                ...task,
                execution: 'queued',
                gate: 'open',
                waitReason: null,
                attempt: task.attempt + 1,
            }));
        }
        if (action === 'tasks' && key && taskAction === 'accept') {
            return patchTask(key, (task) => ({ ...task, gate: 'passed', waitReason: null }));
        }
    });
    const writes = () => calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.url}`);
    return {
        writes,
        /** What the scheduler would write between two polls. */
        set: (next: BatchRecord) => {
            record = next;
        },
        /** The next report the board assembles; null fails the read. */
        setReport: (next: BatchReportView | null) => {
            report = next;
        },
    };
}

const headerPill = async (label: string) =>
    waitFor(() => expect(document.querySelector('.page-header-meta .pill')?.textContent).toBe(label));
const stage = (n: number) => screen.getByRole('region', { name: `Stage ${n}` });
const card = (key: string) => document.querySelector(`[data-task="${key}"]`) as HTMLElement;

describe('a started batch', () => {
    it('shows two tasks of a stage running at once', async () => {
        const plan = twoStagePlan();
        board(
            started(plan, [
                state('task-1', 'stage-1', { execution: 'running' }),
                state('task-2', 'stage-1', { execution: 'running' }),
                state('task-3', 'stage-2'),
            ])
        );
        renderApp(`/batches/${ID}`);
        await headerPill('Running');
        expect(within(stage(1)).getAllByText('Running', { selector: '.batch-task .pill-ok' })).toHaveLength(2);
    });

    it('shows a failed stage verification as needing a person, and clears it once the board passes it', async () => {
        const plan = twoStagePlan();
        const tasks = [
            state('task-1', 'stage-1', { execution: 'succeeded', pr: PR, gate: 'passed' }),
            state('task-2', 'stage-1', { execution: 'succeeded', pr: PR, gate: 'passed' }),
            state('task-3', 'stage-2'),
        ];
        const verification = (state: string) => [
            {
                stage: 'stage-1',
                state,
                detail: 'checks on main at cd89f3d2 fail: e2e failing',
                headSha: 'cd89f3d2aabbccdd',
                checkedAt: '2026-09-01T00:30:00.000Z',
            },
        ];
        const fake = board({ ...started(plan, tasks), verification: verification('failed') });
        renderApp(`/batches/${ID}`);
        await headerPill('Needs attention');
        const notice = stage(1).querySelector('[data-verification="failed"]')!;
        expect(notice.textContent).toContain('checks on main at cd89f3d2 fail: e2e failing');
        expect(notice.textContent).toContain('cd89f3d2');
        expect(screen.getByText(/1 need you/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();

        fake.set({ ...started(plan, tasks), verification: verification('pending') });
        await waitFor(() => expect(document.querySelector('[data-verification="pending"]')).not.toBeNull(), {
            timeout: 8000,
        });
        expect(document.querySelector('[data-verification="failed"]')).toBeNull();
        await headerPill('Running');

        fake.set({ ...started(plan, tasks), verification: verification('passed') });
        await waitFor(() => expect(document.querySelector('[data-verification]')).toBeNull(), { timeout: 8000 });
        expect(screen.getByText(/0 need you/)).toBeTruthy();
    });

    it('at the human gate names the pull request and says the next stage starts by itself', async () => {
        const plan = twoStagePlan();
        board(
            started(plan, [
                state('task-1', 'stage-1', {
                    execution: 'succeeded',
                    pr: PR,
                    waitReason: `waiting for a person to merge ${PR}`,
                }),
                state('task-2', 'stage-1', { execution: 'failed' }),
                state('task-3', 'stage-2'),
            ])
        );
        renderApp(`/batches/${ID}`);
        await headerPill('Needs attention');
        const one = within(stage(1));
        expect(one.getByRole('note').textContent).toContain('Human review gate.');
        expect(one.getByRole('note').textContent).toContain('next stage starts automatically');
        expect(one.getByText('Review and merge the pull request.')).toBeTruthy();
        expect(one.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe(PR);
    });

    it('reads an automerge PR the board is still merging as the board’s, from the report’s next step (#693)', async () => {
        const plan = twoStagePlan();
        const merging = state('task-1', 'stage-1', {
            execution: 'succeeded',
            pr: PR,
            waitReason: `waiting for the board to merge ${PR}`,
        });
        const rest = [state('task-2', 'stage-1', { execution: 'running' }), state('task-3', 'stage-2')];
        const entry = (task: BatchTaskState) => ({ key: task.key, execution: task.execution, attempts: task.attempt });
        const reportOf = (reportState: string, first: BatchReportView['tasks'][number]['next']): BatchReportView => ({
            state: reportState,
            tasks: [
                { ...entry(merging), next: first },
                ...rest.map((task) => ({ ...entry(task), next: { action: 'wait' as const } })),
            ],
        });
        const boardOn = reportOf('running', { action: 'wait' });
        const fake = board(started(plan, [merging, ...rest]), boardOn);
        const label = (text: string) =>
            waitFor(() => expect(within(card('task-1')).getByText(text)).toBeTruthy(), { timeout: 8000 });
        renderApp(`/batches/${ID}`);
        await label('Board merging');
        await headerPill('Running');
        expect(within(card('task-1')).queryByText('Waiting for you')).toBeNull();
        expect(screen.queryByText('Review and merge the pull request.')).toBeNull();
        expect(screen.getByText(/0 need you/)).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Needs you' })).toBeNull();

        // A failed report read drops the last report: the record's own rule speaks until one lands again.
        fake.setReport(null);
        await label('Waiting for you');
        await headerPill('Needs attention');
        fake.setReport(boardOn);
        await label('Board merging');
        await headerPill('Running');

        // The board hands the PR to a person and the batch parks: the card and the count follow `next`.
        fake.setReport(reportOf('parked', { action: 'merge', url: PR }));
        await label('Waiting for you');
        await headerPill('Needs attention');
        expect(within(card('task-1')).getByText('Review and merge the pull request.')).toBeTruthy();
        expect(screen.getByText(/1 need you/)).toBeTruthy();

        // A parked batch still moves: the next report is read, here a repair that failed.
        const failed = { ...merging, execution: 'failed', waitReason: null, attempt: 2 };
        fake.set(started(plan, [failed, ...rest]));
        const retry = {
            action: 'retry' as const,
            method: 'POST' as const,
            path: `/api/batches/${ID}/tasks/task-1/retry`,
        };
        fake.setReport({
            state: 'parked',
            tasks: [
                { ...entry(failed), next: retry },
                ...rest.map((task) => ({ ...entry(task), next: { action: 'wait' as const } })),
            ],
        });
        await label('Failed');
        await headerPill('Needs attention');
        expect(screen.getByRole('button', { name: 'Retry task-1' })).toBeTruthy();
    }, 40_000);

    it('retries a failed task through the board, and the retry reads as a new attempt', async () => {
        const plan = twoStagePlan();
        const fake = board(
            started(plan, [
                state('task-1', 'stage-1', { execution: 'succeeded', pr: PR, waitReason: 'waiting for a merge' }),
                state('task-2', 'stage-1', { execution: 'failed' }),
                state('task-3', 'stage-2'),
            ])
        );
        renderApp(`/batches/${ID}`);
        await userEvent.click(await screen.findByRole('button', { name: 'Retry task-2' }));
        await waitFor(() => expect(card('task-2').textContent).toContain('Attempt 2'));
        expect(card('task-2').querySelector('.pill-ok')?.textContent).toBe('Queued');
        expect(fake.writes()).toEqual([`POST /api/batches/${ID}/tasks/task-2/retry`]);
    });

    it('continues into the next stage on the next poll, with nobody pressing anything', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        const plan = twoStagePlan();
        const gate = { execution: 'succeeded', pr: PR, waitReason: `waiting for a person to merge ${PR}` };
        const fake = board(
            started(plan, [
                state('task-1', 'stage-1', gate),
                state('task-2', 'stage-1', gate),
                state('task-3', 'stage-2'),
            ])
        );
        renderApp(`/batches/${ID}`);
        await headerPill('Needs attention');
        expect(stage(2).classList.contains('is-active')).toBe(false);

        const merged = { execution: 'succeeded', gate: 'passed', waitReason: null, pr: PR };
        fake.set(
            started(
                plan,
                [
                    state('task-1', 'stage-1', merged),
                    state('task-2', 'stage-1', merged),
                    state('task-3', 'stage-2', { execution: 'running' }),
                ],
                'stage-2'
            )
        );
        await act(() => vi.advanceTimersByTimeAsync(BATCH_POLL_MS));
        await waitFor(() => expect(stage(2).classList.contains('is-active')).toBe(true));
        expect(stage(1).textContent).toContain('2/2 accepted');
        expect(screen.getByRole('region', { name: 'Report' }).textContent).toContain('Merged so far');
        expect(fake.writes()).toEqual([]);
    });

    it('cancels only once confirmed, then is history with no more controls', async () => {
        const plan = twoStagePlan();
        const fake = board(
            started(
                plan,
                [
                    state('task-1', 'stage-1', { execution: 'succeeded', gate: 'passed', pr: PR }),
                    state('task-2', 'stage-1', { execution: 'succeeded', gate: 'passed', pr: PR }),
                    state('task-3', 'stage-2', { execution: 'running' }),
                ],
                'stage-2'
            )
        );
        renderApp(`/batches/${ID}`);
        await userEvent.click(await screen.findByRole('button', { name: 'Cancel batch' }));
        expect(document.querySelector('.banner-warn')?.textContent).toContain('Merged pull requests stay merged');
        expect(fake.writes()).toEqual([]);

        await userEvent.click(screen.getByRole('button', { name: 'Confirm cancel' }));
        await headerPill('Cancelled');
        expect(screen.queryByRole('button', { name: 'Cancel batch' })).toBeNull();
        expect(fake.writes()).toEqual([`POST /api/batches/${ID}/cancel`]);
    });

    it('accepts a task done when a person accepts it, from its card', async () => {
        const plan = updateTask(
            filled({ ...blankPlan('acme/widgets'), title: 'Manual check' }, 'task-1'),
            'task-1',
            (task) => ({
                ...task,
                completion: { kind: BATCH_COMPLETION_ACCEPTED, condition: 'the dashboard loads' },
            })
        );
        const fake = board(
            started(plan, [
                state('task-1', 'stage-1', {
                    execution: 'succeeded',
                    waitReason: 'waiting for acceptance: the dashboard loads',
                }),
            ])
        );
        renderApp(`/batches/${ID}`);
        await userEvent.click(await screen.findByRole('button', { name: 'Accept task-1' }));
        await waitFor(() => expect(card('task-1').querySelector('.pill-done')?.textContent).toBe('Accepted'));
        expect(card('task-1').textContent).not.toContain('Waiting:');
        expect(fake.writes()).toEqual([`POST /api/batches/${ID}/tasks/task-1/accept`]);
    });
});
