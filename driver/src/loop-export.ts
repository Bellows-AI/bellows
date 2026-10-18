import type { ArtifactStreamRef, BoardJob } from './board.js';
import { ARTIFACT_STREAM } from './artifact-upload.js';
import { CLAUDE_CODE } from './executors.js';
import type { ExportRelay } from './export-control.js';
import type { RunOutcome } from './runner.js';
import { killAgent } from './loop-attempt.js';
import type { AttemptCtx, LoopRuntime } from './loop-types.js';
import { EXPORT_PRODUCER, EXPORT_SCHEMA_VERSION, SPOOL_FULL_CAUSE } from './transcript-export.js';

/**
 * The loop's half of the continuous transcript export: the relay the exporter's calls reach (they
 * go on to the board's chunk and manifest routes under the attempt's claim sequence), the vitals it
 * reports (oldest unacknowledged age and bytes, which ride the run's runtime report) and the
 * spool-cap failure. The exporter itself is a container of the run's pod under the task supervisor
 * (`k8s-podspec.ts`, `docker-group.ts`), which orders its drain once the agent is gone and ends the
 * pod only after it closed its manifests — the loop has nothing left to drain or to end. Nothing
 * here can change a verdict except the spool cap.
 */

/** One attempt's export state, held on its `JobState`. */
export interface ExportRun {
    vitals: ExportVitals | null;
    /** The spool cap was reached: the attempt is being failed with `artifact_spool_full`. */
    spoolFull: boolean;
    /** The exporter reported `done`: every session drained and closed. */
    done: boolean;
    drained: boolean;
}

/** What the exporter last said about itself. */
export interface ExportVitals {
    pendingBytes: number;
    oldestUnackedMs: number;
}

export function newExportRun(): ExportRun {
    return { vitals: null, spoolFull: false, done: false, drained: false };
}

const refOf = (job: BoardJob, session: string): ArtifactStreamRef => ({
    executor: job.executorType ?? '',
    session,
    stream: ARTIFACT_STREAM.transcript,
});

/** The relay behind the control token's export routes: board calls plus the run's bookkeeping. */
export function createExportRelay(rt: LoopRuntime, job: BoardJob, run: ExportRun, control: string): ExportRelay {
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
                // The supervisor ends the agent itself on the same signal; the kill order says it twice.
                run.spoolFull = true;
                rt.log(
                    `job ${job.id}: ${SPOOL_FULL_CAUSE}: ${report.pendingBytes} bytes unacknowledged, stopping the run`
                );
                const kill = { reason: SPOOL_FULL_CAUSE, detail: `${report.pendingBytes} bytes` } as const;
                void killAgent(rt, job, control, kill).catch(() => undefined);
            }
            if (report.done) run.done = true;
        },
    };
}

/**
 * A claude-code run, a reviewer's included, streams its transcript out while it runs: the pod's
 * exporter container carries its chunks through the open control token's `/export` routes to the
 * board. Any other executor keeps its close-time read and gets no relay.
 */
export function attachTranscriptExport(ctx: Pick<AttemptCtx, 'rt' | 'job' | 'state'>, token: string): void {
    const { rt, job, state } = ctx;
    if (job.executorType !== CLAUDE_CODE || !rt.gates) return;
    const run = newExportRun();
    rt.gates.server.attachExporter(token, createExportRelay(rt, job, run, token));
    state.transcriptExport = run;
}

/**
 * After the run: stamps a spool-cap stop on the outcome so the verdict fails with the cause, and
 * says so when the exporter never reported `done`. The pod ended only after the supervisor had the
 * exporter drain, so there is nothing to wait for — an exporter that gave up leaves its streams
 * without a `complete` manifest, the bytes still on the volume. Never throws.
 */
export function drainTranscriptExport(ctx: AttemptCtx, outcome: RunOutcome): void {
    const { rt, job, state } = ctx;
    const run = state.transcriptExport;
    if (!run || run.drained) return;
    run.drained = true;
    if (run.spoolFull) outcome.artifactSpoolFull = `${run.vitals?.pendingBytes ?? 0} bytes`;
    if (!run.done) rt.log(`job ${job.id}: the transcript exporter did not report done; its bytes remain on the volume`);
}
