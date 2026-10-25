import { validateBatchPlan, type BatchPlan } from '@factory-ai/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
    blankPlan,
    GATE_RESUMES_AUTOMATICALLY,
    updateTask,
    type BatchRecord,
    type BatchReportView,
} from '../src/batch-model.js';
import { BatchEditor } from '../src/panels/BatchEditor.js';
import { BatchMonitor } from '../src/panels/BatchMonitor.js';
import { BatchPlanReview } from '../src/panels/BatchPlanReview.js';
import { usageBlock } from './tasks-fixtures.js';

/**
 * Render smoke for the batch panels: the markup carries the human gate sentence, the PR to
 * merge, the inherited/overridden marks and the path-addressed issues. It cannot say the page
 * looks right — `e2e/batches.spec.ts` does, in a real browser.
 */

const PR = 'https://github.com/acme/widgets/pull/9';

const plan = (): BatchPlan =>
    updateTask({ ...blankPlan('acme/widgets'), title: 'Upgrade' }, 'task-1', (task) => ({
        ...task,
        objective: 'Bump the dependency',
        acceptance: 'It builds',
        verification: 'npm test',
    }));

const started = (over: Partial<BatchRecord> = {}): BatchRecord => ({
    id: 'b1',
    status: 'running',
    version: 2,
    createdBy: null,
    startedBy: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    startedAt: '2026-09-01T00:00:00.000Z',
    cancelledAt: null,
    completedAt: null,
    expiredAt: null,
    activeStage: 'stage-1',
    plan: plan(),
    verification: [],
    tasks: [
        {
            key: 'task-1',
            stage: 'stage-1',
            execution: 'succeeded',
            pr: PR,
            gate: 'open',
            waitReason: `waiting for a person to merge ${PR}`,
            rootJobId: '4b1f0c2e-8a6d-4e0f-9a51-0f6a5b1c2d3e',
            attempt: 1,
        },
    ],
    ...over,
});

const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const noop = async () => null;

describe('the batch monitor', () => {
    it('names the pull request to merge and says the gate resumes by itself', () => {
        const html = render(
            <BatchMonitor
                batch={started()}
                report={null}
                reportFailed={false}
                onRetry={noop}
                onAccept={noop}
                pending={null}
            />
        );
        expect(html).toContain('Human review gate.');
        expect(html).toContain(GATE_RESUMES_AUTOMATICALLY);
        expect(html).toContain('Review and merge the pull request.');
        expect(html).toContain(`href="${PR}"`);
        expect(html).toContain('href="/tasks/4b1f0c2e-8a6d-4e0f-9a51-0f6a5b1c2d3e"');
        expect(html).toContain('Waiting for you');
    });

    it('offers Retry for a failed task and Accept for an accepted-completion task, only in the active stage', () => {
        const failed = started({
            tasks: [{ ...started().tasks[0]!, execution: 'failed', pr: 'none', waitReason: null }],
        });
        expect(
            render(
                <BatchMonitor
                    batch={failed}
                    report={null}
                    reportFailed={false}
                    onRetry={noop}
                    onAccept={noop}
                    pending={null}
                />
            )
        ).toContain('Retry task-1');
        const acceptedPlan = updateTask(plan(), 'task-1', (task) => ({
            ...task,
            completion: { kind: 'accepted', condition: 'the page loads' },
        }));
        const waiting = started({
            plan: acceptedPlan,
            tasks: [{ ...started().tasks[0]!, pr: 'none', waitReason: 'waiting for acceptance: the page loads' }],
        });
        const html = render(
            <BatchMonitor
                batch={waiting}
                report={null}
                reportFailed={false}
                onRetry={noop}
                onAccept={noop}
                pending={null}
            />
        );
        expect(html).toContain('Accept task-1');
        expect(html).toContain('the page loads');
        const later = started({ plan: acceptedPlan, activeStage: 'stage-2', tasks: waiting.tasks });
        expect(
            render(
                <BatchMonitor
                    batch={later}
                    report={null}
                    reportFailed={false}
                    onRetry={noop}
                    onAccept={noop}
                    pending={null}
                />
            )
        ).not.toContain('Accept task-1');
    });

    it('renders measured usage as figures, and a failed report read as unavailable beside Retry', () => {
        const measuredReport: BatchReportView = {
            state: 'running',
            tasks: [],
            usageSnapshotAt: '2026-09-01T00:10:00.000Z',
            totals: {
                tokenUsage: usageBlock({ input: 1200, output: 340, cacheRead: 0, cacheCreation: 5 }),
                usageUnavailableTasks: 0,
            },
        };
        const props = { onRetry: noop, onAccept: noop, pending: null };
        const html = render(<BatchMonitor batch={started()} report={measuredReport} reportFailed={false} {...props} />);
        expect(html).toContain('Token usage');
        expect(html).toContain('1,200');
        const failed = started({
            tasks: [{ ...started().tasks[0]!, execution: 'failed', pr: 'none', waitReason: null }],
        });
        const down = render(<BatchMonitor batch={failed} report={null} reportFailed={true} {...props} />);
        expect(down).toContain('Usage is unavailable');
        expect(down).toContain('Retry task-1');
    });

    it('reports partial progress with the merged pull requests', () => {
        const done = started({ tasks: [{ ...started().tasks[0]!, gate: 'passed', waitReason: null, attempt: 2 }] });
        const html = render(
            <BatchMonitor
                batch={done}
                report={null}
                reportFailed={false}
                onRetry={noop}
                onAccept={noop}
                pending={null}
            />
        );
        expect(html).toContain('1 of 1 tasks accepted');
        expect(html).toContain('Merged so far');
        expect(html).toContain('repaired, attempt 2');
    });
});

describe('the pre-launch review', () => {
    it('marks every effective value inherited or overridden', () => {
        const html = render(<BatchPlanReview plan={{ ...plan(), executor: 'claude' }} />);
        expect(html).toContain('Before launch');
        expect(html).toContain('inherited');
        const overridden = updateTask(plan(), 'task-1', (task) => ({ ...task, executor: 'codex' }));
        expect(render(<BatchPlanReview plan={overridden} />)).toContain('overridden');
    });
});

describe('the draft editor', () => {
    it('shows each issue at the field it names, marked invalid', () => {
        const checked = validateBatchPlan(blankPlan('acme/widgets'));
        if (checked.ok) throw new Error('a blank plan must be refused');
        const html = render(
            <BatchEditor
                plan={blankPlan('acme/widgets')}
                onChange={() => {}}
                issues={checked.issues}
                repos={[]}
                disabled={false}
            />
        );
        expect(html).toContain('aria-invalid="true"');
        expect(html).toContain('must be a non-empty string');
        expect(html).toContain('Add task to stage 1');
        expect(html).toContain('These tasks run in parallel');
    });
});
