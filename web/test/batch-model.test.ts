import { validateBatchPlan, type BatchPlan } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import {
    addStage,
    addTask,
    batchVerdict,
    blankPlan,
    canRetry,
    gateInstruction,
    moveStage,
    morningReport,
    nextKey,
    removeStage,
    removeTask,
    retryLabel,
    stagePolicyOf,
    summaryVerdict,
    taskExecutorOf,
    taskStateLabel,
    updateTask,
    withOptional,
    type BatchRecord,
    type BatchTaskState,
} from '../src/batch-model.js';

const state = (over: Partial<BatchTaskState> = {}): BatchTaskState => ({
    key: 'task-1',
    stage: 'stage-1',
    execution: 'pending',
    pr: 'none',
    gate: 'open',
    waitReason: null,
    rootJobId: null,
    attempt: 0,
    ...over,
});

const filled = (): BatchPlan => {
    const plan = blankPlan('acme/widgets');
    return updateTask({ ...plan, title: 'Upgrade' }, 'task-1', (task) => ({
        ...task,
        objective: 'Bump it',
        acceptance: 'Builds',
        verification: 'npm test',
    }));
};

const record = (over: Partial<BatchRecord> = {}): BatchRecord => ({
    id: 'b1',
    status: 'started',
    version: 2,
    createdBy: null,
    startedBy: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    startedAt: '2026-09-01T00:00:00.000Z',
    cancelledAt: null,
    completedAt: null,
    activeStage: 'stage-1',
    plan: filled(),
    tasks: [state()],
    ...over,
});

describe('the draft edits', () => {
    it('starts from a plan the shared validator accepts once the text is filled', () => {
        expect(validateBatchPlan(filled()).ok).toBe(true);
        const blank = validateBatchPlan(blankPlan('acme/widgets'));
        expect(blank.ok ? [] : blank.issues.map((issue) => issue.path)).toContain('title');
    });

    it('mints keys that never collide, across stages for tasks', () => {
        expect(nextKey('task', ['task-1', 'task-3'])).toBe('task-2');
        const plan = addTask(addStage(filled()), 'stage-1');
        const keys = plan.stages.flatMap((stage) => stage.tasks.map((task) => task.key));
        expect(new Set(keys).size).toBe(keys.length);
        expect(plan.stages.map((stage) => stage.key)).toEqual(['stage-1', 'stage-2']);
    });

    it('reorders, removes and never mutates its input', () => {
        const base = addStage(filled());
        const snapshot = JSON.stringify(base);
        expect(moveStage(base, 'stage-2', -1).stages.map((stage) => stage.key)).toEqual(['stage-2', 'stage-1']);
        expect(moveStage(base, 'stage-1', -1)).toBe(base);
        expect(removeStage(base, 'stage-1').stages).toHaveLength(1);
        expect(removeTask(base, 'task-1').stages[0]!.tasks).toEqual([]);
        expect(JSON.stringify(base)).toBe(snapshot);
    });

    it('drops an optional field when emptied, because the plan refuses an empty string', () => {
        const withExecutor = withOptional(filled(), 'executor', 'codex');
        expect(withExecutor.executor).toBe('codex');
        expect('executor' in withOptional(withExecutor, 'executor', '')).toBe(false);
    });
});

describe('inherited versus overridden', () => {
    it('marks a stage policy and a task executor by where the value came from', () => {
        const plan: BatchPlan = {
            ...filled(),
            executor: 'claude',
            stages: [
                {
                    key: 'stage-1',
                    policy: 'automerge',
                    tasks: [{ ...filled().stages[0]!.tasks[0]!, executor: 'codex' }],
                },
            ],
        };
        const stage = plan.stages[0]!;
        expect(stagePolicyOf(plan, stage)).toEqual({ value: 'automerge', source: 'overridden' });
        const { policy: _dropped, ...unset } = stage;
        expect(stagePolicyOf(plan, unset)).toEqual({ value: 'human', source: 'inherited' });
        expect(taskExecutorOf(plan, stage.tasks[0]!)).toEqual({ value: 'codex', source: 'overridden' });
        const inherited = { ...stage.tasks[0]! };
        delete inherited.executor;
        expect(taskExecutorOf(plan, inherited)).toEqual({ value: 'claude', source: 'inherited' });
    });
});

describe('a started batch', () => {
    it('wears one verdict: the board’s stamps first, then whether anyone is needed', () => {
        expect(batchVerdict(record({ status: 'draft' }))).toBe('draft');
        expect(batchVerdict(record({ cancelledAt: '2026-09-02T00:00:00.000Z' }))).toBe('cancelled');
        expect(batchVerdict(record({ completedAt: '2026-09-02T00:00:00.000Z' }))).toBe('completed');
        expect(batchVerdict(record({ tasks: [state({ execution: 'running' })] }))).toBe('running');
        expect(batchVerdict(record({ tasks: [state({ execution: 'failed' })] }))).toBe('needs_attention');
        expect(
            batchVerdict(
                record({ tasks: [state({ execution: 'succeeded', waitReason: 'waiting for a person to merge x' })] })
            )
        ).toBe('needs_attention');
        expect(summaryVerdict({ status: 'started', cancelledAt: null, completedAt: null })).toBe('running');
    });

    it('labels a task by its run and its gate, never the run alone', () => {
        expect(taskStateLabel(state({ execution: 'succeeded', gate: 'passed' })).label).toBe('Accepted');
        expect(taskStateLabel(state({ execution: 'succeeded', gate: 'open', waitReason: 'x' })).label).toBe(
            'Waiting for you'
        );
        expect(taskStateLabel(state({ execution: 'failed' }))).toEqual({ label: 'Failed', tone: 'bad' });
    });

    it('offers retry only in the active stage of a batch that still schedules', () => {
        const failed = state({ execution: 'failed' });
        expect(canRetry(record({ tasks: [failed] }), failed)).toBe(true);
        expect(retryLabel(failed)).toBe('Retry');
        expect(retryLabel(state({ execution: 'succeeded' }))).toBe('Run again');
        expect(canRetry(record({ tasks: [failed], activeStage: 'stage-2' }), failed)).toBe(false);
        expect(canRetry(record({ tasks: [failed], cancelledAt: '2026-09-02T00:00:00.000Z' }), failed)).toBe(false);
        const running = state({ execution: 'running' });
        expect(canRetry(record({ tasks: [running] }), running)).toBe(false);
    });

    it('says what a person must do at the gate, and nothing while no one is needed', () => {
        const task = filled().stages[0]!.tasks[0]!;
        const waiting = state({
            execution: 'succeeded',
            pr: 'https://github.com/acme/widgets/pull/9',
            waitReason: 'x',
        });
        expect(gateInstruction(task, waiting)).toBe('Review and merge the pull request.');
        expect(gateInstruction(task, state({ execution: 'running' }))).toBeNull();
        const accepted = { ...task, completion: { kind: 'accepted' as const, condition: 'the dashboard loads' } };
        expect(gateInstruction(accepted, waiting)).toContain('the dashboard loads');
    });

    it('counts the morning report from the same predicates the rows use', () => {
        const batch = record({
            tasks: [
                state({ key: 'a', execution: 'succeeded', gate: 'passed' }),
                state({ key: 'b', execution: 'failed' }),
                state({ key: 'c', execution: 'pending' }),
            ],
        });
        expect(morningReport(batch)).toEqual({ accepted: 1, needsYou: 1, notStarted: 1, total: 3 });
    });
});
