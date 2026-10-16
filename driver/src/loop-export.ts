import type { ArtifactStreamRef, BoardJob } from './board.js';
import { ARTIFACT_STREAM } from './artifact-upload.js';
import { CLAUDE_CODE } from './executors.js';
import type { ExportDrain, ExportRelay } from './export-control.js';
import type { RunOutcome } from './runner.js';
import type { AttemptCtx, LoopRuntime } from './loop-types.js';
import {
    AGENT_KILLED_CAUSE,
    AGENT_TIMEOUT_CAUSE,
    EXPORT_PRODUCER,
    EXPORT_SCHEMA_VERSION,
    SPOOL_FULL_CAUSE,
} from './transcript-export.js';

/**
 * The loop's half of the continuous transcript export: the relay the exporter's calls reach (they
 * go on to the board's chunk and manifest routes under the attempt's claim sequence), the vitals it
 * reports (oldest unacknowledged age and bytes, which ride the run's runtime report), the spool-cap
 * failure, and the drain after the agent's end. The exporter itself belongs to the runner
 * (`docker-export.ts`, `claudeExportJobSpec`); nothing here can change a verdict except the spool cap.
 */

/** How long the loop waits for the exporter to drain and close its manifests once the agent is gone. */
export const EXPORT_DRAIN_MS = 300_000;

/** Exits that say the agent was killed rather than finishing: SIGKILL and SIGTERM. */
const SIGKILL_EXIT = 137;
const SIGTERM_EXIT = 143;
const KILLED_EXITS: readonly number[] = [SIGKILL_EXIT, SIGTERM_EXIT];

/** What the exporter last said about itself. */
export interface ExportVitals {
    pendingBytes: number;
    oldestUnackedMs: number;
}

/** One attempt's export state, held on its `JobState`. */
export interface ExportRun {
    vitals: ExportVitals | null;
    /** The spool cap was reached: the attempt is being failed with `artifact_spool_full`. */
    spoolFull: boolean;
    /** The exporter reported `done`: every session drained and closed. */
    done: boolean;
    finished: Promise<void>;
    markDone: () => void;
    drained: boolean;
}

export function newExportRun(): ExportRun {
    let markDone = () => {};
    const finished = new Promise<void>((resolve) => {
        markDone = resolve;
    });
    return {
        vitals: null,
        spoolFull: false,
        done: false,
        finished,
        markDone: () => {
            markDone();
        },
        drained: false,
    };
}

const refOf = (job: BoardJob, session: string): ArtifactStreamRef => ({
    executor: job.executorType ?? '',
    session,
    stream: ARTIFACT_STREAM.transcript,
});

/** The relay behind the control token's export routes: board calls plus the run's bookkeeping. */
export function createExportRelay(rt: LoopRuntime, job: BoardJob, run: ExportRun): ExportRelay {
    return {
        putChunk: (session, offset, bytes) => rt.board.putArtifactChunk(job, refOf(job, session), offset, bytes),
        finalize: (manifest) =>
            rt.board.finalizeArtifact(job, refOf(job, manifest.session), {
                producer: EXPORT_PRODUCER,
                schemaVersion: EXPORT_SCHEMA_VERSION,
                startedAt: manifest.startedAt,
                finishedAt: manifest.finishedAt,
                state: manifest.state,
                terminalCause: manifest.terminalCause,
            }),
        report(report) {
            run.vitals = { pendingBytes: report.pendingBytes, oldestUnackedMs: report.oldestUnackedMs };
            if (report.spoolFull && !run.spoolFull) {
                // The board stayed out of reach until the volume budget ran out. Nothing was dropped —
                // every byte is still in the transcript files — so the attempt fails here, loudly.
                run.spoolFull = true;
                rt.log(
                    `job ${job.id}: ${SPOOL_FULL_CAUSE}: ${report.pendingBytes} bytes unacknowledged, stopping the run`
                );
                void rt.runner.kill(job).catch(() => undefined);
            }
            if (report.done) {
                run.done = true;
                run.markDone();
            }
        },
    };
}

/**
 * A claude-code run, a reviewer's included, streams its transcript out while it runs: the runner
 * starts the exporter beside the agent, and the open control token's `/export` routes carry its
 * chunks to the board. Any other executor keeps its close-time read and gets no relay.
 */
export function attachTranscriptExport(ctx: Pick<AttemptCtx, 'rt' | 'job' | 'state'>, token: string): void {
    const { rt, job, state } = ctx;
    if (job.executorType !== CLAUDE_CODE || !rt.gates) return;
    const run = newExportRun();
    rt.gates.server.attachExporter(token, createExportRelay(rt, job, run));
    state.transcriptExport = run;
}

/** Ends the attempt's exporter when the run never drained it (a thrown run); the closed token stops it anyway. */
export async function stopTranscriptExport(ctx: Pick<AttemptCtx, 'rt' | 'job' | 'state'>): Promise<void> {
    const { rt, job, state } = ctx;
    if (state.transcriptExport) await rt.runner.stopTranscriptExport?.(job).catch(() => undefined);
}

/** What the agent's end means for its transcript: whole after a normal exit, partial after a kill. */
export function drainOf(outcome: RunOutcome, run: ExportRun): ExportDrain {
    if (run.spoolFull) return { state: 'partial', cause: SPOOL_FULL_CAUSE };
    if (outcome.timedOut) return { state: 'partial', cause: AGENT_TIMEOUT_CAUSE };
    const killed = Boolean(outcome.cacheLost) || (outcome.exitCode !== null && KILLED_EXITS.includes(outcome.exitCode));
    return killed ? { state: 'partial', cause: AGENT_KILLED_CAUSE } : { state: 'complete', cause: null };
}

/**
 * After the agent's end: tells the exporter to drain, waits (bounded) for it to upload every whole
 * record and close its manifests, and ends its container or Job. A spool-cap stop is stamped on the
 * outcome so the verdict fails with the cause. Never throws; a drain that does not finish in time is
 * logged and leaves the streams without a `complete` manifest, the bytes still on the volume.
 */
export async function drainTranscriptExport(ctx: AttemptCtx, outcome: RunOutcome): Promise<void> {
    const { rt, job, state } = ctx;
    const run = state.transcriptExport;
    if (!run || run.drained) return;
    run.drained = true;
    if (run.spoolFull) outcome.artifactSpoolFull = `${run.vitals?.pendingBytes ?? 0} bytes`;
    // Only a runner that can end an exporter ever started one; for any other there is nothing to wait for.
    if (state.control !== null && rt.runner.stopTranscriptExport) {
        rt.gates?.server.drainExport(state.control, drainOf(outcome, run));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, rt.exportDrainMs ?? EXPORT_DRAIN_MS);
        });
        await Promise.race([run.finished, timeout]);
        clearTimeout(timer);
        if (!run.done) rt.log(`job ${job.id}: the transcript exporter did not finish draining in time`);
    }
    await rt.runner.stopTranscriptExport?.(job).catch(() => undefined);
}
