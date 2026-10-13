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
    needsPerson,
    nextKey,
    removeStage,
    removeTask,
    retryLabel,
    stagePolicyOf,
    summaryVerdict,
    VERDICT_LABEL,
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
    plan: filled(),
    tasks: [state()],
    verification: [],
    ...over,
});

const verifying = (state: string): BatchRecord['verification'] => [
    {
        stage: 'stage-1',
        state,
        detail: 'checks on main fail',
        headSha: 'cd89f3d2aa',
        checkedAt: '2026-09-01T00:00:00.000Z',
    },
];

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

    it('names an organization executor’s scope, inherited from the batch or set on the task', () => {
        const task = filled().stages[0]!.tasks[0]!;
        const plan: BatchPlan = { ...filled(), executor: 'Main ORG', executorScope: 'org' };
        expect(taskExecutorOf(plan, task)).toEqual({ value: 'Main ORG (organization)', source: 'inherited' });
        expect(taskExecutorOf(plan, { ...task, executorScope: 'user' })).toEqual({
            value: 'Main ORG',
            source: 'overridden',
        });
        expect(taskExecutorOf(filled(), { ...task, executor: 'Main ORG', executorScope: 'org' })).toEqual({
            value: 'Main ORG (organization)',
            source: 'overridden',
        });
    });
});

describe('a started batch', () => {
    it('wears one verdict: the board’s stamps first, then whether anyone is needed', () => {
        expect(batchVerdict(record({ status: 'draft' }), null)).toBe('draft');
        const at = '2026-09-02T00:00:00.000Z';
        expect(batchVerdict(record({ status: 'cancelled', cancelledAt: at }), null)).toBe('cancelled');
        expect(batchVerdict(record({ status: 'completed', completedAt: at }), null)).toBe('completed');
        expect(batchVerdict(record({ status: 'expired', expiredAt: at }), null)).toBe('expired');
        // Cancelled after the deadline fenced it: the board answers cancelled, and so does the verdict.
        expect(batchVerdict(record({ status: 'cancelled', cancelledAt: at, expiredAt: at }), null)).toBe('cancelled');
        expect(batchVerdict(record({ tasks: [state({ execution: 'running' })] }), null)).toBe('running');
        expect(batchVerdict(record({ tasks: [state({ execution: 'failed' })] }), null)).toBe('needs_attention');
        expect(
            batchVerdict(
                record({ tasks: [state({ execution: 'succeeded', waitReason: 'waiting for a person to merge x' })] }),
                null
            )
        ).toBe('needs_attention');
        expect(summaryVerdict({ status: 'running' })).toBe('running');
        expect(summaryVerdict({ status: 'expired' })).toBe('expired');
        expect(VERDICT_LABEL.expired).toBe('Expired');
    });

    it('labels a task by its run and its gate, never the run alone', () => {
        expect(taskStateLabel(state({ execution: 'succeeded', gate: 'passed' }), null).label).toBe('Accepted');
        expect(taskStateLabel(state({ execution: 'succeeded', gate: 'open', waitReason: 'x' }), null).label).toBe(
            'Waiting for you'
        );
        expect(taskStateLabel(state({ execution: 'failed' }), null)).toEqual({ label: 'Failed', tone: 'bad' });
    });

    it('offers retry only in the active stage of a batch that still schedules', () => {
        const failed = state({ execution: 'failed' });
        expect(canRetry(record({ tasks: [failed] }), failed)).toBe(true);
        expect(retryLabel(failed)).toBe('Retry');
        expect(retryLabel(state({ execution: 'succeeded' }))).toBe('Run again');
        expect(canRetry(record({ tasks: [failed], activeStage: 'stage-2' }), failed)).toBe(false);
        expect(
            canRetry(record({ tasks: [failed], status: 'cancelled', cancelledAt: '2026-09-02T00:00:00.000Z' }), failed)
        ).toBe(false);
        expect(
            canRetry(record({ tasks: [failed], status: 'expired', expiredAt: '2026-09-02T00:00:00.000Z' }), failed)
        ).toBe(false);
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
        expect(gateInstruction(task, waiting, null)).toBe('Review and merge the pull request.');
        expect(gateInstruction(task, state({ execution: 'running' }), null)).toBeNull();
        const accepted = { ...task, completion: { kind: 'accepted' as const, condition: 'the dashboard loads' } };
        expect(gateInstruction(accepted, waiting, null)).toContain('the dashboard loads');
    });

    it('reads a failed stage verification as needing a person, and pending or passed as not', () => {
        const accepted = [state({ execution: 'succeeded', gate: 'passed' })];
        const failed = record({ tasks: accepted, verification: verifying('failed') });
        expect(batchVerdict(failed, null)).toBe('needs_attention');
        expect(morningReport(failed, null).needsYou).toBe(1);
        for (const ok of ['pending', 'passed']) {
            const batch = record({ tasks: accepted, verification: verifying(ok) });
            expect(batchVerdict(batch, null)).toBe('running');
            expect(morningReport(batch, null).needsYou).toBe(0);
        }
        expect(batchVerdict({ ...failed, status: 'completed', completedAt: '2026-09-02T00:00:00.000Z' }, null)).toBe(
            'completed'
        );
    });

    it('reads an automerge PR the board is still merging as the board’s, not a person’s (#693)', () => {
        const task = filled().stages[0]!.tasks[0]!;
        const pr = 'https://github.com/acme/widgets/pull/9';
        const merging = state({ execution: 'succeeded', pr, waitReason: `waiting for the board to merge ${pr}` });
        const batch = record({ tasks: [merging] });
        const boardOn = { tasks: [{ key: 'task-1', next: { action: 'wait' as const } }] };
        expect(needsPerson(merging, boardOn)).toBe(false);
        expect(batchVerdict(batch, boardOn)).toBe('running');
        expect(morningReport(batch, boardOn).needsYou).toBe(0);
        expect(taskStateLabel(merging, boardOn)).toEqual({ label: 'Board merging', tone: 'ok' });
        expect(gateInstruction(task, merging, boardOn)).toBeNull();

        // The board cannot merge it by itself: `next` hands it to a person, and the monitor says so.
        const personOn = { tasks: [{ key: 'task-1', next: { action: 'merge' as const, url: pr } }] };
        expect(needsPerson(merging, personOn)).toBe(true);
        expect(batchVerdict(batch, personOn)).toBe('needs_attention');
        expect(morningReport(batch, personOn).needsYou).toBe(1);
        expect(taskStateLabel(merging, personOn).label).toBe('Waiting for you');
        expect(gateInstruction(task, merging, personOn)).toBe('Review and merge the pull request.');

        // No report yet: the record's own rule, as before the first report lands.
        expect(needsPerson(merging, null)).toBe(true);
    });

    it('counts the morning report from the same predicates the rows use', () => {
        const batch = record({
            tasks: [
                state({ key: 'a', execution: 'succeeded', gate: 'passed' }),
                state({ key: 'b', execution: 'failed' }),
                state({ key: 'c', execution: 'pending' }),
            ],
        });
        expect(morningReport(batch, null)).toEqual({ accepted: 1, needsYou: 1, notStarted: 1, total: 3 });
    });
});
