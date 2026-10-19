import { describe, expect, it } from 'vitest';
import {
    adoptedVerdictOf,
    infraLossOf,
    killEndsGroup,
    killRecordsOf,
    reportFinalized,
    reportVerdictOf,
    type TerminationEvidence,
} from '../src/termination.js';
import { finalReportOf, SUPERVISOR_REPORT_PREFIX } from '../src/supervisor-contract.js';

const NONE: TerminationEvidence = {
    killedByDriver: false,
    timedOut: false,
    reported: false,
    vanished: null,
    unfinalized: null,
};
const VANISHED = 'the runner container was removed before it exited (exit 137)';
const UNFINALIZED = 'the task supervisor ended before it finalized the run (exit 70)';

describe('infraLossOf', () => {
    it('never calls a run the driver killed itself a loss, whatever else was lost', () => {
        expect(infraLossOf({ ...NONE, killedByDriver: true, vanished: VANISHED, unfinalized: UNFINALIZED })).toBeNull();
    });

    it('never calls a run its budget ended a loss', () => {
        expect(infraLossOf({ ...NONE, timedOut: true, vanished: VANISHED, unfinalized: UNFINALIZED })).toBeNull();
    });

    it('names a runner the platform took away before a supervisor that never finalized, report or not', () => {
        expect(infraLossOf({ ...NONE, vanished: VANISHED, unfinalized: UNFINALIZED })).toBe(VANISHED);
        expect(infraLossOf({ ...NONE, reported: true, vanished: VANISHED })).toBe(VANISHED);
    });

    it('takes a supervisor that reported as finalized, whatever its exit after', () => {
        expect(infraLossOf({ ...NONE, reported: true, unfinalized: UNFINALIZED })).toBeNull();
    });

    it('falls back to the unfinalized supervisor, and to no loss at all', () => {
        expect(infraLossOf({ ...NONE, unfinalized: UNFINALIZED })).toBe(UNFINALIZED);
        expect(infraLossOf(NONE)).toBeNull();
    });
});

describe('the recorded kill reasons', () => {
    it('reads only the closed set of reasons off a mark map', () => {
        expect(
            killRecordsOf({
                'factory.kill.timeout': '',
                'factory.kill.cache_lost': 'three turns without a cache hit',
                'factory.kill.stopped': 'x',
                'factory.lease': 'irrelevant',
            })
        ).toEqual([
            { reason: 'timeout', detail: '' },
            { reason: 'cache_lost', detail: 'three turns without a cache hit' },
        ]);
        expect(killRecordsOf(undefined)).toEqual([]);
    });

    it('takes the hard-kill reasons as the end of the whole group, a full spool as a supervised stop', () => {
        expect(killEndsGroup('timeout')).toBe(true);
        expect(killEndsGroup('cache_lost')).toBe(true);
        expect(killEndsGroup('artifact_spool_full')).toBe(false);
    });

    it('turns every recorded reason into its outcome field, so the ledger ranks them as it ranks a live run', () => {
        expect(adoptedVerdictOf([])).toEqual({});
        expect(
            adoptedVerdictOf([
                { reason: 'cache_lost', detail: 'collapsed' },
                { reason: 'timeout', detail: '' },
                { reason: 'artifact_spool_full', detail: '2000000000 bytes' },
            ])
        ).toEqual({ timedOut: true, cacheLost: 'collapsed', artifactSpoolFull: '2000000000 bytes' });
        // An empty detail still says the reason stood.
        expect(adoptedVerdictOf([{ reason: 'cache_lost', detail: '' }]).cacheLost).toBeTruthy();
        expect(adoptedVerdictOf([{ reason: 'artifact_spool_full', detail: '' }]).artifactSpoolFull).toBeTruthy();
    });
});

describe('the final report a supervisor logs (#824)', () => {
    const line = (report: Record<string, unknown>) => `${SUPERVISOR_REPORT_PREFIX}${JSON.stringify(report)}`;
    const COMPLETED = { outcome: 'completed', cause: null, agentExit: 0, agentEnd: 'exit', drained: true };

    it('reads the last report line of the log, and nothing from a log without one', () => {
        const log = ['serving', line({ ...COMPLETED, agentExit: 1 }), 'more', line(COMPLETED), ''].join('\n');
        expect(finalReportOf(log)).toEqual(COMPLETED);
        expect(finalReportOf('serving\nno report\n')).toBeNull();
    });

    it('reads a malformed report as none', () => {
        expect(finalReportOf(`${SUPERVISOR_REPORT_PREFIX}{not json`)).toBeNull();
        expect(finalReportOf(line({ outcome: 'completed' }))).toBeNull();
    });

    it('takes a report as finalization unless its agent was never launched', () => {
        expect(reportFinalized(null)).toBe(false);
        expect(reportFinalized(COMPLETED)).toBe(true);
        expect(reportFinalized({ ...COMPLETED, outcome: 'lost', cause: 'driver_lost', agentEnd: 'unlaunched' })).toBe(
            false
        );
    });

    it('turns a budget and a full spool the supervisor raised itself into their outcome fields', () => {
        expect(reportVerdictOf(null)).toEqual({});
        expect(reportVerdictOf(COMPLETED)).toEqual({});
        expect(reportVerdictOf({ ...COMPLETED, outcome: 'timed_out', cause: 'timeout' })).toEqual({ timedOut: true });
        expect(reportVerdictOf({ ...COMPLETED, outcome: 'failed', cause: 'artifact_spool_full' })).toEqual({
            artifactSpoolFull: 'the supervisor reported the spool full',
        });
    });
});
