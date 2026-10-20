import type { ArtifactManifest, ArtifactStreamRef, Board, BoardJob } from './board.js';
import { withBoardRetry } from './board-retry.js';
import type { RunOutcome } from './runner.js';

/**
 * Uploads a finished run's log and transcript to the board as chunked, immutable artifact streams
 * (`PUT /api/jobs/:id/artifact/chunk` then `/manifest`), authorized by the claim sequence the run
 * was claimed under. Nothing here can change a verdict: every failure is logged and answered as an
 * incomplete stream, never thrown, so a passing gate stays passing — a failed upload only means no
 * `complete` manifest, which is what a reader and the volume-retention rule look at.
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
    /** A chunk or the manifest could not be stored after the bounded retries. */
    uploadFailed: 'upload_failed',
} as const;

/** The session segment of a stream whose run reported no session. */
export const NO_SESSION = 'none';

/** `transcript` is the normalized stream; `transcript-raw` is the executor's own records, verbatim. */
export const ARTIFACT_STREAM = {
    log: 'log',
    transcript: 'transcript',
    rawTranscript: 'transcript-raw',
    /** The attempt's checkpoint (issue #775): a header line, a git bundle and the OpenCode snapshot, binary. */
    checkpoint: 'checkpoint',
} as const;

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

/** Where one stream goes: the board to call, the job whose claim sequence authorizes it, and the stream's name. */
export interface UploadTarget {
    board: Pick<Board, 'putArtifactChunk' | 'finalizeArtifact'>;
    job: BoardJob;
    ref: ArtifactStreamRef;
}

/** Puts the stream's chunks in order; the cause the upload stopped short for, or null when every chunk is stored. */
async function putChunks({ board, job, ref }: UploadTarget, text: string, io: Io): Promise<string | null> {
    const where = `job ${job.id}: ${ref.stream} artifact chunk`;
    for (const { offset, body } of cutChunks(Buffer.from(text, 'utf8'))) {
        try {
            const answer = await withBoardRetry(io, `${where} at ${offset} was not stored`, () =>
                board.putArtifactChunk(job, ref, offset, body)
            );
            if (answer.result === 'refused') return answer.cause;
            if (answer.result === 'conflict' || answer.result === 'rejected') {
                io.log(`${where} at ${offset} was ${answer.result} by the board`);
                return UPLOAD_CAUSE.uploadFailed;
            }
        } catch (e) {
            io.log(`${where} at ${offset} failed: ${(e as Error).message}`);
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
export async function uploadStream(target: UploadTarget, source: StreamSource, io: Io): Promise<boolean> {
    const { board, job, ref } = target;
    const now = io.now ?? (() => new Date());
    const startedAt = now();
    const stopped = await putChunks(target, source.text, io);
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
        await withBoardRetry(io, `job ${job.id}: ${ref.stream} artifact manifest was not stored`, () =>
            board.finalizeArtifact(job, ref, manifest)
        );
    } catch (e) {
        io.log(`job ${job.id}: ${ref.stream} artifact manifest failed: ${(e as Error).message}`);
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
    io: Io
): Promise<void> {
    const { board, job, executorType, outcome } = run;
    if (executorType === null) return;
    const session = outcome.sessionId ?? NO_SESSION;
    for (const source of sourcesOf(outcome)) {
        const ref = { executor: executorType, session, stream: source.stream };
        try {
            await uploadStream({ board, job, ref }, source, io);
        } catch (e) {
            io.log(`job ${job.id}: the ${source.stream} artifact upload failed: ${(e as Error).message}`);
        }
    }
}
