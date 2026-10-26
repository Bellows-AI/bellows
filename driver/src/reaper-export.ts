import type { BoardThreadFacts } from './board/board.js';
import { DEFAULT_TASK_VOLUME_EXPORT_ATTEMPTS } from './config.js';
import type { ReaperArm, ReaperObserver, VolumeThread } from './reaper.js';

/**
 * The reaper's export-before-delete (issue #938): a thread that is not whole may hold transcript records
 * only its volume knows are unacknowledged, so its volume is deleted only after an export proved a drain
 * or `attempts` of them failed. The platform arms run the exporter (`ReaperArm.exportVolume`); this file
 * decides when, how often and what a result licenses.
 */

/** The newest attempt of a thread: the job id and claim sequence its transcript streams are filed under. */
export interface VolumeExportAttempt {
    jobId: string;
    claimSeq: number;
}

/**
 * What a volume export proved. `drained`: every record the volume held was acknowledged and the streams were
 * closed. `never_started`: the export workload could not be created or scheduled. `inconclusive`: it ran, or
 * its outcome could not be read, without proving a drain.
 */
export type VolumeExport =
    | { result: 'drained' }
    | { result: 'inconclusive'; why: string }
    | { result: 'never_started'; why: string };

export type VolumeExportResult = VolumeExport['result'];

/** Whether a thread left nothing behind that only its volume holds: its artifacts all terminal and a complete checkpoint. */
export const isWhole = (facts: BoardThreadFacts): boolean => facts.artifactsComplete && facts.checkpoint === 'complete';

/** `delete`: the volumes may go now. `keep`: not this round. `abort`: the reaper was stopped mid-export. */
export type ExportVerdict = 'delete' | 'keep' | 'abort';

export function createVolumeExportGate(deps: {
    /** Failed re-exports of one thread tolerated before its volume is deleted anyway. */
    attempts: number | undefined;
    log: (message: string) => void;
    observe: ReaperObserver | undefined;
    onUnproven: () => void;
    /** The thread's root row read alone, right now: its facts, or undefined when the read proved nothing or the row is gone. */
    reread: (root: string) => Promise<BoardThreadFacts | undefined>;
}) {
    const attempts = deps.attempts ?? DEFAULT_TASK_VOLUME_EXPORT_ATTEMPTS;
    const { log, onUnproven } = deps;
    // In memory per thread root: a driver restart starts the count over.
    const failures = new Map<string, number>();
    let exporting: AbortController | null = null;

    /** Runs the arm's export; null when the reaper was stopped meanwhile. A throw is an inconclusive result. */
    const runExport = async (
        arm: ReaperArm,
        thread: VolumeThread,
        attempt: VolumeExportAttempt
    ): Promise<VolumeExport | null> => {
        const controller = new AbortController();
        exporting = controller;
        let outcome: VolumeExport;
        try {
            outcome = await arm.exportVolume!(thread, attempt, controller.signal);
        } catch (e) {
            outcome = { result: 'inconclusive', why: `the export threw: ${(e as Error).message}` };
        } finally {
            exporting = null;
        }
        return controller.signal.aborted ? null : outcome;
    };

    /** The thread, read again right before the delete: still finalized, still the attempt that was exported. */
    const unchanged = async (thread: VolumeThread, attempt: VolumeExportAttempt): Promise<boolean> => {
        const again = await deps.reread(thread.root);
        const same =
            again !== undefined &&
            !again.live &&
            again.lastFinalizedAt !== null &&
            again.lastJobId === attempt.jobId &&
            again.lastClaimSeq === attempt.claimSeq;
        if (!same) {
            onUnproven();
            if (again !== null)
                log(`reaper: thread ${thread.root} — not the thread that was exported, keeping its volumes`);
        }
        return same;
    };

    const lost = (root: string, last: string): void => {
        deps.observe?.volumeExport?.('lost');
        log(
            `reaper: LOST transcript bytes — thread ${root}: ${failures.get(root) ?? 0} export attempts failed (last: ${last}); deleting its task volumes, whatever they held unacknowledged is gone`
        );
    };

    /** One failed attempt; true once the last one has failed. */
    const failed = (root: string, outcome: Exclude<VolumeExport, { result: 'drained' }>): boolean => {
        const count = (failures.get(root) ?? 0) + 1;
        failures.set(root, count);
        onUnproven();
        log(
            `reaper: thread ${root} — the transcript export did not drain (${outcome.result}, attempt ${count} of ${attempts}): ${outcome.why}`
        );
        return count >= attempts;
    };

    /** The delete, if the thread is still the one that was exported; a loss when the volume goes with unexported bytes. */
    const finish = async (
        thread: VolumeThread,
        attempt: VolumeExportAttempt,
        last: string | null
    ): Promise<ExportVerdict> => {
        if (!(await unchanged(thread, attempt))) return 'keep';
        if (last !== null) lost(thread.root, last);
        return 'delete';
    };

    /** What an export's result licenses: only a drain deletes at once; the last failed attempt deletes loudly. */
    const settle = async (
        thread: VolumeThread,
        attempt: VolumeExportAttempt,
        outcome: VolumeExport | null
    ): Promise<ExportVerdict> => {
        if (outcome === null) {
            onUnproven();
            log(`reaper: thread ${thread.root} — the transcript export was aborted, keeping its volumes`);
            return 'abort';
        }
        deps.observe?.volumeExport?.(outcome.result);
        if (outcome.result === 'drained') return finish(thread, attempt, null);
        return failed(thread.root, outcome) ? finish(thread, attempt, outcome.why) : 'keep';
    };

    return {
        /** A thread live on the board starts over with its attempts. */
        seen(root: string, facts: BoardThreadFacts | undefined): void {
            if (facts?.live) failures.delete(root);
        },
        deleted: (root: string): void => void failures.delete(root),
        abort: (): void => exporting?.abort(),

        /**
         * Whether a thread the board condemned may be deleted now. Whole threads, rows without facts and arms
         * that cannot export pass straight through. Otherwise only a `drained` export licenses the delete
         * (one export per round: each holds the serialized sweep); any other result is a failed attempt, and
         * only the last of them deletes anyway, loudly.
         */
        async beforeDelete(
            thread: VolumeThread,
            facts: BoardThreadFacts | undefined,
            arm: ReaperArm,
            round: { exported: boolean }
        ): Promise<ExportVerdict> {
            if (!arm.exportVolume || !facts || isWhole(facts)) return 'delete';
            const attempt = { jobId: facts.lastJobId, claimSeq: facts.lastClaimSeq };
            // The last attempt failed but the delete did not happen (a refused read or delete): no more tries.
            if ((failures.get(thread.root) ?? 0) >= attempts) {
                return finish(thread, attempt, 'the previous attempt did not drain');
            }
            if (round.exported) return 'keep';
            round.exported = true;
            return settle(thread, attempt, await runExport(arm, thread, attempt));
        },
    };
}
