import { describe, expect, it } from 'vitest';
import {
    batchTaskCommand,
    batchWaitResult,
    decideSchedule,
    GATE_FAILED,
    GATE_OPEN,
    GATE_PASSED,
    isAccepted,
    isRetryable,
    TASK_FAILED,
    TASK_PENDING,
    TASK_QUEUED,
    TASK_RETRY,
    TASK_RUNNING,
    TASK_SUCCEEDED,
    type ScheduleTask,
} from '../src/index.js';

const task = (key: string, stage: string, over: Partial<ScheduleTask> = {}): ScheduleTask => ({
    key,
    stage,
    required: true,
    execution: TASK_PENDING,
    gate: GATE_OPEN,
    ...over,
});

const base = { stages: ['build', 'join'], advanced: [] as string[], concurrency: 2, cancelled: false };

describe('decideSchedule', () => {
    it('launches the active stage in parallel and holds the join stage back', () => {
        const d = decideSchedule({
            ...base,
            tasks: [task('a', 'build'), task('b', 'build'), task('j', 'join')],
        });
        expect(d.launch).toEqual(['a', 'b']);
        expect(d.activeStage).toBe('build');
        expect(d.advance).toBeNull();
    });

    it('never launches more than the free slots, counting running tasks', () => {
        const d = decideSchedule({
            ...base,
            tasks: [task('a', 'build', { execution: TASK_RUNNING }), task('b', 'build'), task('c', 'build')],
        });
        expect(d.launch).toEqual(['b']);
        expect(d.active).toBe(1);
    });

    it('lets a retry take a slot ahead of a pending task', () => {
        const d = decideSchedule({
            ...base,
            concurrency: 1,
            tasks: [task('a', 'build'), task('b', 'build', { execution: TASK_RETRY })],
        });
        expect(d.launch).toEqual(['b']);
    });

    it('does not advance on a successful verdict alone', () => {
        const d = decideSchedule({
            ...base,
            tasks: [task('a', 'build', { execution: TASK_SUCCEEDED }), task('j', 'join')],
        });
        expect(d.advance).toBeNull();
        expect(d.launch).toEqual([]);
    });

    it('advances once every required task is accepted', () => {
        const accepted = { execution: TASK_SUCCEEDED, gate: GATE_PASSED };
        const d = decideSchedule({
            ...base,
            tasks: [task('a', 'build', accepted), task('b', 'build', accepted), task('j', 'join')],
        });
        expect(d.advance).toBe('build');
        expect(d.launch).toEqual([]);
    });

    it('continues healthy siblings after one task fails, and does not advance', () => {
        const d = decideSchedule({
            ...base,
            tasks: [task('a', 'build', { execution: TASK_FAILED }), task('b', 'build'), task('j', 'join')],
        });
        expect(d.launch).toEqual(['b']);
        expect(d.advance).toBeNull();
    });

    it('launches the next stage once the previous one has advanced', () => {
        const accepted = { execution: TASK_SUCCEEDED, gate: GATE_PASSED };
        const d = decideSchedule({
            ...base,
            advanced: ['build'],
            tasks: [task('a', 'build', accepted), task('j', 'join')],
        });
        expect(d.activeStage).toBe('join');
        expect(d.launch).toEqual(['j']);
    });

    it('holds an optional task that is still moving, not one that failed', () => {
        const accepted = { execution: TASK_SUCCEEDED, gate: GATE_PASSED };
        const moving = decideSchedule({
            ...base,
            tasks: [task('a', 'build', accepted), task('o', 'build', { required: false, execution: TASK_QUEUED })],
        });
        expect(moving.advance).toBeNull();
        const failed = decideSchedule({
            ...base,
            tasks: [task('a', 'build', accepted), task('o', 'build', { required: false, execution: TASK_FAILED })],
        });
        expect(failed.advance).toBe('build');
    });

    it('completes when every stage has advanced', () => {
        const d = decideSchedule({ ...base, advanced: ['build', 'join'], tasks: [] });
        expect(d.complete).toBe(true);
        expect(d.activeStage).toBeNull();
    });

    it('decides nothing once cancelled', () => {
        const d = decideSchedule({ ...base, cancelled: true, tasks: [task('a', 'build')] });
        expect(d).toMatchObject({ launch: [], advance: null, complete: false });
    });
});

describe('task predicates', () => {
    it('accepts only a succeeded run whose gate passed', () => {
        expect(isAccepted({ execution: TASK_SUCCEEDED, gate: GATE_OPEN })).toBe(false);
        expect(isAccepted({ execution: TASK_SUCCEEDED, gate: GATE_PASSED })).toBe(true);
        expect(isAccepted({ execution: TASK_FAILED, gate: GATE_PASSED })).toBe(false);
    });

    it('retries a failed run or a succeeded one whose gate refused it', () => {
        expect(isRetryable({ execution: TASK_FAILED, gate: GATE_OPEN })).toBe(true);
        expect(isRetryable({ execution: TASK_SUCCEEDED, gate: GATE_FAILED })).toBe(true);
        expect(isRetryable({ execution: TASK_SUCCEEDED, gate: GATE_PASSED })).toBe(false);
        expect(isRetryable({ execution: TASK_RUNNING, gate: GATE_OPEN })).toBe(false);
    });
});

describe('batchWaitResult', () => {
    it('is null while a task moves, terminal when done or cancelled, parked otherwise', () => {
        expect(batchWaitResult({ complete: false, cancelled: false, active: 1 })).toBeNull();
        expect(batchWaitResult({ complete: true, cancelled: false, active: 0 })).toBe('terminal');
        expect(batchWaitResult({ complete: false, cancelled: true, active: 0 })).toBe('terminal');
        expect(batchWaitResult({ complete: false, cancelled: false, active: 0 })).toBe('parked');
        expect(batchWaitResult({ complete: false, cancelled: true, active: 1 })).toBeNull();
    });
});

describe('batchTaskCommand', () => {
    it('freezes objective, acceptance and verification into the thread command', () => {
        expect(batchTaskCommand({ objective: 'Do X', acceptance: 'X works', verification: 'run tests' })).toBe(
            'Do X\n\nAcceptance:\nX works\n\nVerification:\nrun tests'
        );
    });
});
