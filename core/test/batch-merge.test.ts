import { describe, expect, it } from 'vitest';
import type { CheckItem, PrFacts } from '../src/batch-observation.js';
import {
    judgeFreshFacts,
    judgeMergeCandidate,
    judgeStageVerification,
    mergeRetryDelayMs,
    reconcileUncertainMerge,
    type MergeCandidate,
} from '../src/batch-merge.js';

const check = (name: string, state: CheckItem['state']): CheckItem => ({ name, state, url: null, detail: null });

const facts = (extra: Partial<PrFacts> = {}): PrFacts => ({
    repo: 'acme/web',
    number: 7,
    url: 'https://github.com/acme/web/pull/7',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: null,
    baseBranch: 'main',
    headSha: 'h1',
    targetSha: 't1',
    mergeable: true,
    requiredContexts: ['build'],
    requiredApprovals: 0,
    approvals: 0,
    checks: [check('build', 'passing')],
    ...extra,
});

const candidate = (extra: Partial<MergeCandidate> = {}): MergeCandidate => ({
    policy: 'automerge',
    completionKind: 'pr',
    execution: 'succeeded',
    gate: 'open',
    fenced: false,
    attempt: 1,
    targetBranch: 'main',
    observation: { attempt: 1, outcome: 'ready', stale: false, error: null, baseBranch: 'main', headSha: 'h1' },
    ...extra,
});

describe('judgeMergeCandidate', () => {
    it('merges a fresh ready PR of an automerge task', () => {
        expect(judgeMergeCandidate(candidate())).toEqual({ merge: true });
    });

    it('never merges under the human policy', () => {
        expect(judgeMergeCandidate(candidate({ policy: 'human' }))).toMatchObject({ merge: false });
    });

    it('never merges behind a fence', () => {
        expect(judgeMergeCandidate(candidate({ fenced: true }))).toMatchObject({ merge: false });
    });

    it('does not merge for an accepted-completion task', () => {
        expect(judgeMergeCandidate(candidate({ completionKind: 'accepted' }))).toMatchObject({ merge: false });
    });

    it.each(['checks_pending', 'checks_failing', 'checks_missing', 'conflicting', 'review_required', 'unknown'])(
        'waits while the observation says %s',
        (outcome) => {
            const base = candidate().observation!;
            expect(judgeMergeCandidate(candidate({ observation: { ...base, outcome } }))).toMatchObject({
                merge: false,
            });
        }
    );

    it('refuses a stale, errored, earlier-attempt, wrong-target or missing observation', () => {
        const base = candidate().observation!;
        for (const observation of [
            null,
            { ...base, stale: true },
            { ...base, error: 'transport' },
            { ...base, attempt: 0 },
            { ...base, baseBranch: 'release' },
            { ...base, headSha: null },
        ]) {
            expect(judgeMergeCandidate(candidate({ observation }))).toMatchObject({ merge: false });
        }
    });

    it('does not merge a task that is not succeeded and open', () => {
        expect(judgeMergeCandidate(candidate({ execution: 'running' }))).toMatchObject({ merge: false });
        expect(judgeMergeCandidate(candidate({ gate: 'passed' }))).toMatchObject({ merge: false });
    });
});

describe('judgeFreshFacts', () => {
    const intent = { headSha: 'h1', targetBranch: 'main' };

    it('proceeds when the head, target and requirements stand', () => {
        expect(judgeFreshFacts(intent, facts())).toEqual({ proceed: true, headSha: 'h1' });
    });

    it('reconciles a PR that is already merged instead of requesting again', () => {
        expect(judgeFreshFacts(intent, facts({ merged: true, state: 'closed' }))).toMatchObject({
            proceed: false,
            kind: 'merged',
        });
    });

    it('stops when the head moved', () => {
        expect(judgeFreshFacts(intent, facts({ headSha: 'h2' }))).toMatchObject({ proceed: false, kind: 'changed' });
    });

    it('stops when the PR was retargeted', () => {
        expect(judgeFreshFacts(intent, facts({ baseBranch: 'release' }))).toMatchObject({
            proceed: false,
            kind: 'changed',
        });
    });

    it('stops when a requirement is no longer met', () => {
        expect(judgeFreshFacts(intent, facts({ checks: [check('build', 'failing')] }))).toMatchObject({
            proceed: false,
            kind: 'changed',
        });
        expect(judgeFreshFacts(intent, facts({ requiredApprovals: 1, approvals: 0 }))).toMatchObject({
            proceed: false,
        });
        expect(judgeFreshFacts(intent, facts({ mergeable: false }))).toMatchObject({ proceed: false });
    });
});

describe('reconcileUncertainMerge and mergeRetryDelayMs', () => {
    it('settles an uncertain request on what GitHub reports', () => {
        expect(reconcileUncertainMerge({ merged: true })).toBe('merged');
        expect(reconcileUncertainMerge({ merged: false })).toBe('lapsed');
    });

    it('backs off with the lapse count and never sooner than Retry-After', () => {
        expect(mergeRetryDelayMs(2, null)).toBeGreaterThan(mergeRetryDelayMs(1, null));
        expect(mergeRetryDelayMs(1, 10 * 60 * 60 * 1000)).toBe(10 * 60 * 60 * 1000);
    });
});

describe('judgeStageVerification', () => {
    const target = (extra: Partial<Parameters<typeof judgeStageVerification>[0]['target']> = {}) => ({
        branch: 'main',
        headSha: 'tip',
        contains: { m1: true, m2: true },
        requiredContexts: ['build'] as string[] | null,
        checks: [check('build', 'passing')],
        ...extra,
    });
    const merges = [
        { task: 'a', sha: 'm1' },
        { task: 'b', sha: 'm2' },
    ];

    it('passes when every merge is on the tip and its checks pass', () => {
        expect(judgeStageVerification({ merges, target: target() })).toMatchObject({ state: 'passed', headSha: 'tip' });
    });

    it('passes a stage with nothing merged without reading checks', () => {
        expect(judgeStageVerification({ merges: [], target: target({ checks: [] }) }).state).toBe('passed');
    });

    it('fails when a merged change is not on the tip', () => {
        const result = judgeStageVerification({ merges, target: target({ contains: { m1: true, m2: false } }) });
        expect(result.state).toBe('failed');
        expect(result.detail).toContain('m2');
    });

    it('fails on a failing combined check and names it', () => {
        const result = judgeStageVerification({ merges, target: target({ checks: [check('build', 'failing')] }) });
        expect(result).toMatchObject({ state: 'failed' });
        expect(result.detail).toContain('build');
    });

    it('waits on pending, missing and unreadable checks, and an unknown merge commit', () => {
        expect(judgeStageVerification({ merges, target: target({ checks: [check('build', 'pending')] }) }).state).toBe(
            'pending'
        );
        expect(judgeStageVerification({ merges, target: target({ checks: [] }) }).state).toBe('pending');
        expect(judgeStageVerification({ merges, target: target({ requiredContexts: null }) }).state).toBe('pending');
        expect(judgeStageVerification({ merges: [{ task: 'a', sha: null }], target: target() }).state).toBe('unknown');
    });
});
