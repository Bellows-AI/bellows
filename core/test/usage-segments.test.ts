import { describe, expect, it } from 'vitest';
import { accountContributions } from '../src/usage-segments.js';
import type { Destination } from '../src/usage-segments.js';
import type { ExecutionEvidence } from '../src/usage.js';
import { at, cumulative, delta, ev } from './usage-fixtures.js';

const run = (jobId: string): Destination => ({ kind: 'run', jobId });
const no = (reason: string): Destination => ({ kind: 'unassigned', reason }) as Destination;
const assignDeltas = (rows: ExecutionEvidence[], minutes: number[]) =>
    accountContributions(
        rows,
        minutes.map((m) => delta(m, 1))
    );

describe('delta assignment (half-open segments)', () => {
    const rows = [
        ev({ jobId: 'j1', rootJobId: 'j1', startedAt: at(0), endedAt: at(10) }),
        ev({ jobId: 'j2', rootJobId: 'j1', startedAt: at(10), endedAt: at(20) }),
    ];

    it('gives a point exactly at an end to the next segment and one at a start to its own', () => {
        expect(assignDeltas(rows, [0, 9, 10, 19])).toEqual([run('j1'), run('j1'), run('j2'), run('j2')]);
    });

    it('leaves a point at the very end of the last segment unassigned', () => {
        expect(assignDeltas(rows, [20])).toEqual([no('no-segment')]);
    });

    it('does not give a point in the gap of a shared session to the nearer run', () => {
        const gap = [
            ev({ jobId: 'j1', rootJobId: 'j1', startedAt: at(0), endedAt: at(10) }),
            ev({ jobId: 'j2', rootJobId: 'j1', startedAt: at(12), endedAt: at(20) }),
        ];
        expect(assignDeltas(gap, [5, 11, 15])).toEqual([run('j1'), no('no-segment'), run('j2')]);
    });

    it('reports overlap for two jobs on one session, also when only one of them is confirmed', () => {
        const both = [
            ev({ jobId: 'j1', startedAt: at(0), endedAt: at(10) }),
            ev({ jobId: 'j2', startedAt: at(5), endedAt: at(15) }),
        ];
        expect(assignDeltas(both, [3, 7, 12])).toEqual([run('j1'), no('overlap'), run('j2')]);
        const mixed = [
            both[0] as ExecutionEvidence,
            ev({ jobId: 'j2', startedAt: at(5), endedAt: at(15), launch: 'requested' }),
        ];
        expect(assignDeltas(mixed, [7])).toEqual([no('overlap')]);
    });

    it('keeps a backfilled row with no start out of every segment: its amount is task-owned, boundary unknown', () => {
        const noStart = ev({ jobId: 'b', rootJobId: 'b', origin: 'backfill', launch: 'unknown', startedAt: null });
        expect(assignDeltas([noStart], [5])).toEqual([no('unknown-boundary')]);
        // ...and it never claims a run another row proves: a confirmed segment still wins its own span.
        const real = ev({ jobId: 'j', rootJobId: 'b', startedAt: at(0), endedAt: at(10) });
        expect(assignDeltas([noStart, real], [5, 15])).toEqual([run('j'), no('unknown-boundary')]);
    });

    it('explains launch states: refused cover, unconfirmed, backfill', () => {
        const refused = [ev({ launch: 'refused' })];
        expect(assignDeltas(refused, [5])).toEqual([no('refused-launch')]);
        expect(assignDeltas([ev({ launch: 'requested' })], [5])).toEqual([no('unconfirmed-launch')]);
        expect(assignDeltas([ev({ launch: 'unknown' })], [5])).toEqual([no('unconfirmed-launch')]);
        expect(assignDeltas([ev({ origin: 'backfill', launch: 'unknown' })], [5])).toEqual([no('unknown-boundary')]);
        expect(assignDeltas([ev({ origin: 'backfill', launch: 'observed' })], [5])).toEqual([no('unknown-boundary')]);
    });

    it('does not let a refused segment overlap or cover: a confirmed run over the same time wins', () => {
        const rowsWithRefused = [ev({ jobId: 'j1', launch: 'refused' }), ev({ jobId: 'j2', launch: 'observed' })];
        expect(assignDeltas(rowsWithRefused, [5])).toEqual([run('j2')]);
    });

    it('treats an open segment as covering to +infinity and overlapping a later segment', () => {
        const open = [
            ev({ jobId: 'j1', startedAt: at(0), endedAt: null, live: true }),
            ev({ jobId: 'j2', startedAt: at(20), endedAt: at(30) }),
        ];
        expect(assignDeltas(open, [5, 25, 500])).toEqual([run('j1'), no('overlap'), run('j1')]);
    });
});

describe('cumulative assignment (the whole support must sit inside one run)', () => {
    const one = [ev({ startedAt: at(0), endedAt: at(10) })];
    const cum = (rows: ExecutionEvidence[], from: number, to: number) =>
        accountContributions(rows, [cumulative(from, to, 5)])[0];

    it('assigns a support inside the run', () => {
        expect(cum(one, 2, 5)).toEqual(run('j1'));
        expect(cum(one, 0, 9)).toEqual(run('j1'));
    });

    it('does not assign a support starting before the run, in a gap, or crossing the end', () => {
        expect(cum(one, -3, 5)).toEqual(no('cumulative-spans-runs'));
        expect(cum(one, 4, 10)).toEqual(no('cumulative-spans-runs'));
        expect(cum(one, 8, 15)).toEqual(no('cumulative-spans-runs'));
        expect(cum(one, 12, 15)).toEqual(no('no-segment'));
    });

    it('classifies a support touching two runs: spans runs, or overlap when the end instant is doubly covered', () => {
        const two = [
            ev({ jobId: 'j1', startedAt: at(0), endedAt: at(10) }),
            ev({ jobId: 'j2', startedAt: at(12), endedAt: at(20) }),
        ];
        expect(cum(two, 8, 15)).toEqual(no('cumulative-spans-runs'));
        const overlapping = [two[0] as ExecutionEvidence, ev({ jobId: 'j2', startedAt: at(5), endedAt: at(20) })];
        expect(cum(overlapping, 1, 7)).toEqual(no('overlap'));
    });

    it('explains unconfirmed and backfill runs only when the support is contained', () => {
        expect(cum([ev({ launch: 'requested' })], 2, 5)).toEqual(no('unconfirmed-launch'));
        expect(cum([ev({ origin: 'backfill', launch: 'unknown' })], 2, 5)).toEqual(no('unknown-boundary'));
        expect(cum([ev({ launch: 'requested' })], -3, 5)).toEqual(no('cumulative-spans-runs'));
    });
});

describe('same-job claims, adoption and retries', () => {
    const first = ev({ claimSeq: 1, launch: 'observed', startedAt: at(0), endedAt: at(10) });
    const recovered = ev({ claimSeq: 2, launch: 'observed', startedAt: at(15), endedAt: at(25) });
    const adopting = ev({ claimSeq: 2, launch: 'adopted', adoptsClaimSeq: 1, startedAt: at(15), endedAt: at(25) });

    it('does not cover the gap between two claims of one job unless the later one adopts the earlier', () => {
        expect(assignDeltas([first, recovered], [5, 12, 20])).toEqual([run('j1'), no('no-segment'), run('j1')]);
        expect(assignDeltas([first, adopting], [5, 12, 20])).toEqual([run('j1'), run('j1'), run('j1')]);
    });

    it('bridges a cumulative support across the gap only through adoption', () => {
        const spans = (rows: ExecutionEvidence[]) => accountContributions(rows, [cumulative(8, 20, 5)])[0];
        expect(spans([first, adopting])).toEqual(run('j1'));
        expect(spans([first, recovered])).toEqual(no('cumulative-spans-runs'));
        expect(spans([first])).toEqual(no('cumulative-spans-runs'));
    });

    it('gives the same assignments for points inside the adopted claim with and without the adopting row', () => {
        expect(assignDeltas([first], [0, 5, 9])).toEqual(assignDeltas([first, adopting], [0, 5, 9]));
    });

    it('counts duplicate evidence rows of one claim once (two sessions, wildcard agents)', () => {
        expect(assignDeltas([first, { ...first }], [5])).toEqual([run('j1')]);
    });

    it('keeps explicit retries separate: a new job after a failed one owns its own window', () => {
        const retry = [
            ev({ jobId: 'j1', rootJobId: 'j1', startedAt: at(0), endedAt: at(10) }),
            ev({ jobId: 'j2', rootJobId: 'j1', startedAt: at(11), endedAt: at(20) }),
        ];
        expect(assignDeltas(retry, [5, 10, 15])).toEqual([run('j1'), no('no-segment'), run('j2')]);
    });
});
