import type { BoardJob, BoardThreadFacts } from './board/board.js';
import { transcriptDir } from './claim.js';
import { DEFAULT_TASK_VOLUME_EXPORT_ATTEMPTS } from './config.js';
import { VOLUME_EXPORT_CAUSE } from './loop/loop-export.js';
import type { ReaperArm, ReaperObserver, VolumeThread } from './reaper.js';
import { generationOfName, taskRootOf } from './task-volume.js';

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
 * its outcome could not be read, without proving a drain. `contended`: another export (a second driver replica's)
 * holds the thread's workload name, so none ran here; it counts as no failed attempt.
 */
export type VolumeExport =
    | { result: 'drained' }
    /** The volume was already gone (proven by the platform's own "no such volume"): nothing to export, nothing exported. */
    | { result: 'gone' }
    | { result: 'inconclusive'; why: string }
    | { result: 'never_started'; why: string }
    | { result: 'contended'; why: string };

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
            if (again !== undefined)
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
    const failed = (
        root: string,
        outcome: Exclude<VolumeExport, { result: 'drained' | 'gone' | 'contended' }>
    ): boolean => {
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
        if (outcome.result === 'drained' || outcome.result === 'gone') return finish(thread, attempt, null);
        if (outcome.result === 'contended') {
            onUnproven();
            log(`reaper: thread ${thread.root} — ${outcome.why}, keeping its volumes`);
            return 'keep';
        }
        return failed(thread.root, outcome) ? finish(thread, attempt, outcome.why) : 'keep';
    };

    return {
        /** A thread live on the board starts over with its attempts. */
        seen(root: string, facts: BoardThreadFacts | undefined): void {
            if (facts?.live) failures.delete(root);
        },
        deleted: (root: string): void => void failures.delete(root),
        /** A sweep's round: forgets the attempts of roots that no longer have a volume (deleted by another replica or by hand). */
        begin(roots: readonly string[]): { exported: boolean } {
            const keep = new Set(roots);
            for (const root of failures.keys()) if (!keep.has(root)) failures.delete(root);
            return { exported: false };
        },
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
            // No attempt was ever claimed: no runner wrote a transcript, so the volume holds nothing to export.
            if (facts.lastJobId === null || facts.lastClaimSeq === null) return 'delete';
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

/** The time a volume export keeps after its work ends, to remove its workload: the deadline covers both. */
export const VOLUME_EXPORT_CLEANUP_MS = 20_000;

/** One export's clock: the absolute `deadline` of everything, the `workEnd` of the work before the cleanup reserve. */
export interface VolumeExportClock {
    deadline: number;
    workEnd: number;
    /** The exporter's own give-up timers: below the work, so it ends itself before the driver's kill. */
    giveUpMs: number;
}

export function volumeExportClock(drainMs: number, now: number): VolumeExportClock {
    const cleanup = Math.min(VOLUME_EXPORT_CLEANUP_MS, Math.floor(drainMs / 2));
    const work = drainMs - cleanup;
    return { deadline: now + drainMs, workEnd: now + work, giveUpMs: Math.max(1, Math.floor(work / 2)) };
}

/** The thread's highest-generation volume: the only one a restore would reach. Null when none reads as a generation. */
export function newestVolume(thread: VolumeThread): VolumeThread['volumes'][number] | null {
    let best: { volume: VolumeThread['volumes'][number]; generation: number } | null = null;
    for (const volume of thread.volumes) {
        const generation = generationOfName(thread.root, volume.name);
        if (generation !== null && (best === null || generation > best.generation)) best = { volume, generation };
    }
    return best?.volume ?? null;
}

/** Whether an export workload created at `createdMs` is past its own whole budget (`drainMs`, cleanup included): only then is it provably stale. */
export const exportWorkloadStale = (createdMs: number, drainMs: number, nowMs: number): boolean =>
    Number.isFinite(createdMs) && nowMs - createdMs > drainMs;

/** The name of a thread's export workload: one per thread, so a stale one is found and removed by name. */
export const volumeExportName = (root: string): string => `factory-export-${taskRootOf({ id: root })}`;

/**
 * The one-shot exporter's env: the volume's transcript directory, the order to close every stream `partial`
 * with the export's cause, and the control endpoint it uploads through. Give-up timers sit below the deadline.
 */
export function volumeExportEnv(
    root: string,
    channel: { url: string; token: string },
    giveUpMs: number
): [string, string][] {
    return [
        ['CLAUDE_TRANSCRIPT_DIR', transcriptDir({ id: root } as BoardJob)],
        ['EXPORT_ONCE', 'partial'],
        ['EXPORT_ONCE_CAUSE', VOLUME_EXPORT_CAUSE],
        ['BELLOWS_CONTROL_URL', channel.url],
        ['BELLOWS_CONTROL_TOKEN', channel.token],
        ['EXPORT_GIVEUP_MS', String(giveUpMs)],
        ['EXPORT_DRAIN_GIVEUP_MS', String(giveUpMs)],
    ];
}
