import { describe, expect, it } from 'vitest';
import {
    adoptedVerdictOf,
    infraLossOf,
    killEndsGroup,
    killRecordsOf,
    reportFinalized,
    reportVerdictOf,
    type EndEvidence,
    settleEnd,
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
        expect(
            reportFinalized({ ...COMPLETED, outcome: 'lost', cause: 'lost', agentExit: null, agentEnd: 'lost' })
        ).toBe(false);
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

describe('settleEnd', () => {
    const REPORT = {
        outcome: null,
        cause: null,
        agentExit: 0,
        agentEnd: 'exited',
        drained: true,
    };
    const END: EndEvidence = {
        kills: [],
        driverKilledHard: false,
        budgetEnded: false,
        report: null,
        vanished: null,
        unfinalized: null,
    };

    it('is no loss for a run that ended clean, and carries no verdict fields', () => {
        expect(settleEnd(END)).toEqual({ timedOut: false, infraLoss: null, fields: {} });
    });

    it('takes a finalized report as the supervisor finalizing, whatever its exit after', () => {
        expect(settleEnd({ ...END, report: REPORT, unfinalized: UNFINALIZED }).infraLoss).toBeNull();
    });

    it('takes a report that finalized nothing as none: the supervisor lost is a loss, attached or adopted alike', () => {
        const unlaunched = { ...REPORT, agentEnd: 'unlaunched' };
        expect(settleEnd({ ...END, report: unlaunched, unfinalized: UNFINALIZED }).infraLoss).toBe(UNFINALIZED);
        expect(settleEnd({ ...END, unfinalized: UNFINALIZED }).infraLoss).toBe(UNFINALIZED);
    });

    it('takes a report of a lost agent as none: the loss stands, attached, vanished or adopted alike', () => {
        const lost = { ...REPORT, outcome: 'lost', agentExit: null, agentEnd: 'lost' };
        expect(settleEnd({ ...END, report: lost, unfinalized: UNFINALIZED }).infraLoss).toBe(UNFINALIZED);
        expect(settleEnd({ ...END, report: lost, vanished: VANISHED }).infraLoss).toBe(VANISHED);
    });

    it('takes a report of a lost agent as a loss on its own: the supervisor may log it and exit 0', () => {
        const lost = { ...REPORT, outcome: 'lost', agentExit: null, agentEnd: 'lost' };
        expect(settleEnd({ ...END, report: lost }).infraLoss).toMatch(/lost the agent/);
        expect(settleEnd({ ...END, report: lost, driverKilledHard: true }).infraLoss).toBeNull();
        expect(settleEnd({ ...END, report: lost, budgetEnded: true }).infraLoss).toBeNull();
    });

    it('takes a runner taken away under the run as a loss, whatever its supervisor reported on the way down', () => {
        expect(settleEnd({ ...END, vanished: VANISHED }).infraLoss).toBe(VANISHED);
        expect(settleEnd({ ...END, report: REPORT, vanished: VANISHED }).infraLoss).toBe(VANISHED);
        expect(settleEnd({ ...END, report: { ...REPORT, agentEnd: 'unlaunched' }, vanished: VANISHED }).infraLoss).toBe(
            VANISHED
        );
    });

    it('reads the budget off the report, a timeout record or the executor, and it is never a loss', () => {
        const timedOut = { ...REPORT, outcome: 'timed_out' };
        expect(settleEnd({ ...END, report: timedOut, vanished: VANISHED })).toMatchObject({
            timedOut: true,
            infraLoss: null,
            fields: { timedOut: true },
        });
        const kills = [{ reason: 'timeout' as const, detail: '' }];
        expect(settleEnd({ ...END, kills, unfinalized: UNFINALIZED })).toMatchObject({
            timedOut: true,
            infraLoss: null,
        });
        expect(settleEnd({ ...END, budgetEnded: true, unfinalized: UNFINALIZED })).toMatchObject({
            timedOut: true,
            infraLoss: null,
        });
    });

    it('never calls a run the driver killed a loss: its own hard kill, or a recorded reason that ends the group', () => {
        expect(settleEnd({ ...END, driverKilledHard: true, vanished: VANISHED }).infraLoss).toBeNull();
        const cache = [{ reason: 'cache_lost' as const, detail: 'cold' }];
        expect(settleEnd({ ...END, kills: cache, unfinalized: UNFINALIZED })).toMatchObject({
            infraLoss: null,
            fields: { cacheLost: 'cold' },
        });
    });

    it('lets a full spool ride a supervised stop: the supervisor still decides how the run ended', () => {
        const spool = [{ reason: 'artifact_spool_full' as const, detail: '' }];
        expect(settleEnd({ ...END, kills: spool, unfinalized: UNFINALIZED })).toMatchObject({
            infraLoss: UNFINALIZED,
            fields: { artifactSpoolFull: 'the spool cap was reached' },
        });
    });
});
