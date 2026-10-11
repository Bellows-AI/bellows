import { describe, expect, it } from 'vitest';
import {
    decideMerge,
    evaluatePrGate,
    evaluateStageGate,
    mergeLockKey,
    type ObservedPr,
    type PrGate,
} from '../src/batch-gate.js';

const target = { repo: 'acme/web', branch: 'main' };
const live = { headSha: 'h1', baseSha: 'b1' };
const pr = (over: Partial<ObservedPr> = {}): ObservedPr => ({
    repo: 'acme/web',
    base: 'main',
    number: 7,
    state: 'open',
    headSha: 'h1',
    baseSha: 'b1',
    checks: 'passing',
    review: 'approved',
    protectionBlocked: false,
    canMerge: true,
    ...over,
});

describe('evaluatePrGate', () => {
    it('is satisfied only by a merged PR into the task target with a merge commit', () => {
        expect(evaluatePrGate(target, pr({ state: 'merged', mergedSha: 'm1' }))).toEqual({
            ok: true,
            mergedSha: 'm1',
            repo: 'acme/web',
            branch: 'main',
        });
    });

    it.each([
        ['no PR', null, 'no_pr'],
        ['closed unmerged', pr({ state: 'closed' }), 'closed_unmerged'],
        ['still open', pr(), 'awaiting_human_merge'],
        ['merged without a recorded commit', pr({ state: 'merged' }), 'stale_evidence'],
        ['same number in another repo', pr({ repo: 'acme/api', state: 'merged', mergedSha: 'm' }), 'wrong_target'],
        ['merged into another branch', pr({ base: 'next', state: 'merged', mergedSha: 'm' }), 'wrong_target'],
    ] as const)('refuses %s', (_name, observed, reason) => {
        expect(evaluatePrGate(target, observed)).toEqual({ ok: false, reason });
    });
});

describe('decideMerge', () => {
    it('merges a green, approved, fresh PR under automerge', () => {
        expect(decideMerge('automerge', target, pr(), live)).toEqual({ merge: true });
    });

    it('never merges under human policy, whatever the evidence', () => {
        expect(decideMerge('human', target, pr(), live)).toEqual({ merge: false, reason: 'awaiting_human_merge' });
    });

    it.each([
        ['head moved', pr(), { headSha: 'h2', baseSha: 'b1' }, 'stale_evidence'],
        ['target moved', pr(), { headSha: 'h1', baseSha: 'b2' }, 'stale_evidence'],
        ['no permission', pr({ canMerge: false }), live, 'missing_permissions'],
        ['protection unmet', pr({ protectionBlocked: true }), live, 'protection_required'],
        ['checks failing', pr({ checks: 'failing' }), live, 'checks_failing'],
        ['checks pending', pr({ checks: 'pending' }), live, 'checks_pending'],
        ['review required', pr({ review: 'required' }), live, 'review_required'],
        ['changes requested', pr({ review: 'changes_requested' }), live, 'review_required'],
        ['closed', pr({ state: 'closed' }), live, 'closed_unmerged'],
        ['already merged', pr({ state: 'merged', mergedSha: 'm' }), live, 'stale_evidence'],
        ['other repo', pr({ repo: 'acme/api' }), live, 'wrong_target'],
    ] as const)('refuses when %s', (_name, observed, revisions, reason) => {
        expect(decideMerge('automerge', target, observed, revisions)).toEqual({ merge: false, reason });
    });

    it('refuses with no PR', () => {
        expect(decideMerge('automerge', target, null, live)).toEqual({ merge: false, reason: 'no_pr' });
    });
});

describe('evaluateStageGate', () => {
    const merged: PrGate = { ok: true, mergedSha: 'm', repo: 'acme/web', branch: 'main' };
    const open: PrGate = { ok: false, reason: 'awaiting_human_merge' };
    const passed = { state: 'passed', revisions: { web: 'm' } } as const;

    it('advances when every required task is satisfied and the result is verified', () => {
        const gate = evaluateStageGate(
            [
                { completion: 'pr', required: true, gate: merged },
                { completion: 'accepted', required: true, accepted: true },
            ],
            passed,
            ['web']
        );
        expect(gate).toEqual({ ok: true, revisions: { web: 'm' } });
    });

    it('holds while one required PR is unmerged, but ignores an optional one', () => {
        expect(evaluateStageGate([{ completion: 'pr', required: true, gate: open }], passed, ['web'])).toEqual({
            ok: false,
            reason: 'tasks_open',
            count: 1,
        });
        expect(
            evaluateStageGate(
                [
                    { completion: 'pr', required: true, gate: merged },
                    { completion: 'pr', required: false, gate: open },
                ],
                passed,
                ['web']
            ).ok
        ).toBe(true);
    });

    it('holds an unaccepted accepted-kind task', () => {
        expect(evaluateStageGate([{ completion: 'accepted', required: true, accepted: false }], passed, []).ok).toBe(
            false
        );
    });

    it('needs verification of the combined result, passed, with a revision per changed target', () => {
        const done = [{ completion: 'pr', required: true, gate: merged }] as const;
        expect(evaluateStageGate(done, { state: 'missing' }, ['web'])).toEqual({
            ok: false,
            reason: 'verification_missing',
        });
        expect(evaluateStageGate(done, { state: 'failed' }, ['web'])).toEqual({
            ok: false,
            reason: 'verification_failed',
        });
        expect(evaluateStageGate(done, { state: 'passed', revisions: {} }, ['web'])).toEqual({
            ok: false,
            reason: 'revisions_missing',
            count: 1,
        });
    });
});

describe('mergeLockKey', () => {
    it('is per repository and branch, so batches on one target share it and others do not', () => {
        expect(mergeLockKey('acme/web', 'main')).toBe(mergeLockKey('acme/web', 'main'));
        expect(mergeLockKey('acme/web', 'main')).not.toBe(mergeLockKey('acme/web', 'next'));
        expect(mergeLockKey('acme/web', 'main')).not.toBe(mergeLockKey('acme/api', 'main'));
    });
});
