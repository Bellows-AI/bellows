import { describe, expect, it } from 'vitest';
import {
    awaitsBoardMerge,
    batchTaskCommand,
    batchWaitResult,
    decideSchedule,
    GATE_FAILED,
    GATE_OPEN,
    GATE_PASSED,
    isAccepted,
    isRetryable,
    judgeTaskGate,
    TASK_FAILED,
    TASK_PENDING,
    TASK_QUEUED,
    TASK_RETRY,
    TASK_RUNNING,
    TASK_SUCCEEDED,
    type GateEvidence,
    type ScheduleTask,
} from '../src/index.js';

const task = (key: string, stage: string, over: Partial<ScheduleTask> = {}): ScheduleTask => ({
    key,
    stage,
    required: true,
    execution: TASK_PENDING,
    gate: GATE_OPEN,
    notBefore: null,
    ...over,
});

const NOW = 1_000_000;
const base = {
    stages: ['build', 'join'],
    advanced: [] as string[],
    unverified: [] as string[],
    concurrency: 2,
    cancelled: false,
    expired: false,
    now: NOW,
};

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

    it('does not advance a settled stage whose merged result is not yet verified', () => {
        const accepted = { execution: TASK_SUCCEEDED, gate: GATE_PASSED };
        const tasks = [task('a', 'build', accepted), task('j', 'join')];
        const held = decideSchedule({ ...base, unverified: ['build'], tasks });
        expect(held.advance).toBeNull();
        expect(held.launch).toEqual([]);
        expect(decideSchedule({ ...base, unverified: [], tasks }).advance).toBe('build');
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

    it('decides nothing once the time limit expired', () => {
        const d = decideSchedule({ ...base, expired: true, tasks: [task('a', 'build')] });
        expect(d).toMatchObject({ launch: [], advance: null, complete: false });
    });

    it('holds a retry until its backoff has passed, while its sibling launches', () => {
        const tasks = [task('a', 'build', { execution: TASK_RETRY, notBefore: NOW + 1 }), task('b', 'build')];
        expect(decideSchedule({ ...base, tasks }).launch).toEqual(['b']);
        expect(decideSchedule({ ...base, now: NOW + 1, tasks }).launch).toEqual(['a', 'b']);
    });
});

describe('task predicates', () => {
    it('accepts only a succeeded run whose gate passed', () => {
        expect(isAccepted({ execution: TASK_SUCCEEDED, gate: GATE_OPEN })).toBe(false);
        expect(isAccepted({ execution: TASK_SUCCEEDED, gate: GATE_PASSED })).toBe(true);
        expect(isAccepted({ execution: TASK_FAILED, gate: GATE_PASSED })).toBe(false);
    });

    it('retries a failed run or a succeeded one whose result was not accepted', () => {
        expect(isRetryable({ execution: TASK_FAILED, gate: GATE_OPEN })).toBe(true);
        expect(isRetryable({ execution: TASK_SUCCEEDED, gate: GATE_FAILED })).toBe(true);
        expect(isRetryable({ execution: TASK_SUCCEEDED, gate: GATE_OPEN })).toBe(true);
        expect(isRetryable({ execution: TASK_SUCCEEDED, gate: GATE_PASSED })).toBe(false);
        expect(isRetryable({ execution: TASK_RUNNING, gate: GATE_OPEN })).toBe(false);
    });

    it("leaves an automerge task's open PR to the board until attention hands it to a person (#688)", () => {
        const open = {
            policy: 'automerge',
            completionKind: 'pr',
            execution: TASK_SUCCEEDED,
            gate: GATE_OPEN,
            attention: null,
            prUrl: 'https://x/pull/1',
            outcome: null as string | null,
            readError: null as string | null,
            stageAdvanced: false,
        };
        expect(awaitsBoardMerge(open)).toBe(true);
        for (const outcome of ['ready', 'checks_pending', 'unknown', 'checks_failing', 'conflicting']) {
            expect(awaitsBoardMerge({ ...open, outcome })).toBe(true);
        }
        // GitHub waits on a person's review, or on checks nobody reports; the board does not act on either.
        expect(awaitsBoardMerge({ ...open, outcome: 'review_required' })).toBe(false);
        expect(awaitsBoardMerge({ ...open, outcome: 'checks_missing' })).toBe(false);
        // The observer retries a transient read error; a definitive one is a person's.
        expect(awaitsBoardMerge({ ...open, readError: 'transport' })).toBe(true);
        expect(awaitsBoardMerge({ ...open, readError: 'rate_limited' })).toBe(true);
        for (const readError of ['not_found', 'forbidden', 'binding']) {
            expect(awaitsBoardMerge({ ...open, readError })).toBe(false);
        }
        // An optional task left behind by an advanced stage is neither merged nor repaired.
        expect(awaitsBoardMerge({ ...open, stageAdvanced: true })).toBe(false);
        expect(awaitsBoardMerge({ ...open, policy: 'human' })).toBe(false);
        expect(awaitsBoardMerge({ ...open, completionKind: 'accepted' })).toBe(false);
        expect(awaitsBoardMerge({ ...open, execution: TASK_RUNNING })).toBe(false);
        expect(awaitsBoardMerge({ ...open, gate: GATE_PASSED })).toBe(false);
        expect(awaitsBoardMerge({ ...open, attention: 'refused' })).toBe(false);
        expect(awaitsBoardMerge({ ...open, prUrl: null })).toBe(false);
    });
});

describe('judgeTaskGate', () => {
    const url = 'https://github.com/acme/web/pull/7';
    const evidence = (over: Partial<GateEvidence> = {}): GateEvidence => ({
        completionKind: 'pr',
        condition: null,
        targetBranch: 'main',
        pr: { url, baseBranch: 'main' },
        mergedAt: 2000,
        attempt: 1,
        attemptStartedAt: 1000,
        automerge: false,
        mergeNote: null,
        ...over,
    });
    const waits = (over: Partial<GateEvidence>) => judgeTaskGate(evidence(over));

    it('passes a PR against the task target, merged during the current attempt', () => {
        expect(judgeTaskGate(evidence())).toEqual({ pass: true });
    });

    it('never passes an accepted-completion task: only the accept route does', () => {
        expect(waits({ completionKind: 'accepted', condition: 'reviewed' })).toEqual({
            pass: false,
            waitReason: 'waiting for acceptance: reviewed',
        });
    });

    it('waits, with a reason, when there is no PR, it targets another branch, or it is unmerged', () => {
        expect(waits({ pr: null })).toEqual({ pass: false, waitReason: 'the run succeeded without opening a PR' });
        expect(waits({ pr: { url, baseBranch: 'dev' } })).toEqual({
            pass: false,
            waitReason: `PR ${url} targets dev, not main`,
        });
        expect(waits({ mergedAt: null })).toEqual({
            pass: false,
            waitReason: `waiting for a person to merge ${url}`,
        });
    });

    it('waits for the board, not a person, in an automerge stage, and surfaces its latest merge note', () => {
        expect(waits({ mergedAt: null, automerge: true })).toEqual({
            pass: false,
            waitReason: `waiting for the board to merge ${url}`,
        });
        expect(waits({ mergedAt: null, automerge: true, mergeNote: 'merge refused: protected' })).toEqual({
            pass: false,
            waitReason: 'merge refused: protected',
        });
        expect(waits({ automerge: true, mergeNote: 'merge refused: protected' })).toEqual({ pass: true });
    });

    it('refuses a merge observed before the current attempt started', () => {
        expect(waits({ mergedAt: 999, attempt: 2 })).toEqual({
            pass: false,
            waitReason: `PR ${url} was merged before attempt 2 started`,
        });
        expect(waits({ mergedAt: 1000 })).toEqual({ pass: true });
    });
});

describe('batchWaitResult', () => {
    it('is null while a task moves, terminal when done or cancelled, parked otherwise', () => {
        const idle = { complete: false, cancelled: false, expired: false, active: 0, waiting: 0 };
        expect(batchWaitResult({ ...idle, active: 1 })).toBeNull();
        expect(batchWaitResult({ ...idle, complete: true })).toBe('terminal');
        expect(batchWaitResult({ ...idle, cancelled: true })).toBe('terminal');
        expect(batchWaitResult(idle)).toBe('parked');
        expect(batchWaitResult({ ...idle, cancelled: true, active: 1 })).toBeNull();
    });

    it('is terminal once expired, and still moving while a retry waits out its backoff', () => {
        const idle = { complete: false, cancelled: false, expired: false, active: 0, waiting: 0 };
        expect(batchWaitResult({ ...idle, expired: true })).toBe('terminal');
        expect(batchWaitResult({ ...idle, waiting: 1 })).toBeNull();
        expect(batchWaitResult({ ...idle, expired: true, waiting: 1 })).toBe('terminal');
    });
});

describe('batchTaskCommand', () => {
    it('freezes objective, acceptance and verification into the thread command', () => {
        expect(batchTaskCommand({ objective: 'Do X', acceptance: 'X works', verification: 'run tests' })).toBe(
            'Do X\n\nAcceptance:\nX works\n\nVerification:\nrun tests'
        );
    });
});
