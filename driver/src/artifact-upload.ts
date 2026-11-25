import type { ArtifactManifest, ArtifactStreamRef, Board, BoardJob } from './board/board.js';
import { withBoardRetry } from './board/board-retry.js';
import type { RunOutcome } from './runner.js';
import { describeError } from './log.js';

/**
 * Uploads a finished run's log and transcript to the board as chunked, immutable artifact streams
 * (`PUT /api/jobs/:id/artifact/chunk` then `/manifest`), authorized by the claim sequence the run
 * was claimed under. Nothing here can change a verdict: every failure is logged and answered as an
 * incomplete stream, never thrown, so a passing gate stays passing — a failed upload only means no
 * `complete` manifest, which is what a reader and the volume-retention rule look at.
 *
 * One upload is bounded by one `UploadBound` — the lease, fenced on the caller's lease clock — shared by every
 * stream, chunk and manifest call: a board outage shorter than the lease is ridden out in place, and a longer one
 * lapses the lease, whose next claim re-reads the run's log and uploads it again.
 *
 * A retry after a lost response is safe by construction: a chunk is addressed by its byte offset in
 * the source text and the board answers a repeat of the same bytes `duplicate`, and the manifest is
 * built once before the first attempt so a repeat of it is identical.
 */

const BYTES_PER_KIB = 1024;
const CHUNK_KIB = 256;
/** Where one chunk stops and the next begins; records (lines) are not split unless one is larger than this. */
const CHUNK_BYTES = CHUNK_KIB * BYTES_PER_KIB;
const NEWLINE = 0x0a;
/** What the driver names itself as in a manifest, and the shape of the streams it writes. */
const PRODUCER = 'driver';
const SCHEMA_VERSION = 1;

/** Terminal causes the driver records itself; the board adds `stream_cap` and `org_quota`. */
export const UPLOAD_CAUSE = {
    /** The run's output was tail-kept at the driver's capture limit: the head is gone. */
    headDropped: 'head_dropped',
    /** A chunk or the manifest could not be stored within the upload's bound. */
    uploadFailed: 'upload_failed',
} as const;

/** The session segment of a stream whose run reported no session. */
export const NO_SESSION = 'none';

/** `transcript` is the normalized stream; `transcript-raw` is the executor's own records, verbatim. */
export const ARTIFACT_STREAM = {
    log: 'log',
    transcript: 'transcript',
    rawTranscript: 'transcript-raw',
    /** The attempt's checkpoint: a header line, a git bundle and the OpenCode snapshot, binary. */
    checkpoint: 'checkpoint',
    /** A gate run's whole output is the stream `gate-<name>-<execution id>`; the server's twin is `GATE_STREAM_PREFIX`. */
    gatePrefix: 'gate-',
} as const;

/** The executor segment of a stream of a job that ran no agent. */
export const NO_EXECUTOR = 'none';

/** The most of a gate's name its stream carries; the execution id after it keeps the name unique. */
const GATE_STREAM_NAME_MAX = 64;

/** `gate-<name>-<execution id>`: the name folded to a key segment's characters, the id naming the one run. */
export function gateStreamName(gate: string, executionId: string): string {
    const folded = gate.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, GATE_STREAM_NAME_MAX);
    return `${ARTIFACT_STREAM.gatePrefix}${folded}-${executionId}`;
}

/** Cuts `bytes` into chunks of about `max` bytes, ending at a newline where one allows. Offsets are the cut points. */
export function cutChunks(bytes: Uint8Array, max = CHUNK_BYTES): { offset: number; body: Uint8Array }[] {
    const chunks: { offset: number; body: Uint8Array }[] = [];
    let start = 0;
    while (start < bytes.length) {
        let end = Math.min(start + max, bytes.length);
        if (end < bytes.length) {
            // Prefer the last record boundary inside the window; a single record larger than the
            // window is its own chunk, so extend to its end instead of splitting it.
            const back = bytes.lastIndexOf(NEWLINE, end - 1);
            if (back >= start) end = back + 1;
            else {
                const forward = bytes.indexOf(NEWLINE, end);
                end = forward === -1 ? bytes.length : forward + 1;
            }
        }
        chunks.push({ offset: start, body: bytes.subarray(start, end) });
        start = end;
    }
    return chunks;
}

export interface StreamSource {
    stream: string;
    text: string;
    /** The text is the tail of a longer stream. */
    truncated: boolean;
}

type Io = { log: (message: string) => void; sleep: (ms: number) => Promise<void>; now?: () => Date };

/** What bounds one upload: the longest it retries a board that is down, and the signal that ends it at once. */
export interface UploadBound {
    budgetMs: number;
    signal: AbortSignal;
}

const MS_PER_SECOND = 1_000;

/** The bound of an upload that rides out a board outage for one lease, ended at once by `signal`. */
export const leaseBound = (leaseSeconds: number, signal: AbortSignal): UploadBound => ({
    budgetMs: leaseSeconds * MS_PER_SECOND,
    signal,
});

/** One upload's clock: shared by all its board calls, so a dead board costs one bound, not one per call. */
export interface UploadDeadline {
    remainingMs(): number;
    /** Aborts at the bound's own abort, or once its budget has passed in wall-clock time (a request that hangs). */
    signal: AbortSignal;
    release(): void;
}

export function startUploadDeadline(bound: UploadBound, io: Pick<Io, 'now'>): UploadDeadline {
    const now = io.now ?? (() => new Date());
    const startMs = now().getTime();
    const ended = new AbortController();
    const end = (): void => ended.abort();
    if (bound.signal.aborted) end();
    else bound.signal.addEventListener('abort', end, { once: true });
    const timer = setTimeout(end, bound.budgetMs);
    timer.unref();
    return {
        remainingMs: () => Math.max(0, bound.budgetMs - (now().getTime() - startMs)),
        signal: ended.signal,
        release() {
            clearTimeout(timer);
            bound.signal.removeEventListener('abort', end);
        },
    };
}

const retryWithin = (deadline: UploadDeadline) => ({
    budgetMs: deadline.remainingMs(),
    leaseLapsed: deadline.signal,
});

/** Where one stream goes: the board to call, the job whose claim sequence authorizes it, and the stream's name. */
export interface UploadTarget {
    board: Pick<Board, 'putArtifactChunk' | 'finalizeArtifact'>;
    job: BoardJob;
    ref: ArtifactStreamRef;
}

/** Puts the stream's chunks in order; the cause the upload stopped short for, or null when every chunk is stored. */
async function putChunks(
    { board, job, ref }: UploadTarget,
    text: string,
    io: Io,
    deadline: UploadDeadline
): Promise<string | null> {
    const where = `job ${job.id}: ${ref.stream} artifact chunk`;
    for (const { offset, body } of cutChunks(Buffer.from(text, 'utf8'))) {
        try {
            const answer = await withBoardRetry(
                io,
                `${where} at ${offset} was not stored`,
                () => board.putArtifactChunk(job, ref, offset, body),
                retryWithin(deadline)
            );
            if (answer.result === 'refused') return answer.cause;
            if (answer.result === 'conflict' || answer.result === 'rejected') {
                io.log(`${where} at ${offset} was ${answer.result} by the board`);
                return UPLOAD_CAUSE.uploadFailed;
            }
        } catch (e) {
            io.log(`${where} at ${offset} failed: ${describeError(e)}`);
            return UPLOAD_CAUSE.uploadFailed;
        }
    }
    return null;
}

/** `partial` when the upload broke, `truncated` when bytes are missing by cap or by capture, else `complete`. */
function stateOf(cause: string | null, stopped: string | null): ArtifactManifest['state'] {
    if (cause === null) return 'complete';
    return stopped === UPLOAD_CAUSE.uploadFailed ? 'partial' : 'truncated';
}

/** Uploads one stream and its manifest; true only when the manifest recorded the stream `complete`. */
export async function uploadStream(
    target: UploadTarget,
    source: StreamSource,
    io: Io,
    deadline: UploadDeadline
): Promise<boolean> {
    const { board, job, ref } = target;
    const now = io.now ?? (() => new Date());
    const startedAt = now();
    const stopped = await putChunks(target, source.text, io, deadline);
    const cause = stopped ?? (source.truncated ? UPLOAD_CAUSE.headDropped : null);
    // Built once, before the first attempt: a retried manifest must be the same manifest.
    const manifest: ArtifactManifest = {
        producer: PRODUCER,
        schemaVersion: SCHEMA_VERSION,
        startedAt: startedAt.toISOString(),
        finishedAt: now().toISOString(),
        state: stateOf(cause, stopped),
        terminalCause: cause,
    };
    try {
        await withBoardRetry(
            io,
            `job ${job.id}: ${ref.stream} artifact manifest was not stored`,
            () => board.finalizeArtifact(job, ref, manifest),
            retryWithin(deadline)
        );
    } catch (e) {
        io.log(`job ${job.id}: ${ref.stream} artifact manifest failed: ${describeError(e)}`);
        return false;
    }
    return manifest.state === 'complete';
}

/** The streams a run left to upload: its log, transcript and raw transcript, each only when it captured one. */
function sourcesOf(outcome: RunOutcome): StreamSource[] {
    const sources: StreamSource[] = [];
    if (outcome.fullLog) {
        sources.push({ stream: ARTIFACT_STREAM.log, text: outcome.fullLog, truncated: outcome.logTruncated === true });
    }
    if (outcome.transcript) {
        sources.push({
            stream: ARTIFACT_STREAM.transcript,
            text: outcome.transcript,
            truncated: outcome.transcriptTruncated === true,
        });
    }
    if (outcome.rawTranscript) {
        sources.push({
            stream: ARTIFACT_STREAM.rawTranscript,
            text: outcome.rawTranscript,
            truncated: outcome.rawTranscriptTruncated === true,
        });
    }
    return sources;
}

/**
 * The run's log and transcript, uploaded in that order. Never throws and answers nothing a caller
 * could branch a verdict on: the loop awaits it for ordering (before the gates, while the heartbeat
 * still beats) and goes on whatever happened.
 */
export async function uploadRunArtifacts(
    run: { board: UploadTarget['board']; job: BoardJob; executorType: string | null; outcome: RunOutcome },
    io: Io,
    bound: UploadBound
): Promise<void> {
    const { board, job, executorType, outcome } = run;
    if (executorType === null) return;
    const session = outcome.sessionId ?? NO_SESSION;
    const deadline = startUploadDeadline(bound, io);
    try {
        for (const source of sourcesOf(outcome)) {
            const ref = { executor: executorType, session, stream: source.stream };
            try {
                await uploadStream({ board, job, ref }, source, io, deadline);
            } catch (e) {
                io.log(`job ${job.id}: the ${source.stream} artifact upload failed: ${describeError(e)}`);
            }
        }
    } finally {
        deadline.release();
    }
}

/** One gate run's whole output, stored as its own stream under the claim's authority; true when the manifest recorded it complete. */
export async function uploadGateLog(
    run: { board: UploadTarget['board']; job: BoardJob; stream: string },
    log: { text: string; truncated: boolean },
    io: Io,
    bound: UploadBound
): Promise<boolean> {
    const { board, job, stream } = run;
    const ref = { executor: job.executorType ?? NO_EXECUTOR, session: NO_SESSION, stream };
    const deadline = startUploadDeadline(bound, io);
    try {
        return await uploadStream({ board, job, ref }, { stream, ...log }, io, deadline);
    } catch (e) {
        io.log(`job ${job.id}: the ${stream} artifact upload failed: ${describeError(e)}`);
        return false;
    } finally {
        deadline.release();
    }
}
