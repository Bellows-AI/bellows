import type { BoardJob } from './board/board.js';
import type { DaemonState, Read, Runner } from './runner.js';

/**
 * A docker class's daemon (`dockerd`, kubernetes only) lost under a gate. It is read — its restart
 * count and whether it runs — before the verdict gates and again after a failed one: a count that
 * moved, or a daemon not running at either read (OOM-killed and not restarted yet), is an
 * infrastructure loss, interrupted like a node loss and redone by the next claim; a read that proves
 * nothing is a blocked interruption; a daemon running at both reads with an unchanged count lets the
 * gate's verdict stand. A passing gate is never questioned. An ad-hoc gate run gets a note in its
 * answer and interrupts nothing.
 */

/** What the two reads around a gate prove of the daemon. */
export type DaemonVerdict = 'none' | 'kept' | 'lost' | 'unknown';

type DaemonRead = Read<DaemonState>;

const inconclusive = (e: unknown): DaemonRead => ({ kind: 'inconclusive', reason: (e as Error).message });

/** The run's daemon: none (`absent`) for a class without one, and for an executor that has no such class. */
export async function readDaemon(runner: Runner, job: BoardJob, signal: AbortSignal): Promise<DaemonRead> {
    if (!runner.dockerdRestarts) return { kind: 'absent' };
    return runner.dockerdRestarts(job, signal).catch(inconclusive);
}

/**
 * Two reads compared: a class with no daemon is `none`; anything but two daemon states is `unknown`,
 * never `kept`. `kept` only when it runs at both reads with the same count — a lower count is a
 * replaced pod, no more the daemon the gate began with than a higher one.
 */
export function daemonVerdict(before: DaemonRead, after: DaemonRead): DaemonVerdict {
    if (before.kind === 'absent' && after.kind === 'absent') return 'none';
    if (before.kind !== 'value' || after.kind !== 'value') return 'unknown';
    const { value: was } = before;
    const { value: is } = after;
    return was.running && is.running && was.restartCount === is.restartCount ? 'kept' : 'lost';
}

const readWords = (read: DaemonRead): string => {
    if (read.kind === 'absent') return 'no dockerd listed';
    if (read.kind === 'inconclusive') return read.reason;
    return `restart count ${read.value.restartCount}, ${read.value.running ? 'running' : 'not running'}`;
};

/** A failed verdict gate's daemon loss: the infrastructure-loss interruption's words and flags, never a verdict. */
export class DaemonLost extends Error {
    readonly flags: { nodeLoss?: true; blocked?: true; daemonLoss?: true };

    constructor(verdict: 'lost' | 'unknown', before: DaemonRead, after: DaemonRead) {
        const reads = `before: ${readWords(before)}; after: ${readWords(after)}`;
        super(
            verdict === 'lost'
                ? `the docker daemon (dockerd) restarted or was not running under the gates (${reads}); the gate failure is no verdict`
                : `the docker daemon (dockerd) could not be confirmed around a failed gate (${reads})`
        );
        this.name = 'DaemonLost';
        // The board bounds a run of `daemonLoss` hand-backs: the third consecutive one is no longer refunded.
        this.flags = verdict === 'lost' ? { nodeLoss: true, daemonLoss: true } : { blocked: true };
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
    if (verdict === 'lost' || verdict === 'unknown') throw new DaemonLost(verdict, before, after);
    return failure;
}

/** The note an ad-hoc gate answer carries when the daemon was lost under it. */
export const DOCKERD_RESTART_NOTE =
    'the docker daemon (dockerd) restarted or stopped while this gate ran: its failure may be the daemon, not the code';

/**
 * Runs one ad-hoc gate and, when it answered a failing exit while the daemon was lost (`daemonVerdict`),
 * adds `dockerd: DOCKERD_RESTART_NOTE` to its answer. An unconfirmed read adds nothing: a note is
 * no verdict either way, and the attempt is never interrupted for it.
 */
export async function withDaemonNote(
    read: ((signal: AbortSignal) => Promise<DaemonRead>) | undefined,
    signal: AbortSignal,
    run: () => Promise<{ status: number; body: unknown }>
): Promise<{ status: number; body: unknown }> {
    if (!read) return run();
    const safe = (): Promise<DaemonRead> => read(signal).catch(inconclusive);
    const before = await safe();
    const result = await run();
    const exitCode = (result.body as { exitCode?: unknown } | null)?.exitCode;
    if (before.kind !== 'value' || typeof exitCode !== 'number' || exitCode === 0) return result;
    if (daemonVerdict(before, await safe()) !== 'lost') return result;
    return { ...result, body: { ...(result.body as object), dockerd: DOCKERD_RESTART_NOTE } };
}
