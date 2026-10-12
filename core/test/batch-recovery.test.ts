import { describe, expect, it } from 'vitest';
import {
    ATTENTION_BUDGET,
    ATTENTION_CLOSED,
    ATTENTION_REASONS,
    ATTENTION_QUESTION,
    attentionWaitReason,
    BATCH_RETRY_BACKOFF_BASE_MS,
    BATCH_RETRY_BACKOFF_MAX_MS,
    batchNextAction,
    batchRepairCommand,
    classifyTaskFailure,
    MAX_EVIDENCE_ITEMS,
    planRecovery,
    recoveryBackoffMs,
} from '../src/index.js';

const failed = (
    failureKind: string | null,
    over: { status?: string; unansweredQuestion?: boolean; failureCause?: string | null } = {}
) => classifyTaskFailure({ status: 'failed', failureKind, failureCause: null, unansweredQuestion: false, ...over });

describe('classifyTaskFailure', () => {
    it.each([
        ['timeout', 'infra'],
        ['cache_lost', 'infra'],
        ['services', 'infra'],
        ['runner_error', 'infra'],
    ])('%s is %s', (kind, expected) => {
        expect(failed(kind)).toEqual({ kind: expected });
    });

    // Issue #581: gate, publish and helper are coarse labels; the cause under them decides.
    describe.each(['gate', 'publish', 'helper'])('a %s failure', (kind) => {
        it.each([
            ['conflict', { kind: 'repairable' }],
            ['verification', { kind: 'repairable' }],
            ['transport', { kind: 'infra' }],
            ['denied', { kind: 'attention', reason: 'configuration' }],
            ['config', { kind: 'attention', reason: 'configuration' }],
            ['unknown', { kind: 'attention', reason: 'unclassified' }],
            [null, { kind: 'attention', reason: 'unclassified' }],
            ['something_new', { kind: 'attention', reason: 'unclassified' }],
        ])('caused by %s is %o', (failureCause, expected) => {
            expect(failed(kind, { failureCause })).toEqual(expected);
        });
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
    const failing = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
            name: `check-${i}`,
            state: 'failing' as const,
            url: `https://ci/${i}`,
            detail: null,
        }));

    it.each([
        { source: 'run', cause: 'verification' },
        { source: 'run', cause: 'conflict' },
        { source: 'observed', outcome: 'checks_failing', evidence: failing(1) },
        { source: 'observed', outcome: 'conflicting', evidence: [] },
    ] as const)('restates acceptance and verification and demands a fresh run (%o)', (evidence) => {
        const command = batchRepairCommand(task, evidence);
        expect(command).toContain('Acceptance:\nit works');
        expect(command).toContain('run it again now');
        expect(command).toContain('npm test');
    });

    it('names failed checks for a run that failed verification', () => {
        expect(batchRepairCommand(task, { source: 'run', cause: 'verification' })).toContain('failed its checks');
    });

    it('names a stale or conflicting branch for a run that hit a conflict', () => {
        expect(batchRepairCommand(task, { source: 'run', cause: 'conflict' })).toContain('stale or conflicts');
    });

    it('lists the observed failing checks by name and state, bounded', () => {
        const command = batchRepairCommand(task, {
            source: 'observed',
            outcome: 'checks_failing',
            evidence: failing(MAX_EVIDENCE_ITEMS + 5),
        });
        expect(command).toContain('pull request');
        expect(command).toContain('check-0: failing (https://ci/0)');
        expect(command).toContain(`check-${MAX_EVIDENCE_ITEMS - 1}: failing`);
        expect(command).not.toContain(`check-${MAX_EVIDENCE_ITEMS}:`);
    });

    it('names a conflict with the target for an observed conflicting PR', () => {
        const command = batchRepairCommand(task, { source: 'observed', outcome: 'conflicting', evidence: [] });
        expect(command).toContain('conflicts with its target branch');
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

    it('names the failure kind of an unclassified failure, and the PR of a closed one (#581)', () => {
        expect(attentionWaitReason('unclassified', { jobId: 'j1', detail: 'publish (cause unknown)' })).toBe(
            'failed with no recognised cause: publish (cause unknown) (job j1)'
        );
        expect(attentionWaitReason('unclassified', { jobId: 'j1' })).toBe('failed with no recorded reason (job j1)');
        expect(attentionWaitReason(ATTENTION_CLOSED, { jobId: 'j1', detail: 'https://x/pull/1' })).toBe(
            'the pull request https://x/pull/1 was closed without merging (job j1)'
        );
        expect(ATTENTION_REASONS).toContain('closed');
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

    it('retries, rather than merges, a task whose PR was closed without merging (#581)', () => {
        expect(next('parked', { execution: 'succeeded', prUrl: 'https://x/pull/1', attention: 'closed' })).toEqual({
            action: 'retry',
            method: 'POST',
            path: '/api/batches/b1/tasks/a/retry',
        });
        expect(next('expired', { execution: 'succeeded', prUrl: 'https://x/pull/1', attention: 'closed' })).toEqual({
            action: 'new_batch',
            method: 'POST',
            path: '/api/batches',
        });
    });

    it('has nothing to do for a passed gate and waits for moving work', () => {
        expect(next('running', { gate: 'passed', execution: 'succeeded' })).toEqual({ action: 'none' });
        expect(next('running', { execution: 'running' })).toEqual({ action: 'wait' });
    });
});
