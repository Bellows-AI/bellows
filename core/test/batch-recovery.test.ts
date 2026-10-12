import { describe, expect, it } from 'vitest';
import {
    ATTENTION_BUDGET,
    ATTENTION_QUESTION,
    attentionWaitReason,
    BATCH_RETRY_BACKOFF_BASE_MS,
    BATCH_RETRY_BACKOFF_MAX_MS,
    batchNextAction,
    batchRepairCommand,
    classifyTaskFailure,
    planRecovery,
    recoveryBackoffMs,
} from '../src/index.js';

const failed = (failureKind: string | null, over: { status?: string; unansweredQuestion?: boolean } = {}) =>
    classifyTaskFailure({ status: 'failed', failureKind, unansweredQuestion: false, ...over });

describe('classifyTaskFailure', () => {
    it.each([
        ['timeout', 'infra'],
        ['cache_lost', 'infra'],
        ['services', 'infra'],
        ['runner_error', 'infra'],
        ['gate', 'repairable'],
        ['publish', 'repairable'],
        ['helper', 'repairable'],
    ])('%s is %s', (kind, expected) => {
        expect(failed(kind)).toEqual({ kind: expected });
    });

    it.each([
        ['config', 'configuration'],
        ['policy', 'configuration'],
        ['blocked', 'blocked'],
        [null, 'unclassified'],
        ['something_new', 'unclassified'],
    ])('%s needs attention: %s', (kind, reason) => {
        expect(failed(kind)).toEqual({ kind: 'attention', reason });
    });

    it('treats a dead run as infrastructure', () => {
        expect(failed(null, { status: 'dead' })).toEqual({ kind: 'infra' });
    });

    it('lets an unanswered question outrank every kind', () => {
        expect(failed('timeout', { unansweredQuestion: true })).toEqual({ kind: 'attention', reason: 'question' });
        expect(failed(null, { status: 'dead', unansweredQuestion: true })).toEqual({
            kind: 'attention',
            reason: 'question',
        });
    });
});

describe('recoveryBackoffMs', () => {
    it('doubles from the base and is capped', () => {
        expect(recoveryBackoffMs(1)).toBe(BATCH_RETRY_BACKOFF_BASE_MS);
        expect(recoveryBackoffMs(2)).toBe(BATCH_RETRY_BACKOFF_BASE_MS * 2);
        expect(recoveryBackoffMs(3)).toBe(BATCH_RETRY_BACKOFF_BASE_MS * 4);
        expect(recoveryBackoffMs(20)).toBe(BATCH_RETRY_BACKOFF_MAX_MS);
    });
});

describe('planRecovery', () => {
    const budgets = { infraRetries: 2, repairs: 1 };

    it('retries an infrastructure failure with backoff while budget remains', () => {
        expect(planRecovery({ failure: { kind: 'infra' }, used: { infra: 0, repairs: 0 }, budgets })).toEqual({
            action: 'infra_retry',
            delayMs: BATCH_RETRY_BACKOFF_BASE_MS,
        });
        expect(planRecovery({ failure: { kind: 'infra' }, used: { infra: 1, repairs: 0 }, budgets })).toEqual({
            action: 'infra_retry',
            delayMs: BATCH_RETRY_BACKOFF_BASE_MS * 2,
        });
    });

    it('repairs a repairable failure while budget remains', () => {
        expect(planRecovery({ failure: { kind: 'repairable' }, used: { infra: 2, repairs: 0 }, budgets })).toEqual({
            action: 'repair',
        });
    });

    it('asks a person once the matching budget is spent, and keeps the budgets apart', () => {
        const spent = { action: 'attention', reason: ATTENTION_BUDGET };
        expect(planRecovery({ failure: { kind: 'infra' }, used: { infra: 2, repairs: 0 }, budgets })).toEqual(spent);
        expect(planRecovery({ failure: { kind: 'repairable' }, used: { infra: 0, repairs: 1 }, budgets })).toEqual(
            spent
        );
        expect(
            planRecovery({
                failure: { kind: 'repairable' },
                used: { infra: 0, repairs: 0 },
                budgets: { infraRetries: 2, repairs: 0 },
            })
        ).toEqual(spent);
    });

    it('passes an attention classification through untouched', () => {
        expect(
            planRecovery({
                failure: { kind: 'attention', reason: ATTENTION_QUESTION },
                used: { infra: 0, repairs: 0 },
                budgets,
            })
        ).toEqual({ action: 'attention', reason: ATTENTION_QUESTION });
    });
});

describe('batchRepairCommand', () => {
    const task = { acceptance: 'it works', verification: 'npm test' };

    it('restates acceptance and verification and demands a fresh run', () => {
        const command = batchRepairCommand(task, 'gate');
        expect(command).toContain('failed its checks');
        expect(command).toContain('Acceptance:\nit works');
        expect(command).toContain('run it again now');
        expect(command).toContain('npm test');
    });

    it('names a stale or conflicting branch for a failed publish', () => {
        expect(batchRepairCommand(task, 'publish')).toContain('stale or conflicts');
    });
});

describe('attentionWaitReason', () => {
    it('names the job, and the question when there is one', () => {
        expect(attentionWaitReason('question', { jobId: 'j1', detail: 'which db?' })).toBe(
            'needs an answer: which db? (job j1)'
        );
        expect(attentionWaitReason('configuration', { jobId: 'j1' })).toContain('job j1');
        expect(attentionWaitReason('budget', { jobId: 'j1', detail: '2 of 2 repairs used' })).toContain('2 of 2');
    });
});

describe('batchNextAction', () => {
    const task = {
        key: 'a',
        execution: 'failed',
        gate: 'open',
        attention: null as string | null,
        questionJobId: 'asker',
        questionId: null as string | null,
        completionKind: 'pr',
        prUrl: null as string | null,
    };
    const next = (batchState: 'running' | 'parked' | 'completed' | 'cancelled' | 'expired', over = {}) =>
        batchNextAction({ batchId: 'b1', batchState, task: { ...task, ...over } });

    it('points a failed task at the retry route', () => {
        expect(next('parked')).toEqual({ action: 'retry', method: 'POST', path: '/api/batches/b1/tasks/a/retry' });
    });

    it('points an unanswered question at the answer route', () => {
        expect(next('parked', { attention: 'question', questionId: 'q1', execution: 'running' })).toEqual({
            action: 'answer',
            method: 'POST',
            path: '/api/jobs/asker/questions/q1/answer',
        });
    });

    it('retries, rather than answers, a run that died holding its question', () => {
        expect(next('parked', { attention: 'question', questionId: 'q1', execution: 'failed' })).toMatchObject({
            action: 'retry',
        });
    });

    it('points a finished PR task at the merge, and an accepted one at the accept route', () => {
        expect(next('parked', { execution: 'succeeded', prUrl: 'https://x/pull/1' })).toEqual({
            action: 'merge',
            url: 'https://x/pull/1',
        });
        expect(next('parked', { execution: 'succeeded', completionKind: 'accepted' })).toMatchObject({
            action: 'accept',
        });
    });

    it('offers a new batch, never a retry, once cancelled or expired', () => {
        expect(next('expired')).toEqual({ action: 'new_batch', method: 'POST', path: '/api/batches' });
        expect(next('cancelled')).toMatchObject({ action: 'new_batch' });
        expect(next('expired', { execution: 'succeeded', prUrl: 'https://x/pull/1' })).toMatchObject({
            action: 'merge',
        });
    });

    it('has nothing to do for a passed gate and waits for moving work', () => {
        expect(next('running', { gate: 'passed', execution: 'succeeded' })).toEqual({ action: 'none' });
        expect(next('running', { execution: 'running' })).toEqual({ action: 'wait' });
    });
});
