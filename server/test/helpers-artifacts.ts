import {
    ArtifactObjectMissingError,
    type ArtifactStore,
    type Manifest,
    type StreamSummary,
} from '../src/artifacts/artifact-store.js';
import type { StreamRef } from '../src/artifacts/keys.js';

/** An in-memory twin of the artifact store's read half, shared by the artifact read suites. */
export const JOB = '11111111-1111-4111-8111-111111111111';
export const MEMBER = 'member-1';
export const ROOT = JOB;
export const TRANSCRIPT = 'transcript';
export const LOG = 'log';

export interface FakeChunk {
    offset: number;
    text: string;
    /** The object is gone from the store; the index still lists it. */
    deleted?: boolean;
}
export interface FakeStream {
    ref: StreamRef;
    chunks: FakeChunk[];
    manifest: Manifest | null;
}

export const ref = (over: Partial<StreamRef> = {}): StreamRef => ({
    member: MEMBER,
    root: ROOT,
    job: JOB,
    claimSeq: 1,
    executor: 'claude-code',
    session: 'sess-a',
    stream: TRANSCRIPT,
    ...over,
});

export const manifest = (state: Manifest['state'], terminalCause: string | null = null): Manifest => ({
    producer: 'exporter',
    schemaVersion: 1,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:05:00Z'),
    state,
    terminalCause,
});

/** Chunks laid end to end from offset 0, the way a producer cuts them. */
export function stream(
    over: Partial<StreamRef>,
    texts: string[],
    m: Manifest | null = manifest('complete')
): FakeStream {
    let offset = 0;
    const chunks = texts.map((text) => {
        const chunk = { offset, text };
        offset += text.length;
        return chunk;
    });
    return { ref: ref(over), chunks, manifest: m };
}

/** A real store keys on the seven coordinates only; the summaries the route passes back carry more. */
const same = (a: StreamRef, b: StreamRef) =>
    (['member', 'root', 'job', 'claimSeq', 'executor', 'session', 'stream'] as const).every((k) => a[k] === b[k]);

/** Records every chunk read so a test can prove another org's bytes were never fetched. */
export function fakeArtifacts(streams: FakeStream[]) {
    const reads: string[] = [];
    const store = {
        async streamsOfJob(job: string): Promise<StreamSummary[]> {
            return streams
                .filter((s) => s.ref.job === job)
                .map((s) => ({
                    ...s.ref,
                    chunks: s.chunks.length,
                    bytes: s.chunks.reduce((n, c) => n + c.text.length, 0),
                    manifest: s.manifest,
                }))
                .sort((a, b) => a.claimSeq - b.claimSeq || a.session.localeCompare(b.session));
        },
        async listChunks(r: StreamRef) {
            const found = streams.find((s) => same(s.ref, r));
            return (found?.chunks ?? []).map((c) => ({
                offset: c.offset,
                length: c.text.length,
                sha256: '0'.repeat(64),
            }));
        },
        async readChunk(r: StreamRef, offset: number) {
            const chunk = streams.find((s) => same(s.ref, r))?.chunks.find((c) => c.offset === offset);
            if (!chunk) return null;
            reads.push(`${r.session}/${r.stream}/${offset}`);
            if (chunk.deleted) throw new ArtifactObjectMissingError('gone');
            return {
                offset,
                length: chunk.text.length,
                sha256: '0'.repeat(64),
                body: new TextEncoder().encode(chunk.text),
            };
        },
    } as unknown as ArtifactStore;
    return { store, reads };
}
