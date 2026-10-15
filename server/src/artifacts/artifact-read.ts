import {
    ArtifactObjectMissingError,
    KIB,
    MIB,
    type ArtifactStore,
    type ChunkRecord,
    type StreamSummary,
} from './artifact-store.js';
import type { StreamRef } from './keys.js';

/**
 * The analysis read over the artifact index: a job's streams across attempts, sessions and
 * executors, and a cursor-paged walk of their chunks in (attempt, session, stream, offset) order.
 * Pages are whole chunks, never a byte slice, so a page boundary cannot split a multibyte
 * character or a record the producer kept whole.
 */

const DEFAULT_PAGE_KIB = 256;
const MAX_PAGE_MIB = 4;
export const DEFAULT_PAGE_BYTES = DEFAULT_PAGE_KIB * KIB;
export const MAX_PAGE_BYTES = MAX_PAGE_MIB * MIB;
/** Bounds a page of deleted chunks, which carry no bytes and so never fill the byte budget. */
const MAX_PAGE_SEGMENTS = 256;

/**
 * What a reader may conclude from a stream: the manifest's finalization state, plus two the index
 * derives itself — `deleted` (the task was removed, or an object is gone from the store) and
 * `partial` with cause `not_finalized` (chunks with no manifest: still running, or the runner died).
 */
export const STREAM_STATE = {
    complete: 'complete',
    partial: 'partial',
    truncated: 'truncated',
    deleted: 'deleted',
} as const;
export type StreamState = (typeof STREAM_STATE)[keyof typeof STREAM_STATE];
export const NOT_FINALIZED_CAUSE = 'not_finalized';
export const JOB_REMOVED_CAUSE = 'job_removed';
export const OBJECT_MISSING_CAUSE = 'object_missing';

export interface StreamView {
    attempt: number;
    executor: string;
    session: string;
    stream: string;
    state: StreamState;
    terminalCause: string | null;
    chunks: number;
    bytes: number;
    producer: string | null;
    startedAt: string | null;
    finishedAt: string | null;
}

export interface Segment {
    attempt: number;
    executor: string;
    session: string;
    stream: string;
    offset: number;
    length: number;
    /** Bytes the index shows missing between the previous chunk of this stream and this one. */
    gapBefore: number;
    /** `deleted` when the object is gone: the index still knows it, there is no text. */
    state: 'ok' | 'deleted';
    text: string | null;
}

export interface Page {
    streams: StreamView[];
    segments: Segment[];
    /** Opaque; null when this page reached the end of the selected streams. */
    nextCursor: string | null;
}

export interface StreamFilter {
    stream?: string;
    attempt?: number;
    session?: string;
    executor?: string;
}

export const matchesFilter = (s: StreamRef, f: StreamFilter) =>
    (f.stream === undefined || s.stream === f.stream) &&
    (f.attempt === undefined || s.claimSeq === f.attempt) &&
    (f.session === undefined || s.session === f.session) &&
    (f.executor === undefined || s.executor === f.executor);

export function viewOf(s: StreamSummary, jobRemoved: boolean): StreamView {
    const base = {
        attempt: s.claimSeq,
        executor: s.executor,
        session: s.session,
        stream: s.stream,
        chunks: s.chunks,
        bytes: s.bytes,
        producer: s.manifest?.producer ?? null,
        startedAt: s.manifest?.startedAt.toISOString() ?? null,
        finishedAt: s.manifest?.finishedAt.toISOString() ?? null,
    };
    if (jobRemoved) return { ...base, state: STREAM_STATE.deleted, terminalCause: JOB_REMOVED_CAUSE };
    if (!s.manifest) return { ...base, state: STREAM_STATE.partial, terminalCause: NOT_FINALIZED_CAUSE };
    return { ...base, state: s.manifest.state, terminalCause: s.manifest.terminalCause };
}

interface Position {
    /** The stream's index in the selected, ordered list. */
    stream: number;
    offset: number;
}

const refKey = (s: StreamRef) => [s.claimSeq, s.executor, s.session, s.stream].join('\n');

export function encodeCursor(s: StreamRef, offset: number): string {
    return Buffer.from(JSON.stringify({ s: refKey(s), o: offset })).toString('base64url');
}

/** Null when the cursor is not one this read issued for these streams. */
function decodeCursor(cursor: string, streams: readonly StreamSummary[]): Position | null {
    try {
        const { s, o } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s: unknown; o: unknown };
        const stream = streams.findIndex((candidate) => refKey(candidate) === s);
        if (stream < 0 || typeof o !== 'number' || !Number.isSafeInteger(o) || o < 0) return null;
        return { stream, offset: o };
    } catch {
        return null;
    }
}

/** One chunk as a segment; `deleted` when the task is gone or the store no longer holds the object. */
async function segmentOf(
    { store, jobRemoved }: Pick<Walk, 'store' | 'jobRemoved'>,
    s: StreamSummary,
    chunk: ChunkRecord,
    gapBefore: number
): Promise<Segment> {
    const segment: Segment = {
        attempt: s.claimSeq,
        executor: s.executor,
        session: s.session,
        stream: s.stream,
        offset: chunk.offset,
        length: chunk.length,
        gapBefore,
        state: 'deleted',
        text: null,
    };
    if (jobRemoved) return segment;
    try {
        const stored = await store.readChunk(s, chunk.offset);
        if (stored) return { ...segment, state: 'ok', text: new TextDecoder().decode(stored.body) };
    } catch (e) {
        if (!(e instanceof ArtifactObjectMissingError)) throw e;
    }
    return segment;
}

/**
 * One page, starting at `cursor` (the start of the selection when absent) and ending before the
 * chunk that would push it past `maxBytes` — but never empty while chunks remain, so a single
 * chunk larger than the budget is still readable. `streams` is the selection in reading order.
 */
export async function readPage(
    store: ArtifactStore,
    streams: readonly StreamSummary[],
    options: { cursor: string | undefined; maxBytes: number; jobRemoved: boolean }
): Promise<Page | 'bad_cursor'> {
    const from = options.cursor === undefined ? { stream: 0, offset: 0 } : decodeCursor(options.cursor, streams);
    if (!from) return 'bad_cursor';
    const walk: Walk = {
        store,
        ...options,
        views: streams.map((s) => viewOf(s, options.jobRemoved)),
        segments: [],
        bytes: 0,
    };
    for (let i = from.stream; i < streams.length; i++) {
        const nextCursor = await walkStream(walk, i, streams[i]!, i === from.stream ? from.offset : 0);
        if (nextCursor !== null) return { streams: walk.views, segments: walk.segments, nextCursor };
    }
    return { streams: walk.views, segments: walk.segments, nextCursor: null };
}

interface Walk {
    store: ArtifactStore;
    maxBytes: number;
    jobRemoved: boolean;
    views: StreamView[];
    segments: Segment[];
    bytes: number;
}

/** Appends one stream's chunks from `startAt` to the page; the cursor of the first one that does not fit, else null. */
async function walkStream(walk: Walk, index: number, s: StreamSummary, startAt: number): Promise<string | null> {
    let expected = startAt;
    for (const chunk of (await walk.store.listChunks(s)).filter((c) => c.offset >= startAt)) {
        const full = walk.bytes > 0 && walk.bytes + chunk.length > walk.maxBytes;
        if (full || walk.segments.length >= MAX_PAGE_SEGMENTS) return encodeCursor(s, chunk.offset);
        const segment = await segmentOf(walk, s, chunk, Math.max(0, chunk.offset - expected));
        expected = chunk.offset + chunk.length;
        walk.segments.push(segment);
        if (segment.text !== null) walk.bytes += chunk.length;
        // A stream whose object is gone reads as deleted from the page that found out.
        if (segment.state === 'deleted' && !walk.jobRemoved) {
            walk.views[index] = {
                ...walk.views[index]!,
                state: STREAM_STATE.deleted,
                terminalCause: OBJECT_MISSING_CAUSE,
            };
        }
    }
    return null;
}
