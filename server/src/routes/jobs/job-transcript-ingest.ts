import { CLAUDE_CODE, OPENCODE } from '@factory-ai/core';
import type { FastifyBaseLogger } from 'fastify';
import type { ArtifactStore } from '../../artifacts/artifact-store.js';
import type { StreamRef } from '../../artifacts/keys.js';
import type { TranscriptToolStore } from '../../db/jobs/job-store-transcript-tools.js';

/**
 * Reads the tool calls out of a landed transcript chunk (issue #983). It runs after the chunk is
 * stored and after a stream is finalized, and answers nothing a caller could branch on: an upload
 * never fails, and never changes a verdict, because the ingest did. It is idempotent (the store
 * files each half of a call once), so a repeat of the put or the finalize costs a read and nothing else.
 *
 * Each chunk is read alone: a call and its result may sit any number of chunks apart, so the store
 * keeps the call half and completes the pair when the result half lands, in any chunk. A finalize
 * reads every chunk in offset order, which also completes a result that landed before its call.
 */

/**
 * The stream each executor's tool-bearing records are uploaded on: the claude exporter's raw session
 * jsonl goes out as `transcript` (`driver/src/loop/loop-export.ts`), the opencode readout's raw rows as
 * `transcript-raw` (`driver/src/artifact-upload.ts`). The other stream of either is the normalized
 * text, which holds no tool call.
 */
const TOOL_STREAM_OF: Readonly<Record<string, string>> = { [CLAUDE_CODE]: 'transcript', [OPENCODE]: 'transcript-raw' };

export const readsToolCalls = (ref: Pick<StreamRef, 'executor' | 'stream'>): boolean =>
    TOOL_STREAM_OF[ref.executor] === ref.stream;

/** Ingests the chunk at `offset` (or every chunk in offset order, when null: the finalize pass). */
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
    let targets: number[];
    try {
        targets =
            offset === null ? (await artifacts.listChunks(ref)).map((c) => c.offset).sort((a, b) => a - b) : [offset];
    } catch (e) {
        log.warn({ err: e }, 'transcript tool ingest failed');
        return;
    }
    // One chunk failing leaves the others to be read: a later finalize repeats it, and the store is idempotent.
    for (const at of targets) {
        try {
            const stored = await artifacts.readChunk(ref, at);
            if (!stored) continue;
            await jobs.ingestTranscriptTools(id, {
                executor: ref.executor,
                stream: ref.stream,
                session: ref.session,
                claimSeq: ref.claimSeq,
                chunks: [{ offset: at, text: new TextDecoder().decode(stored.body) }],
            });
        } catch (e) {
            log.warn({ err: e }, 'transcript tool ingest failed');
        }
    }
}
