/**
 * The post-run phases' checkpoints (issue #829): gates, post-run helpers and publish each leave
 * their outcome on the board once they return, and an attempt that adopted a finished runner or took
 * a live one over resumes after the last phase that finished. A phase is served from its checkpoint
 * only while the chain before it is intact and the checkpoint validates field by field; every other
 * case — no read, an unreadable answer, a checkpoint bound to another tree — runs the phase and every
 * phase after it. Nothing here throws, and a checkpoint that cannot be written never fails the run.
 */

import type { BoardJob } from './board.js';
import type { CheckpointPhase, PhaseCheckpoint } from './board-phase-checkpoints.js';
import type { HelperFailureReport } from './helpers.js';
import type { GateFailure, GateReport } from './loop-gates.js';
import type { AttemptCtx } from './loop-types.js';
import type { PublishResult } from './publish.js';
import type { DeadService } from './runner.js';

/** The longest the one read of an adopted run's checkpoints may take. */
export const PHASE_CHECKPOINT_READ_MS = 10_000;
/** The longest one checkpoint write may take: awaited, so bounded, and never a reason to fail a run. */
export const PHASE_CHECKPOINT_WRITE_MS = 10_000;

/** What the gates phase found — the shape `loop-run.ts` calls its `GatesPhase`. */
export interface GatesCheckpoint {
    failure: GateFailure | null;
    deadServices: DeadService[];
    gatesSkipped: string | null;
    recoveredServices: DeadService[];
    /** The gates list the board was last told: a claim resets it, so a resumed phase sends it again. */
    reports: GateReport[];
    /** Whether the run's failed pre-agent setup stood fixed once the gates passed (`job.setupFailure` null). */
    setupCleared: boolean;
}

/** The setup phase's outcome: the failure the pre-agent `environment.setup` left, or null when it passed. */
export type SetupFailure = NonNullable<BoardJob['setupFailure']>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const nullable = (v: unknown, check: (x: unknown) => boolean): boolean => v === null || check(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isFailure = (v: unknown): v is GateFailure =>
    isRecord(v) && isString(v.name) && isNumber(v.exitCode) && isString(v.output);

const isDeadService = (v: unknown): v is DeadService =>
    isRecord(v) &&
    isString(v.name) &&
    isString(v.image) &&
    isString(v.state) &&
    nullable(v.exitCode, isNumber) &&
    nullable(v.reason, isString) &&
    isString(v.logTail) &&
    (v.restartFailure === undefined || isString(v.restartFailure));

const GATE_STATUSES: readonly unknown[] = ['running', 'passed', 'failed'];
const isReport = (v: unknown): v is GateReport =>
    isRecord(v) &&
    isString(v.name) &&
    GATE_STATUSES.includes(v.status) &&
    nullable(v.exitCode, isNumber) &&
    nullable(v.output, isString);

const servicesOf = (v: unknown): DeadService[] | null =>
    Array.isArray(v) && v.every(isDeadService) ? (v as DeadService[]) : null;

function gatesOf(raw: unknown): GatesCheckpoint | null {
    if (!isRecord(raw)) return null;
    const deadServices = servicesOf(raw.deadServices);
    const recoveredServices = servicesOf(raw.recoveredServices);
    if (!deadServices || !recoveredServices) return null;
    if (!nullable(raw.failure, isFailure) || !nullable(raw.gatesSkipped, isString)) return null;
    if (!('failure' in raw) || !('gatesSkipped' in raw)) return null;
    if (!Array.isArray(raw.reports) || !raw.reports.every(isReport) || typeof raw.setupCleared !== 'boolean') {
        return null;
    }
    return {
        reports: raw.reports,
        setupCleared: raw.setupCleared,
        failure: raw.failure as GateFailure | null,
        deadServices,
        gatesSkipped: raw.gatesSkipped as string | null,
        recoveredServices,
    };
}

function setupOf(raw: unknown): { failure: SetupFailure | null } | null {
    if (!isRecord(raw) || !('failure' in raw)) return null;
    const { failure } = raw;
    if (failure === null) return { failure: null };
    if (!isRecord(failure) || !nullable(failure.exitCode, isNumber) || !isString(failure.output)) return null;
    return { failure: { exitCode: failure.exitCode as number | null, output: failure.output } };
}

function postOf(raw: unknown): { failure: HelperFailureReport | null } | null {
    if (!isRecord(raw) || !('failure' in raw)) return null;
    const failure = raw.failure;
    if (failure === null) return { failure: null };
    if (!isRecord(failure) || !isString(failure.helperId) || !isRecord(failure.result)) return null;
    const { result } = failure;
    if (result.ok !== false || !isString(result.reason) || !isString(result.message)) return null;
    return { failure: failure as unknown as HelperFailureReport };
}

/** The publication a checkpoint holds, only when it was pushed for the revision this attempt now ships. */
function publishOf(row: unknown, revision: string | null): PublishResult | null {
    if (!isRecord(row) || row.revision !== revision || !isRecord(row.published)) return null;
    const raw = row.published;
    if (raw.ok !== true || typeof raw.published !== 'boolean') return null;
    for (const field of ['branch', 'prUrl', 'reason', 'repository', 'baseBranch'] as const) {
        if (!nullable(raw[field], isString)) return null;
    }
    if (!nullable(raw.prNumber, isNumber) || raw.cause !== null) return null;
    return raw as unknown as PublishResult;
}

/** The checkpoints one attempt resumes from and writes to; see `openChain`. */
export interface PhaseChain {
    /**
     * The gates phase served from its checkpoint, or null when it must run. `applicable` is whether
     * the attempt gates at all: a phase that does not apply neither resumes nor breaks the chain.
     */
    /**
     * The pre-agent setup outcome the run this attempt resumed left on the board: its failure, null
     * when it passed or nothing was declared, and `unknown` when the board's answer is missing or
     * unreadable — which the caller treats as a failure to retry, never as a pass (issue #917). A
     * fresh attempt resumes nothing and answers null.
     */
    carriedSetup(): SetupFailure | 'unknown' | null;
    resumeGates(applicable: boolean, treeAfter: string | null): GatesCheckpoint | null;
    resumePost(applicable: boolean): { failure: HelperFailureReport | null } | null;
    resumePublish(revision: string | null): PublishResult | null;
    /**
     * Records a phase that ran, awaited and bounded; a failed write is logged and the run goes on —
     * but no phase after a record the board did not take is written: a later row beside a missing
     * earlier one would let a future holder resume a chain that never ran in one piece.
     */
    record(phase: CheckpointPhase, tree: string | null, result: unknown): Promise<void>;
}

/**
 * The attempt's chain. Only an adopted or taken-over run reads — once, bounded by the attempt's own
 * signal and a timeout, never retried; a fresh run has nothing to resume. It writes under the
 * attempt's own lease for the run the claim `runClaimSeq` started.
 */
export async function openChain(ctx: AttemptCtx): Promise<PhaseChain> {
    const { rt, job, state } = ctx;
    const runClaimSeq = ctx.adopted?.claimSeq ?? ctx.takeover?.claimSeq ?? job.claimSeq;
    const resuming = Boolean(ctx.adopted ?? ctx.takeover);
    const rows = new Map<CheckpointPhase, PhaseCheckpoint>();
    if (resuming) {
        const signal = AbortSignal.any([state.signal, AbortSignal.timeout(PHASE_CHECKPOINT_READ_MS)]);
        const read = await rt.board.phaseCheckpoints(job, runClaimSeq, signal);
        if (read === null && !state.signal.aborted)
            rt.log(`job ${job.id}: no phase checkpoints of claim ${runClaimSeq} could be read`);
        for (const row of read ?? []) rows.set(row.phase, row);
    }
    // The chain breaks at the first phase that applies and runs: nothing after it may be resumed.
    let broken = false;
    let unrecorded = false;
    const resumed = (phase: CheckpointPhase) =>
        rt.log(`job ${job.id}: resumed ${phase} from claim ${rows.get(phase)!.claimSeq}'s checkpoint`);

    return {
        carriedSetup() {
            if (!resuming || !job.gates?.setup) return null;
            const carried = rows.has('setup') ? setupOf(rows.get('setup')!.result) : null;
            if (carried) return carried.failure;
            rt.log(`job ${job.id}: the setup outcome of claim ${runClaimSeq} is not on the board, retrying setup`);
            return 'unknown';
        },
        resumeGates(applicable, treeAfter) {
            if (!applicable) return null;
            const row = rows.get('gates');
            const gates = row && treeAfter !== null && row.tree === treeAfter ? gatesOf(row.result) : null;
            if (!gates || broken) {
                broken = true;
                return null;
            }
            resumed('gates');
            return gates;
        },
        resumePost(applicable) {
            if (!applicable) return null;
            const row = rows.get('post');
            const post = row && !broken ? postOf(row.result) : null;
            if (!post) {
                broken = true;
                return null;
            }
            resumed('post');
            return post;
        },
        resumePublish(revision) {
            const row = rows.get('publish');
            const published = row && !broken ? publishOf(row.result, revision) : null;
            if (!published) {
                broken = true;
                return null;
            }
            resumed('publish');
            return published;
        },
        async record(phase, tree, result) {
            if (unrecorded) return;
            const answer = await writeBounded(
                rt.board.phaseCheckpoint(
                    job,
                    { runClaimSeq, phase, tree, result },
                    AbortSignal.any([state.signal, AbortSignal.timeout(PHASE_CHECKPOINT_WRITE_MS)])
                )
            );
            if (answer === 'ok') return;
            unrecorded = true;
            rt.log(`job ${job.id}: the ${phase} checkpoint was not recorded (${answer})`);
        },
    };
}

/** A write that threw is "not recorded", like one the board refused. */
async function writeBounded(write: Promise<'ok' | 'lost' | 'rejected'>): Promise<string> {
    try {
        return await write;
    } catch (e) {
        return (e as Error).message;
    }
}

/** The attempt's chain: the one `verifyRun` opened, or a fresh one for a path that reached the phases without it. */
export async function phasesOf(ctx: AttemptCtx): Promise<PhaseChain> {
    ctx.phases ??= await openChain(ctx);
    return ctx.phases;
}

/**
 * Puts back what the gates phase did on the board when it ran live, for a phase served from its
 * checkpoint: the claim reset the board's gates list, and the workflow engine reads it. Best-effort
 * like the live report — a board hiccup costs the view, never the verdict.
 */
export async function replayGates(ctx: AttemptCtx, gates: GatesCheckpoint): Promise<void> {
    const { rt, job } = ctx;
    if (gates.setupCleared) job.setupFailure = null;
    if (gates.reports.length === 0) return;
    try {
        await rt.board.gates(job, [...gates.reports]);
    } catch (e) {
        rt.log(`job ${job.id}: could not report gate state, continuing: ${(e as Error).message}`);
    }
}
