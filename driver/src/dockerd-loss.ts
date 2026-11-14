import type { BoardJob } from './board/board.js';
import type { Read, Runner } from './runner.js';

/**
 * A docker class's daemon (`dockerd`, kubernetes only) lost under a gate. Its restart count is read
 * before the verdict gates and again after a failed one: a count that moved is an infrastructure
 * loss, interrupted like a node loss and redone by the next claim; a read that proves nothing is a
 * blocked interruption; an unchanged count lets the gate's verdict stand. A passing gate is never
 * questioned. An ad-hoc gate run gets a note in its answer and interrupts nothing.
 */

/** What the two reads around a gate prove of the daemon. */
export type DaemonVerdict = 'none' | 'kept' | 'restarted' | 'unknown';

/** The run's daemon: none (`absent`) for a class without one, and for an executor that has no such class. */
export async function readDaemon(runner: Runner, job: BoardJob, signal: AbortSignal): Promise<Read<number>> {
    if (!runner.dockerdRestarts) return { kind: 'absent' };
    return runner
        .dockerdRestarts(job, signal)
        .catch((e: unknown): Read<number> => ({ kind: 'inconclusive', reason: (e as Error).message }));
}

/** Two reads compared: a class with no daemon is `none`; anything but two counts is `unknown`, never `kept`. */
export function daemonVerdict(before: Read<number>, after: Read<number>): DaemonVerdict {
    if (before.kind === 'absent' && after.kind === 'absent') return 'none';
    if (before.kind !== 'value' || after.kind !== 'value') return 'unknown';
    // A lower count is a replaced pod: no more the daemon the gate began with than a higher one.
    return after.value === before.value ? 'kept' : 'restarted';
}

const readWords = (read: Read<number>): string =>
    read.kind === 'value' ? `restart count ${read.value}` : read.kind === 'absent' ? 'no dockerd listed' : read.reason;

/** A failed verdict gate's daemon loss: the infrastructure-loss interruption's words and flags, never a verdict. */
export class DaemonLost extends Error {
    readonly flags: { nodeLoss?: true; blocked?: true };

    constructor(verdict: 'restarted' | 'unknown', before: Read<number>, after: Read<number>) {
        super(
            verdict === 'restarted'
                ? `the docker daemon (dockerd) restarted under the gates (${readWords(before)} → ${readWords(after)}); the gate failure is no verdict`
                : `the docker daemon (dockerd) could not be confirmed around a failed gate (before: ${readWords(before)}; after: ${readWords(after)})`
        );
        this.name = 'DaemonLost';
        this.flags = verdict === 'restarted' ? { nodeLoss: true } : { blocked: true };
    }
}

/**
 * Runs the verdict gates between two daemon reads, per gates phase (never a baseline kept across a
 * takeover): after a failure — unless the attempt stood down — throws `DaemonLost` unless the daemon
 * is confirmed kept, or the run has none. A class with no daemon reads nothing more.
 */
export async function gatesUnderDaemon<T>(
    runner: Runner,
    job: BoardJob,
    signal: AbortSignal,
    gates: () => Promise<T | null>
): Promise<T | null> {
    const before = await readDaemon(runner, job, signal);
    const failure = await gates();
    if (failure === null || signal.aborted || before.kind === 'absent') return failure;
    const after = await readDaemon(runner, job, signal);
    const verdict = daemonVerdict(before, after);
    if (verdict === 'restarted' || verdict === 'unknown') throw new DaemonLost(verdict, before, after);
    return failure;
}

/** The note an ad-hoc gate answer carries when the daemon restarted under it. */
export const DOCKERD_RESTART_NOTE =
    'the docker daemon (dockerd) restarted while this gate ran: its failure may be the restart, not the code';

/**
 * Runs one ad-hoc gate and, when it answered a failing exit while the daemon's restart count moved,
 * adds `dockerd: DOCKERD_RESTART_NOTE` to its answer. An unconfirmed read adds nothing: a note is
 * no verdict either way, and the attempt is never interrupted for it.
 */
export async function withDaemonNote(
    read: ((signal: AbortSignal) => Promise<Read<number>>) | undefined,
    signal: AbortSignal,
    run: () => Promise<{ status: number; body: unknown }>
): Promise<{ status: number; body: unknown }> {
    if (!read) return run();
    const safe = (): Promise<Read<number>> =>
        read(signal).catch((e: unknown): Read<number> => ({ kind: 'inconclusive', reason: (e as Error).message }));
    const before = await safe();
    const result = await run();
    const exitCode = (result.body as { exitCode?: unknown } | null)?.exitCode;
    if (before.kind !== 'value' || typeof exitCode !== 'number' || exitCode === 0) return result;
    if (daemonVerdict(before, await safe()) !== 'restarted') return result;
    return { ...result, body: { ...(result.body as object), dockerd: DOCKERD_RESTART_NOTE } };
}
