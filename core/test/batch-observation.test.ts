import { describe, expect, it } from 'vitest';
import {
    assessChecks,
    assessPullRequest,
    errorFingerprint,
    nextObservationDelayMs,
    observationFingerprint,
    type CheckItem,
    type PrFacts,
} from '../src/batch-observation.js';
import { MAX_EVIDENCE_ITEMS } from '../src/batch-recovery.js';

const check = (name: string, state: CheckItem['state'], extra: Partial<CheckItem> = {}): CheckItem => ({
    name,
    state,
    url: `https://ci.example/${name}`,
    detail: null,
    ...extra,
});

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

describe('assessChecks', () => {
    it('is passing only when every required context passes', () => {
        expect(assessChecks(['build', 'lint'], [check('build', 'passing'), check('lint', 'passing')]).state).toBe(
            'passing'
        );
    });

    it('names a required context nobody reported as missing, never passing', () => {
        const { state, evidence } = assessChecks(['build', 'lint'], [check('build', 'passing')]);
        expect(state).toBe('missing');
        expect(evidence).toEqual([{ name: 'lint', state: 'missing', url: null, detail: 'not reported' }]);
    });

    it('ranks failing over pending over missing', () => {
        const items = [check('a', 'pending'), check('b', 'failing')];
        expect(assessChecks(['a', 'b', 'c'], items).state).toBe('failing');
        expect(assessChecks(['a', 'c'], items).state).toBe('pending');
    });

    it('ignores a failing check that is not required', () => {
        expect(assessChecks(['build'], [check('build', 'passing'), check('flaky', 'failing')]).state).toBe('passing');
    });

    it('counts every reported check when nothing is required, and calls an empty report missing', () => {
        expect(assessChecks([], [check('x', 'failing')]).state).toBe('failing');
        expect(assessChecks([], []).state).toBe('missing');
    });

    it('cannot call checks passing or failing when the requirement is unreadable', () => {
        expect(assessChecks(null, [check('build', 'failing')]).state).toBe('unknown');
    });

    it('bounds the evidence and clips its fields', () => {
        const many = Array.from({ length: MAX_EVIDENCE_ITEMS + 5 }, (_, i) =>
            check(`c${String(i).padStart(2, '0')}`, 'failing', { detail: 'x'.repeat(1000) })
        );
        const { evidence } = assessChecks([], many);
        expect(evidence).toHaveLength(MAX_EVIDENCE_ITEMS);
        expect(evidence[0]!.detail).toHaveLength(300);
    });
});

describe('assessPullRequest', () => {
    it('is ready and not repairable when checks pass and the PR is clean', () => {
        expect(assessPullRequest(facts())).toMatchObject({ outcome: 'ready', repairable: false, checks: 'passing' });
    });

    it('a failing required check is the repairable finding, with its evidence', () => {
        const result = assessPullRequest(facts({ checks: [check('build', 'failing', { detail: 'tsc exploded' })] }));
        expect(result).toMatchObject({ outcome: 'checks_failing', repairable: true });
        expect(result.evidence[0]).toMatchObject({ name: 'build', url: 'https://ci.example/build' });
    });

    it('a conflict is repairable', () => {
        expect(assessPullRequest(facts({ mergeable: false }))).toMatchObject({
            outcome: 'conflicting',
            mergeability: 'conflicting',
            repairable: true,
        });
    });

    it.each([
        ['pending checks', { checks: [check('build', 'pending')] }, 'checks_pending'],
        ['missing checks', { checks: [] }, 'checks_missing'],
        ['unknown mergeability', { mergeable: null }, 'unknown'],
        ['unreadable protection', { requiredContexts: null }, 'unknown'],
        ['a pending review', { requiredApprovals: 1, approvals: 0 }, 'review_required'],
    ] as const)('never repairs %s', (_label, extra, outcome) => {
        expect(assessPullRequest(facts(extra))).toMatchObject({ outcome, repairable: false });
    });

    it('settles a closed-unmerged and a merged PR whatever the checks say', () => {
        const failing = [check('build', 'failing')];
        expect(assessPullRequest(facts({ state: 'closed', checks: failing }))).toMatchObject({
            outcome: 'closed_unmerged',
            repairable: false,
        });
        expect(assessPullRequest(facts({ state: 'closed', merged: true, checks: failing }))).toMatchObject({
            outcome: 'merged',
            prState: 'merged',
            repairable: false,
        });
    });
});

describe('observationFingerprint', () => {
    const at = (extra: Partial<PrFacts>) => {
        const f = facts(extra);
        return observationFingerprint(f, assessPullRequest(f));
    };

    it('replaying the same observation yields the same identity', () => {
        expect(at({})).toBe(at({}));
    });

    it('a new head or a moved target is a new identity', () => {
        expect(at({ headSha: 'h2' })).not.toBe(at({}));
        expect(at({ targetSha: 't2' })).not.toBe(at({}));
    });

    it('a changed outcome is a new identity', () => {
        expect(at({ mergeable: false })).not.toBe(at({}));
    });

    it('a withdrawn assessment has its own stable identity', () => {
        expect(errorFingerprint('forbidden')).toBe(errorFingerprint('forbidden'));
        expect(errorFingerprint('forbidden')).not.toBe(errorFingerprint('not_found'));
    });
});

describe('nextObservationDelayMs', () => {
    it('polls an active PR every 60 seconds and asks for mergeability sooner', () => {
        expect(nextObservationDelayMs({ ok: true, mergeabilityUnknown: false })).toBe(60_000);
        expect(nextObservationDelayMs({ ok: true, mergeabilityUnknown: true })).toBeLessThan(60_000);
    });

    it('backs off exponentially from 60 seconds and caps at 15 minutes', () => {
        const delay = (failures: number) => nextObservationDelayMs({ ok: false, failures, retryAfterMs: null });
        expect([1, 2, 3, 4, 5].map(delay)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000]);
        expect(delay(50)).toBe(900_000);
    });

    it('never looks sooner than Retry-After, even past the cap', () => {
        expect(nextObservationDelayMs({ ok: false, failures: 1, retryAfterMs: 300_000 })).toBe(300_000);
        expect(nextObservationDelayMs({ ok: false, failures: 1, retryAfterMs: 3_600_000 })).toBe(3_600_000);
        expect(nextObservationDelayMs({ ok: false, failures: 3, retryAfterMs: 1000 })).toBe(240_000);
    });
});
