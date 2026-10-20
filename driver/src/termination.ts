import { KILL_MARK_PREFIX } from './labels.js';
import type { RunOutcome } from './runner.js';
import type { FinalReport } from './supervisor-contract.js';

/**
 * How a started run ended, decided once over both executors: what the executor saw (a runner the
 * platform took away, a supervisor that ended without finalizing) ranked under what the driver
 * itself did (its own hard kill, the run budget). The reasons the driver ends a run for are
 * recorded on the attempt before the kill, so the claim that adopts the run after a lost driver
 * reads the same verdict the attached run would have.
 */

/** Why the driver ended a run itself — each one a verdict of its own, never an infrastructure loss. */
export const KILL_REASONS = ['timeout', 'cache_lost', 'artifact_spool_full'] as const;
export type KillReason = (typeof KILL_REASONS)[number];

export interface KillRecord {
    reason: KillReason;
    detail: string;
}

/** The mark one recorded reason is stored under. */
export const killMarkOf = (reason: KillReason): string => `${KILL_MARK_PREFIX}${reason}`;

/** The recorded reasons in a label or annotation map; anything outside the closed set is ignored. */
export function killRecordsOf(marks: Record<string, string> | undefined): KillRecord[] {
    if (!marks) return [];
    return KILL_REASONS.flatMap((reason) => {
        const detail = marks[killMarkOf(reason)];
        return detail === undefined ? [] : [{ reason, detail }];
    });
}

/**
 * A reason delivered by the driver's own hard kill of the whole group (the backstop, the cache
 * watch), which therefore explains the supervisor's exit. A full spool rides a supervised stop: the
 * supervisor still decides how its run ended.
 */
export const killEndsGroup = (reason: KillReason): boolean => reason !== 'artifact_spool_full';

/** What an executor saw of a started run's end. */
export interface TerminationEvidence {
    /** This driver hard-killed the group (docker `dockerKill`, kubernetes `killRunner`). */
    killedByDriver: boolean;
    /** The run budget ended the agent: the supervisor's report or its exit 124, the backstop, the kubelet deadline. */
    timedOut: boolean;
    /** The supervisor's report reached the driver: it finalized the agent's end. */
    reported: boolean;
    /** The runner was taken away under the run: a removed container, a deleted Job or pod, an eviction. */
    vanished: string | null;
    /** The supervisor ended any way but finalizing (`supervisorLossOf`). */
    unfinalized: string | null;
}

/** The infrastructure loss a started run's end amounts to, or null when it is a verdict on the work. */
export function infraLossOf(e: TerminationEvidence): string | null {
    if (e.killedByDriver || e.timedOut) return null;
    if (e.vanished !== null) return e.vanished;
    return e.reported ? null : e.unfinalized;
}

/**
 * Whether a supervisor's logged final report says it finalized a run. A group whose driver was lost
 * before the agent was released reports too (`unlaunched`), and exits 75: nothing ran to finalize.
 */
export const reportFinalized = (report: FinalReport | null): boolean =>
    report !== null && report.agentEnd !== 'unlaunched';

/** The outcome fields a supervisor's final report stands for: the budget, or a full spool it raised itself. */
export function reportVerdictOf(
    report: FinalReport | null
): Partial<Pick<RunOutcome, 'timedOut' | 'artifactSpoolFull'>> {
    const fields: Partial<Pick<RunOutcome, 'timedOut' | 'artifactSpoolFull'>> = {};
    if (report?.outcome === 'timed_out') fields.timedOut = true;
    if (report?.cause === 'artifact_spool_full') fields.artifactSpoolFull = 'the supervisor reported the spool full';
    return fields;
}

/**
 * The outcome fields the recorded reasons stand for. Every one is set, so the ledger ranks two
 * reasons that both fired (`RANK`) exactly as it ranks them on the attached run.
 */
export function adoptedVerdictOf(
    records: readonly KillRecord[]
): Partial<Pick<RunOutcome, 'timedOut' | 'cacheLost' | 'artifactSpoolFull'>> {
    const fields: Partial<Pick<RunOutcome, 'timedOut' | 'cacheLost' | 'artifactSpoolFull'>> = {};
    for (const { reason, detail } of records) {
        if (reason === 'timeout') fields.timedOut = true;
        if (reason === 'cache_lost') fields.cacheLost = detail || 'the cache watch ended the run';
        if (reason === 'artifact_spool_full') fields.artifactSpoolFull = detail || 'the spool cap was reached';
    }
    return fields;
}

/** Everything a started run's end is classified from: the executor's reads and the driver's own record. */
export interface EndEvidence {
    /** The reasons the driver recorded before it ended the run itself (adopted runs; empty when attached). */
    kills: readonly KillRecord[];
    /** This driver hard-killed the group (the kill ledger's `hard`). */
    driverKilledHard: boolean;
    /** The supervisor's final report, null when none was taken. */
    report: FinalReport | null;
    /** The budget ended the agent by a read the report and the kill records do not carry: the exit 124, the kubelet deadline. */
    budgetEnded: boolean;
    /** The runner was taken away under the run (`TerminationEvidence.vanished`). */
    vanished: string | null;
    /** The supervisor ended any way but finalizing (`supervisorLossOf`). */
    unfinalized: string | null;
}

/** How a started run ended: the budget's verdict, the infrastructure loss it amounts to, and the verdict fields recorded for it. */
export interface SettledEnd {
    timedOut: boolean;
    infraLoss: string | null;
    fields: Partial<Pick<RunOutcome, 'timedOut' | 'cacheLost' | 'artifactSpoolFull'>>;
}

/**
 * The one close-time classification, over all five ends of a started run (attached and adopted, on
 * both executors, and a vanished runner): a supervisor that finalized the run (`reportFinalized`)
 * leaves nothing for a vanished runner to explain, and counts as reported.
 */
export function settleEnd(e: EndEvidence): SettledEnd {
    const timedOut = e.budgetEnded || e.report?.outcome === 'timed_out' || e.kills.some((k) => k.reason === 'timeout');
    const finalized = reportFinalized(e.report);
    return {
        timedOut,
        infraLoss: infraLossOf({
            killedByDriver: e.driverKilledHard || e.kills.some((k) => killEndsGroup(k.reason)),
            timedOut,
            reported: finalized,
            vanished: finalized ? null : e.vanished,
            unfinalized: e.unfinalized,
        }),
        fields: { ...reportVerdictOf(e.report), ...adoptedVerdictOf(e.kills) },
    };
}
