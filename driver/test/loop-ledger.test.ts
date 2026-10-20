import { describe, expect, it } from 'vitest';
import type { FailureCause, FailureKind } from '../src/board.js';
import type { HelperFailureReason, HelperFailureReport } from '../src/helpers.js';
import {
    agentFaults,
    causeOf,
    draftable,
    gatesEligible,
    kindOf,
    ledgerOf,
    outputOf,
    publishEligible,
    RANK,
    skipWhyOf,
    statusOf,
    type LedgerParts,
} from '../src/loop-ledger.js';
import type { DeadService, RunOutcome } from '../src/runner.js';

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
    exitCode: 0,
    output: 'done',
    timedOut: false,
    started: true,
    ...over,
});

const dead: DeadService = { name: 'db', image: 'mongo', state: 'failed', exitCode: 1, reason: null, logTail: '' };
const helper = { helperId: 'h', result: { reason: 'boom', message: 'm' } } as unknown as HelperFailureReport;

const parts = (over: Partial<LedgerParts> = {}): LedgerParts => ({
    outcome: outcome(),
    failure: null,
    deadServices: [],
    helperFailure: null,
    published: null,
    ...over,
});

/**
 * One fault each, by the kind it must name — the table the pairwise test crosses with itself.
 * `config` is a pre-run refusal (loop-run.ts), never a ledger fault, so it is not ranked.
 */
const SINGLE: Record<Exclude<FailureKind, 'config'>, LedgerParts> = {
    timeout: parts({ outcome: outcome({ timedOut: true }) }),
    cache_lost: parts({ outcome: outcome({ cacheLost: 'c' }) }),
    blocked: parts({ outcome: outcome({ blockedLine: 'x' }) }),
    services: parts({ deadServices: [dead] }),
    gate: parts({ failure: { name: 't', exitCode: 1, output: '' } }),
    helper: parts({ helperFailure: helper }),
    policy: parts({ policyRefusal: 'declared gates are required and did not pass' }),
    publish: parts({ published: { ok: false, published: false, reason: 'r' } as never }),
    runner_error: parts({ outcome: outcome({ exitCode: 2 }) }),
};

const single = (kind: FailureKind): LedgerParts => SINGLE[kind as keyof typeof SINGLE];

const merge = (a: LedgerParts, b: LedgerParts): LedgerParts => ({
    outcome: {
        ...a.outcome,
        ...b.outcome,
        timedOut: a.outcome.timedOut || b.outcome.timedOut,
        exitCode: a.outcome.exitCode === 0 ? b.outcome.exitCode : a.outcome.exitCode,
    },
    failure: a.failure ?? b.failure,
    deadServices: [...a.deadServices, ...b.deadServices],
    helperFailure: a.helperFailure ?? b.helperFailure,
    published: a.published ?? b.published,
    policyRefusal: a.policyRefusal ?? b.policyRefusal ?? null,
});

describe('a dead service note (issue #487)', () => {
    const noteOf = (over: Partial<DeadService>) =>
        ledgerOf(parts({ deadServices: [{ ...dead, ...over }] }))[0]?.note ?? '';

    it.each([
        'error: failed switching to "mongodb": operation not permitted',
        'chown: changing ownership of /data/db: Operation not permitted',
        'gosu: error: operation not permitted',
    ])('points the capability-drop signature %j at user: "uid:gid", the only way out', (logTail) => {
        const note = noteOf({ logTail });
        expect(note).toContain('hint:');
        expect(note).toContain('user: "uid:gid"');
        expect(note).not.toContain('unhardened');
    });

    it('adds no hint to any other ending', () => {
        expect(noteOf({ logTail: 'FATAL: password authentication failed' })).not.toContain('hint:');
        expect(noteOf({ logTail: '' })).not.toContain('hint:');
    });

    // A service the platform no longer lists has no exit to report (issue #560): the note says why it went.
    it('names why a missing service went, never "exit unknown"', () => {
        const note = noteOf({ state: 'missing', exitCode: null, reason: 'Evicted: low on memory', logTail: '' });
        expect(note).toBe('service "db" (mongo) missing — Evicted: low on memory; declared gates skipped');
        expect(noteOf({ state: 'missing', exitCode: null, reason: null, logTail: '' })).toContain('missing — gone;');
    });

    it('carries the failed restart before the rest of the note', () => {
        const failed = { state: 'missing', exitCode: null, reason: 'container removed', restartFailure: 'no network' };
        expect(noteOf(failed)).toBe(
            'service "db" (mongo) missing — container removed; restart failed: no network; declared gates skipped'
        );
    });
});

describe('a draftable ledger (issues #560, #573)', () => {
    const gateFailed = parts({ failure: { name: 't', exitCode: 1, output: '' } });

    it('holds only when every fault is a service', () => {
        expect(draftable(ledgerOf(parts({ deadServices: [dead] })), false)).toBe(true);
        expect(draftable(ledgerOf(parts({})), false)).toBe(false);
        expect(
            draftable(ledgerOf(parts({ deadServices: [dead], outcome: { ...parts({}).outcome, exitCode: 1 } })), false)
        ).toBe(false);
    });

    it('admits a failed gate only when asked, and never over another fault', () => {
        expect(draftable(ledgerOf(gateFailed), false)).toBe(false);
        expect(draftable(ledgerOf(gateFailed), true)).toBe(true);
        expect(
            draftable(ledgerOf({ ...gateFailed, helperFailure: parts({ helperFailure: helper }).helperFailure }), true)
        ).toBe(false);
    });
});

describe('the fault ledger', () => {
    it('is empty, succeeded and fully eligible for a clean run', () => {
        const ledger = ledgerOf(parts());
        expect(ledger).toEqual([]);
        expect(statusOf(ledger)).toBe('succeeded');
        expect(kindOf(ledger)).toBeNull();
        expect(gatesEligible(ledger) && publishEligible(ledger)).toBe(true);
        expect(skipWhyOf(ledger)).toBeNull();
    });

    it('ranks every pair of faults by RANK, and every single fault names its own kind', () => {
        for (const kind of RANK) expect(kindOf(ledgerOf(single(kind)))).toBe(kind);
        for (const [i, a] of RANK.entries()) {
            for (const b of RANK.slice(i + 1)) {
                const ledger = ledgerOf(merge(single(a), single(b)));
                expect(statusOf(ledger)).toBe('failed');
                expect(kindOf(ledger), `${a} + ${b}`).toBe(a);
                expect(publishEligible(ledger)).toBe(false);
            }
        }
    });

    it('lets only a timeout, a gate, services, a helper or a publish leave the gates running', () => {
        const runs = (kind: FailureKind): boolean => gatesEligible(ledgerOf(single(kind)));
        expect(RANK.filter(runs)).toEqual(['timeout', 'services', 'gate', 'helper', 'policy', 'publish']);
        // A non-zero exit that is the timeout's own kill still leaves the work to judge.
        expect(gatesEligible(agentFaults(outcome({ timedOut: true, exitCode: 137 })))).toBe(true);
    });

    it('names the most decisive blocking fault as the skip reason', () => {
        expect(skipWhyOf(agentFaults(outcome({ exitCode: null })))).toBe("the agent's run exited without an exit code");
        expect(skipWhyOf(agentFaults(outcome({ finishReason: 'length' })))).toBe(
            "the agent's run ended before it finished"
        );
        expect(skipWhyOf(agentFaults(outcome({ exitCode: 1, blockedLine: 'x' })))).toBe(
            'the agent reported it is blocked'
        );
        // A cache-killed run's finish reason is not a second premature stop.
        expect(agentFaults(outcome({ cacheLost: 'c', finishReason: 'length' }))).toHaveLength(1);
    });

    it('reads the blocked marker from the close-time line, else the output tail', () => {
        expect(agentFaults(outcome({ output: 'a\nFACTORY_BLOCKED: no access' }))[0]?.note).toBe(
            'the agent reported it is blocked: no access'
        );
        expect(agentFaults(outcome({ output: 'FACTORY_BLOCKED: x', summary: 's' }))).toEqual([]);
        // A marker the collapsed summary merely mentions is not the agent's last line.
        expect(
            agentFaults(outcome({ summary: 'Added FACTORY_BLOCKED: handling and verified all tests pass.' }))
        ).toEqual([]);
        expect(agentFaults(outcome({ blockedLine: '   ' }))[0]?.note).toContain('no reason given');
    });

    it('ignores a marker line far above the final message, and one that does not start a line', () => {
        const far = ['FACTORY_BLOCKED: early worry', ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join('\n');
        expect(agentFaults(outcome({ output: far }))).toEqual([]);
        expect(agentFaults(outcome({ output: 'the docs mention FACTORY_BLOCKED: as a marker' }))).toEqual([]);
    });

    // Seen live (opencode, 2026-10-13): a finished run ended on `FACTORY_BLOCKED: Not blocked`.
    it('reads a "not blocked" marker as not blocked, and still a real reason that starts with "no"', () => {
        expect(agentFaults(outcome({ blockedLine: 'Not blocked' }))).toEqual([]);
        expect(agentFaults(outcome({ output: 'done\nFACTORY_BLOCKED: not blocked — task complete' }))).toEqual([]);
        expect(
            agentFaults(outcome({ blockedLine: 'not blocking anything, but no access to the registry' }))[0]?.note
        ).toBe('the agent reported it is blocked: not blocking anything, but no access to the registry');
    });

    it('reads a "none" marker as not blocked, on either path', () => {
        expect(agentFaults(outcome({ blockedLine: 'none — work complete and committed locally' }))).toEqual([]);
        expect(agentFaults(outcome({ blockedLine: 'None.' }))).toEqual([]);
        expect(agentFaults(outcome({ output: 'done\nFACTORY_BLOCKED: none' }))).toEqual([]);
        expect(agentFaults(outcome({ blockedLine: 'nonexistent Jira ticket' }))[0]?.note).toBe(
            'the agent reported it is blocked: nonexistent Jira ticket'
        );
    });

    it('places the gates-skipped line after the last skipping fault', () => {
        const ledger = ledgerOf(merge(SINGLE.blocked, SINGLE.helper));
        const lines = outputOf(ledger, 'the agent reported it is blocked').split('\n[driver] ').slice(1);
        expect(lines.map((line) => line.split(' ')[0])).toEqual(['the', 'gates', 'helper']);
    });
});

describe('the failure cause (#581)', () => {
    const helperFailing = (reason: HelperFailureReason): LedgerParts =>
        parts({ helperFailure: { helperId: 'h', result: { ok: false, reason, message: 'm' } } as HelperFailureReport });
    const publishFailing = (cause: FailureCause): LedgerParts =>
        parts({ published: { ok: false, published: false, reason: 'r', cause } as never });

    it('names a failed gate a verification failure', () => {
        expect(causeOf(ledgerOf(SINGLE.gate))).toBe('verification');
    });

    it.each<[HelperFailureReason, FailureCause]>([
        ['auth_failed', 'denied'],
        ['timeout', 'transport'],
        ['runner_error', 'transport'],
        ['unknown_helper', 'config'],
        ['wrong_version', 'config'],
        ['invalid_control', 'config'],
        ['invalid_composite_plan', 'config'],
        ['malformed_output', 'unknown'],
        ['oversized_output', 'unknown'],
    ])('reads a helper failing with %s as %s', (reason, cause) => {
        expect(causeOf(ledgerOf(helperFailing(reason)))).toBe(cause);
    });

    it('carries the publish result its own cause', () => {
        expect(causeOf(ledgerOf(publishFailing('conflict')))).toBe('conflict');
        expect(causeOf(ledgerOf(publishFailing('denied')))).toBe('denied');
    });

    it('follows RANK: the cause belongs to the fault kindOf names', () => {
        const ledger = ledgerOf(merge(SINGLE.gate, publishFailing('denied')));
        expect(kindOf(ledger)).toBe('gate');
        expect(causeOf(ledger)).toBe('verification');
        expect(causeOf(ledgerOf(merge(helperFailing('auth_failed'), publishFailing('transport'))))).toBe('denied');
    });

    it('names no cause for a success or any other kind', () => {
        expect(causeOf(ledgerOf(parts()))).toBeNull();
        for (const kind of ['timeout', 'cache_lost', 'blocked', 'services', 'policy', 'runner_error'] as const) {
            expect(causeOf(ledgerOf(SINGLE[kind]))).toBeNull();
        }
        // A timeout outranks the gate that still ran over it: the kind is timeout, so no cause.
        expect(causeOf(ledgerOf(merge(SINGLE.timeout, SINGLE.gate)))).toBeNull();
    });
});
