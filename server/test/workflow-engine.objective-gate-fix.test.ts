import { describe, expect, it } from 'vitest';
import { type CompletedRun, nextObjectiveTransition } from '../src/db/workflows/workflow-engine.js';
import { TRUNCATION_MARKER } from '../src/db/workflows/workflow-schema.js';

const red = [{ name: 'lint', status: 'failed' as const, exitCode: 1, output: 'no-unused-vars at a.ts:3' }];

const completed = (over: Partial<CompletedRun> = {}): CompletedRun => ({
    id: 'run-1',
    node: null,
    status: 'failed',
    output: null,
    gates: red,
    failureKind: 'gate',
    treeChanged: true,
    ...over,
});

const decide = (over: Partial<Parameters<typeof nextObjectiveTransition>[0]> = {}) =>
    nextObjectiveTransition({ completed: completed(), limit: 3, spentRounds: 0, threadBusy: false, ...over });

describe('nextObjectiveTransition', () => {
    it('queues a follow-up naming the failed gate and carrying its output', () => {
        const next = decide();
        expect(next).toMatchObject({ action: 'insert', round: 1 });
        if (next.action !== 'insert') return;
        expect(next.command).toContain('"lint" gate');
        expect(next.command).toContain('no-unused-vars at a.ts:3');
    });

    it('counts the next round from the rounds already spent', () => {
        expect(decide({ spentRounds: 2 })).toMatchObject({ action: 'insert', round: 3 });
    });

    it.each([
        ['the rounds are exhausted', { spentRounds: 3 }, 'loop_bound'],
        ['the limit is zero', { limit: 0 }, 'loop_bound'],
        ['the root carries no limit', { limit: null }, 'loop_bound'],
        ['the tree is unchanged', { completed: completed({ treeChanged: false }) }, 'no_progress'],
        ['another row is live', { threadBusy: true }, 'thread_busy'],
        ['the run reported blocked', { completed: completed({ failureKind: 'blocked' }) }, 'blocked'],
        ['a service died', { completed: completed({ failureKind: 'services' }) }, 'services'],
        ['the publish failed', { completed: completed({ failureKind: 'publish' }) }, 'publish'],
        ['the failure is not a gate', { completed: completed({ failureKind: 'runner_error' }) }, 'no_edge'],
        ['no gate report failed', { completed: completed({ gates: [] }) }, 'no_edge'],
        ['the run succeeded', { completed: completed({ status: 'succeeded', failureKind: null }) }, 'no_edge'],
    ] as const)('rests when %s', (_name, over, reason) => {
        expect(decide(over)).toEqual({ action: 'rest', reason });
    });

    it('bounds a huge gate output with the visible truncation marker', () => {
        const next = decide({ completed: completed({ gates: [{ ...red[0]!, output: 'x'.repeat(100_000) }] }) });
        expect(next.action).toBe('insert');
        if (next.action === 'insert') expect(next.command).toContain(TRUNCATION_MARKER);
    });
});
