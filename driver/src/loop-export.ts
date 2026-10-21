import { randomUUID } from 'node:crypto';
import type { ArtifactStreamRef, BoardJob, ReviewClaim } from './board.js';
import { ARTIFACT_STREAM, NO_SESSION, uploadRunArtifacts } from './artifact-upload.js';
import { mergeOpencodeOutcome, parseOpencodeRunOutcome } from './close-read.js';
import { CLAUDE_CODE } from './executors.js';
import type { CheckpointRelay, ExportRelay } from './export-control.js';
import type { RunOutcome } from './runner.js';
import { controlTokenOf, type ReviewExporter } from './supervised-steps.js';
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

/** What the supervisor names itself as in the checkpoint's manifest, and the shape of the stream it writes. */
const CHECKPOINT_PRODUCER = 'supervisor';
const CHECKPOINT_SCHEMA_VERSION = 1;

const checkpointRef = (job: BoardJob): ArtifactStreamRef => ({
    executor: job.executorType ?? '',
    session: NO_SESSION,
    stream: ARTIFACT_STREAM.checkpoint,
});

/**
 * The relay behind the control token's checkpoint routes (issue #775): the supervisor's finalize
 * stage puts the checkpoint's bytes and its closing record here and they go on to the board's
 * `checkpoint` stream. The claim sequence that authorizes them is the job's own, read here — the
 * supervisor names none — so a superseded attempt's checkpoint is the board's to refuse.
 */
export function createCheckpointRelay(rt: LoopRuntime, job: BoardJob): CheckpointRelay {
    return {
        putChunk: (offset, bytes) => rt.board.putArtifactChunk(job, checkpointRef(job), offset, bytes),
        finalize: (manifest) =>
            rt.board.finalizeArtifact(job, checkpointRef(job), {
                producer: CHECKPOINT_PRODUCER,
                schemaVersion: CHECKPOINT_SCHEMA_VERSION,
                ...manifest,
            }),
    };
}

/** Every attempt with a control endpoint checkpoints at finalize, whichever executor ran: no transcript stream is needed. */
export function attachCheckpoint(ctx: Pick<AttemptCtx, 'rt' | 'job'>, token: string): void {
    const { rt, job } = ctx;
    rt.gates?.server.attachCheckpoint(token, createCheckpointRelay(rt, job));
}

/** The relay behind the control token's export routes: board calls plus the run's bookkeeping. */
export function createExportRelay(rt: LoopRuntime, job: BoardJob, run: ExportRun, control: string | null): ExportRelay {
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
                // A review's relay (no `control`) has no agent to stop: its bytes stay on the volume.
                if (control !== null) {
                    const kill = { reason: SPOOL_FULL_CAUSE, detail: `${report.pendingBytes} bytes` } as const;
                    void killAgent(rt, job, control, kill).catch(() => undefined);
                }
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

/**
 * The close-time export of one in-band review (issue #774, amendment B5): an exporter token on the
 * CALLER's control channel, bound to a relay that sends under the REVIEW row's identity (its id and
 * claim sequence), so the reviewer's transcript and totals belong to the review row and never to the
 * caller's attempt. A claude-code review streams through the token; an opencode review's readout is
 * parsed and uploaded here. Null where the caller has no control channel to ride. `close` revokes the token.
 */
export function openReviewExport(
    rt: LoopRuntime,
    caller: BoardJob,
    review: ReviewClaim
): { exporter: ReviewExporter; close: () => void } | null {
    if (!rt.gates || !caller.supervisorEnv) return null;
    const owner = controlTokenOf(caller);
    const token = randomUUID();
    rt.gates.server.grantExporter(owner, token, createExportRelay(rt, review, newExportRun(), null));
    const exporter: ReviewExporter = {
        token,
        async readout(stdout) {
            const outcome = {} as RunOutcome;
            mergeOpencodeOutcome(outcome, parseOpencodeRunOutcome(stdout, true), null);
            // opencode mints its own session id: the readout is where a fresh review's is discovered,
            // and recording it on the review row is what lets a re-leased review resume it.
            if (outcome.sessionId && outcome.sessionId !== review.resumeSessionId) {
                await rt.board.session(review, outcome.sessionId).catch((e: Error) => {
                    rt.log(`review ${review.id}: the session was not recorded: ${e.message}`);
                });
            }
            await uploadRunArtifacts({ board: rt.board, job: review, executorType: review.executorType, outcome }, rt);
        },
    };
    return { exporter, close: () => rt.gates?.server.revokeExporter(token) };
}
