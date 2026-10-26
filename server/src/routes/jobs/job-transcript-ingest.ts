import { CLAUDE_CODE, OPENCODE } from '@factory-ai/core';
import type { FastifyBaseLogger } from 'fastify';
import type { ArtifactStore } from '../../artifacts/artifact-store.js';
import type { StreamRef } from '../../artifacts/keys.js';
import type { TranscriptToolStore } from '../../db/jobs/job-store-transcript-tools.js';
import type { TranscriptChunk } from '../../telemetry/transcript-tools.js';

/**
 * Reads the tool calls out of a landed transcript chunk (issue #983). It runs after the chunk is
 * stored and after a stream is finalized, and answers nothing a caller could branch on: an upload
 * never fails, and never changes a verdict, because the ingest did. It is idempotent (the store
 * files each half of a call once), so a repeat of the put or the finalize costs a read and nothing else.
 *
 * A call and its result may land in neighbouring chunks, so each chunk is read together with the
 * chunks on either side of it. A pair further apart than that stays unpaired: unknown, never a success.
 */

/** The executor's own records, verbatim: the only stream a tool call can be read from. */
export const TRANSCRIPT_RAW_STREAM = 'transcript-raw';
const READABLE_EXECUTORS: readonly string[] = [CLAUDE_CODE, OPENCODE];

export const readsToolCalls = (ref: Pick<StreamRef, 'executor' | 'stream'>): boolean =>
    ref.stream === TRANSCRIPT_RAW_STREAM && READABLE_EXECUTORS.includes(ref.executor);

async function windowAround(
    artifacts: ArtifactStore,
    ref: StreamRef,
    offsets: readonly number[],
    at: number
): Promise<TranscriptChunk[]> {
    const chunks: TranscriptChunk[] = [];
    for (const offset of offsets.slice(Math.max(0, at - 1), at + 2)) {
        const stored = await artifacts.readChunk(ref, offset);
        if (stored) chunks.push({ offset, text: new TextDecoder().decode(stored.body) });
    }
    return chunks;
}

/** Ingests the chunk at `offset` (or every chunk, when null: the finalize pass) with its neighbours. */
export async function ingestTranscriptTools(
    run: {
        jobs: TranscriptToolStore;
        artifacts: ArtifactStore;
        log: FastifyBaseLogger;
        id: string;
        ref: StreamRef;
    },
    offset: number | null
): Promise<void> {
    const { jobs, artifacts, log, id, ref } = run;
    if (!readsToolCalls(ref)) return;
    try {
        const offsets = (await artifacts.listChunks(ref)).map((c) => c.offset).sort((a, b) => a - b);
        const targets = offset === null ? offsets.keys() : [offsets.indexOf(offset)].filter((i) => i >= 0).values();
        for (const at of targets) {
            const chunks = await windowAround(artifacts, ref, offsets, at);
            await jobs.ingestTranscriptTools(id, {
                executor: ref.executor,
                stream: ref.stream,
                claimSeq: ref.claimSeq,
                chunks,
            });
        }
    } catch (e) {
        log.warn({ err: e }, 'transcript tool ingest failed');
    }
}
