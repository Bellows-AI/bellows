import { randomUUID } from 'node:crypto';
import type { DeclaredGate } from './board/board.js';
import type { GateRunOutcome, GateRunRow, GateRunSource } from './board/board-gate-runs.js';
import type { GateRun } from './gates.js';
import type { TreeProbe } from './publish/publish.js';

/** The longest the running row's write may take: awaited before the gate starts, so bounded. */
const RUNNING_WRITE_MS = 5_000;
/** The terminal row's own bound: it has to land after a cancel, so it never rides the cancelled signal. */
const TERMINAL_WRITE_MS = 5_000;

/** The tree around one gate run: content keys and the mutation guard, null where a probe could not tell. */
export interface GateMeasure {
    treeBefore: string | null;
    treeAfter: string | null;
    mutatedSince: boolean | null;
    startedAt: string;
    finishedAt: string;
}

/** What the running row is written with: the moment the gate's turn came and the tree it starts on. */
export interface GateRunStart {
    executionId: string;
    startedAt: string;
    treeBefore: string | null;
}

/** One tree probe around a gate: with `sinceMs`, the mutation guard asks whether anything was touched since. */
export type TreeProbeFn = (signal: AbortSignal, sinceMs?: number) => Promise<TreeProbe>;

/**
 * One recorded execution (issue #983), what the manager needs of it: the id, the probe, and the
 * `start` it awaits inside the checkout's queue right before the gate executes. A `start` that answers
 * false refuses the run: the gate never executes (`GateRecordRefused`).
 */
export interface GateExecution {
    executionId: string;
    probe?: TreeProbeFn | undefined;
    start?: ((info: GateRunStart) => Promise<boolean>) | undefined;
}

/** The gate-run record of one claim: its probe, gate identity and the board write behind both. */
export interface GateLedger {
    probe: TreeProbeFn;
    /** The identity hash of a declared gate's configuration (`gate-identity.ts`). */
    identity(gate: DeclaredGate): string;
    /** Whether the board took the row. Never throws; a false is "not recorded". */
    write(row: GateRunRow, signal?: AbortSignal): Promise<boolean>;
}

/** A gate refused because its running row could not be recorded: retryable, and the gate never started. */
export class GateRecordRefused extends Error {
    constructor() {
        super('the gate run could not be recorded on the board; retry the call');
        this.name = 'GateRecordRefused';
    }
}

const UNKNOWN_TREE: TreeProbe = { fingerprint: null, content: null, mutatedSince: null };

/** One probe, bounded: an abort, the deadline, a throw or a missing probe all read as unknown (null). */
function probeWithin(
    probe: TreeProbeFn | undefined,
    signal: AbortSignal | undefined,
    boundMs: number,
    sinceMs?: number
): Promise<TreeProbe> {
    if (!probe) return Promise.resolve(UNKNOWN_TREE);
    const deadline = AbortSignal.timeout(boundMs);
    const bound = signal ? AbortSignal.any([signal, deadline]) : deadline;
    return new Promise<TreeProbe>((resolve) => {
        const stop = (): void => resolve(UNKNOWN_TREE);
        bound.addEventListener('abort', stop, { once: true });
        if (bound.aborted) return stop();
        probe(bound, sinceMs).then(resolve, stop);
    });
}

/**
 * One gate run, recorded (issue #983): the tree is probed here — inside the checkout's queue, where the
 * manager calls it — so it is the tree this run runs on, never another run's. The running row is awaited
 * before `execute` runs the gate; one the board did not take refuses the run. Null when the run's signal
 * aborted before the gate could start.
 */
export async function measuredRun(
    execution: GateExecution,
    run: { signal: AbortSignal | undefined; probeTimeoutMs: number },
    execute: () => Promise<GateRun>
): Promise<GateRun | null> {
    const { signal, probeTimeoutMs } = run;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const before = await probeWithin(execution.probe, signal, probeTimeoutMs);
    if (signal?.aborted) return null;
    const info: GateRunStart = { executionId: execution.executionId, startedAt, treeBefore: before.content };
    if (execution.start && !(await execution.start(info).catch(() => false))) throw new GateRecordRefused();
    const verdict = await execute();
    const finishedAt = new Date().toISOString();
    const after = await probeWithin(execution.probe, signal, probeTimeoutMs, startedAtMs);
    const measure: GateMeasure = {
        // The content key, not the HEAD-bound fingerprint: a publish commits the same bytes after the
        // run, and the pass still certifies them.
        treeBefore: before.content,
        treeAfter: after.content,
        mutatedSince: after.mutatedSince,
        startedAt,
        finishedAt,
    };
    return { ...verdict, measure };
}

/** How one gate execution ended, as its caller saw it. */
export interface GateEnd {
    /** The manager's answer, when it gave one. */
    run?: GateRun | undefined;
    /** The exception it threw, when it did: the run's result is then unknown. */
    error?: unknown;
    /** The execution's own signal was aborted: whatever the run answered is the kill's, never a verdict. */
    cancelled?: boolean;
}

/** One gate execution's record: the id it carries, the hooks the manager calls, and the terminal write. */
export interface GateRecord {
    executionId: string;
    execution: GateExecution;
    /** Writes the one terminal row, once. Never throws: a row the board did not take is only "not recorded". */
    finish(end: GateEnd): Promise<void>;
}

/** The terminal outcome of an execution: only `passed` is ever reusable (`loop/gate-reuse.ts`). */
function outcomeOf({ run, error, cancelled }: GateEnd, started: boolean): Exclude<GateRunOutcome, 'running'> {
    const unfinished = started ? 'incomplete' : 'not_started';
    if (cancelled || error !== undefined || !run) return unfinished;
    if (run.setupFailed) return 'setup_failed';
    if (run.exitCode === null) return unfinished;
    return run.exitCode === 0 ? 'passed' : 'failed';
}

/** The one terminal row of an execution: its outcome and, for a run that ended, what was measured around it. */
function terminalRow(base: Identified, end: GateEnd, started: GateRunStart | null): GateRunRow {
    const outcome = outcomeOf(end, started !== null);
    const ran = outcome === 'passed' || outcome === 'failed';
    const measure = ran ? end.run?.measure : undefined;
    return {
        ...base,
        outcome,
        exitCode: ran || outcome === 'setup_failed' ? (end.run?.exitCode ?? null) : null,
        treeBefore: measure?.treeBefore ?? (outcome === 'incomplete' ? (started?.treeBefore ?? null) : null),
        treeAfter: measure?.treeAfter ?? null,
        mutatedSince: measure?.mutatedSince ?? null,
        startedAt: measure?.startedAt ?? started?.startedAt ?? null,
        finishedAt: new Date().toISOString(),
    };
}

/** The fields of a row that name the execution: the same on its running and its terminal row. */
type Identified = Pick<GateRunRow, 'executionId' | 'gate' | 'identity' | 'filtered' | 'source'>;

/**
 * Mints the execution id and records one gate run (issue #983): the manager calls `execution.start`
 * inside the checkout's queue right before the gate executes — the `running` row — and the caller
 * calls `finish` on every exit, whatever happened, for exactly one terminal row. `requireRecord`
 * makes a running write the board did not take refuse the run (`start` answers false): the ad-hoc call
 * never executes a gate it could not record.
 */
export function recordGateRun(
    ledger: GateLedger,
    target: {
        gate: DeclaredGate;
        source: GateRunSource;
        filtered: boolean;
        requireRecord: boolean;
        signal?: AbortSignal | undefined;
    }
): GateRecord {
    const { gate, requireRecord, signal } = target;
    const executionId = randomUUID();
    const base = {
        executionId,
        gate: gate.name,
        identity: ledger.identity(gate),
        filtered: target.filtered,
        source: target.source,
    };
    /** Set while the running row's write was attempted for a start the manager went on to make. */
    let started: GateRunStart | null = null;
    let finished = false;

    const write = async (row: GateRunRow, boundMs: number, cancel?: AbortSignal): Promise<boolean> => {
        try {
            const bound = AbortSignal.timeout(boundMs);
            return await ledger.write(row, cancel ? AbortSignal.any([cancel, bound]) : bound);
        } catch {
            return false;
        }
    };

    return {
        executionId,
        execution: {
            executionId,
            probe: ledger.probe,
            async start(info) {
                started = info;
                const landed = await write(
                    {
                        ...base,
                        outcome: 'running',
                        exitCode: null,
                        treeBefore: info.treeBefore,
                        treeAfter: null,
                        mutatedSince: null,
                        startedAt: info.startedAt,
                        finishedAt: null,
                    },
                    RUNNING_WRITE_MS,
                    signal
                );
                if (landed || !requireRecord) return true;
                started = null;
                return false;
            },
        },
        async finish(end) {
            if (finished) return;
            finished = true;
            await write(terminalRow(base, end, started), TERMINAL_WRITE_MS);
        },
    };
}
