import type { Sql } from 'postgres';
import { chunkKey, checkStreamRef, parseChunkKey, type StreamRef } from './keys.js';
import type { ObjectStore } from './object-store.js';
import { sha256Hex } from './sigv4.js';

/**
 * The artifact index (070) over an object store, bound to one organization like every other store
 * here. Every call is scoped by that org: a stream ref names a member and below, never an org, so
 * there is no argument with which one org can reach another's bytes.
 *
 * The write order is the whole design: the chunk row `(stream, offset, length, sha256)` is
 * inserted first, then the object is written create-only. The object stores answer an identical
 * retry and a different body alike with a 412, so the row arbitrates — a body whose sha256 differs
 * from the recorded one is refused before the store is touched, and a 412 for the recorded one is
 * success.
 */

export const KIB = 1024;
export const MIB = KIB * KIB;
export const GIB = KIB * MIB;
/** A record larger than the flush size is its own chunk; above this the producer cuts it and marks the stream truncated. */
const MAX_CHUNK_MIB = 64;
export const MAX_CHUNK_BYTES = MAX_CHUNK_MIB * MIB;
/** The default per-stream cap (design: 1 GiB); the chart's `driver.artifactFlush.streamMax` is the producer's twin. */
export const DEFAULT_STREAM_MAX_BYTES = GIB;

/** Why a chunk or a stream stopped short; the names are what manifests record as `terminalCause`. */
export const ARTIFACT_CAUSE = {
    streamCap: 'stream_cap',
    orgQuota: 'org_quota',
} as const;
export type ChunkRefusal = (typeof ARTIFACT_CAUSE)[keyof typeof ARTIFACT_CAUSE];

export const MANIFEST_STATES = ['complete', 'partial', 'truncated'] as const;
export type ManifestState = (typeof MANIFEST_STATES)[number];

export interface ChunkRecord {
    offset: number;
    length: number;
    sha256: string;
}

export interface ManifestInput {
    producer: string;
    schemaVersion: number;
    startedAt: Date;
    finishedAt: Date;
    state: ManifestState;
    /** Required unless `complete`, and forbidden then. */
    terminalCause?: string | null;
}

export interface Manifest extends Required<Omit<ManifestInput, 'terminalCause'>> {
    terminalCause: string | null;
}

export type PutChunkResult =
    /** The object was written (`stored`) or was already there under the recorded sha256 (`duplicate`). */
    | { result: 'stored' | 'duplicate'; key: string }
    /** A different body is already recorded at this stream and offset; nothing was written. */
    | { result: 'conflict'; recorded: ChunkRecord }
    /** The chunk would cross a cap; nothing was written. */
    | { result: 'refused'; cause: ChunkRefusal };

export type FinalizeResult = { result: 'stored' | 'duplicate' } | { result: 'conflict'; recorded: Manifest };

export type ReadByKeyResult =
    | { result: 'ok'; chunk: StoredChunk }
    | { result: 'missing' }
    /** The key is well-formed but names another organization, or is not an artifact key at all. */
    | { result: 'refused' };

export interface StoredChunk extends ChunkRecord {
    body: Uint8Array;
}

/** The request was malformed: not a store failure, and the caller's to fix. */
export class InvalidArtifactError extends Error {}
/** The index and the store disagree about a chunk, or the stored bytes fail their recorded sha256. */
export class ArtifactIntegrityError extends Error {}
/** The index records a chunk whose object is gone from the store: deleted (retention, task removal), not corrupt. */
export class ArtifactObjectMissingError extends ArtifactIntegrityError {}

export interface ArtifactStore {
    putChunk(ref: StreamRef, offset: number, body: Uint8Array): Promise<PutChunkResult>;
    readChunk(ref: StreamRef, offset: number): Promise<StoredChunk | null>;
    /** By object key: refused unless the key is under this org's own prefix and indexed. */
    readByKey(key: string): Promise<ReadByKeyResult>;
    /** The stream's chunks in offset order, from the index alone. */
    listChunks(ref: StreamRef): Promise<ChunkRecord[]>;
    /** Writes the stream's manifest once; an identical repeat is a `duplicate`, a different one a `conflict`. */
    finalize(ref: StreamRef, manifest: ManifestInput): Promise<FinalizeResult>;
    readManifest(ref: StreamRef): Promise<Manifest | null>;
    /** Every manifest of one job (all attempts, sessions, streams), oldest first — its artifact finalization, apart from its verdict. */
    manifestsOfJob(job: string): Promise<(StreamRef & { manifest: Manifest })[]>;
    /** Every stream of one job with a chunk or a manifest, in attempt order — streams not yet finalized included. */
    streamsOfJob(job: string): Promise<StreamSummary[]>;
}

/** One stream of a job as the index knows it: its coordinates, what was stored, and its manifest once finalized. */
export interface StreamSummary extends StreamRef {
    chunks: number;
    bytes: number;
    manifest: Manifest | null;
}

export interface ArtifactStoreOptions {
    sql: Sql;
    orgId: string;
    ready: Promise<unknown>;
    objects: ObjectStore;
    /** Normalized: empty or one trailing slash (`normalizePrefix`). */
    prefix: string;
    streamMaxBytes?: number;
    /** 0 or absent: no per-org quota. */
    orgQuotaBytes?: number;
}

interface ChunkRow {
    byte_offset: string;
    length: number;
    sha256: string;
}

interface ManifestRow {
    member_id: string;
    root_job_id: string;
    job_id: string;
    claim_seq: number;
    executor: string;
    session_id: string;
    stream: string;
    producer: string;
    schema_version: number;
    started_at: Date;
    finished_at: Date;
    state: ManifestState;
    terminal_cause: string | null;
}

const toChunk = (row: ChunkRow): ChunkRecord => ({
    offset: Number(row.byte_offset),
    length: row.length,
    sha256: row.sha256,
});

const toManifest = (row: ManifestRow): Manifest => ({
    producer: row.producer,
    schemaVersion: row.schema_version,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    state: row.state,
    terminalCause: row.terminal_cause,
});

function sameManifest(a: Manifest, b: Manifest): boolean {
    return (
        a.producer === b.producer &&
        a.schemaVersion === b.schemaVersion &&
        a.startedAt.getTime() === b.startedAt.getTime() &&
        a.finishedAt.getTime() === b.finishedAt.getTime() &&
        a.state === b.state &&
        a.terminalCause === b.terminalCause
    );
}

function checkManifest(input: ManifestInput): Manifest {
    if (!MANIFEST_STATES.includes(input.state)) throw new InvalidArtifactError('state is not a manifest state');
    if (!input.producer) throw new InvalidArtifactError('producer is required');
    if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) {
        throw new InvalidArtifactError('schemaVersion must be a positive integer');
    }
    if (Number.isNaN(input.startedAt.getTime()) || Number.isNaN(input.finishedAt.getTime())) {
        throw new InvalidArtifactError('startedAt and finishedAt must be valid times');
    }
    const cause = input.terminalCause ?? null;
    if ((input.state === 'complete') !== (cause === null)) {
        throw new InvalidArtifactError('a terminal cause is required unless the state is complete, and forbidden then');
    }
    return { ...input, terminalCause: cause };
}

const streamIdentity = (r: StreamRef) => [r.member, r.root, r.claimSeq, r.executor, r.session, r.stream].join('/');

/** Attempt order, then session, then stream name: the order a reader walks a job's streams. */
const compareStreams = (a: StreamRef, b: StreamRef) =>
    a.claimSeq - b.claimSeq || a.session.localeCompare(b.session) || a.stream.localeCompare(b.stream);

/** The stream's coordinates as the columns the two tables share, validated once per call. */
function columnsOf(orgId: string, ref: StreamRef) {
    try {
        checkStreamRef(orgId, ref);
    } catch (e) {
        throw new InvalidArtifactError((e as Error).message);
    }
    return {
        org_id: orgId,
        member_id: ref.member,
        root_job_id: ref.root,
        job_id: ref.job,
        claim_seq: ref.claimSeq,
        executor: ref.executor,
        session_id: ref.session,
        stream: ref.stream,
    };
}

/** Manifests: written once per stream, read by stream or by job. */
function createManifestOps({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready: Promise<unknown>;
}): Pick<ArtifactStore, 'finalize' | 'readManifest' | 'manifestsOfJob'> {
    async function readManifest(ref: StreamRef): Promise<Manifest | null> {
        await ready;
        const c = columnsOf(orgId, ref);
        const rows = await sql<ManifestRow[]>`
            select * from artifact_manifest
            where org_id = ${c.org_id} and member_id = ${c.member_id} and root_job_id = ${c.root_job_id}
              and job_id = ${c.job_id} and claim_seq = ${c.claim_seq} and executor = ${c.executor}
              and session_id = ${c.session_id} and stream = ${c.stream}
        `;
        return rows[0] ? toManifest(rows[0]) : null;
    }

    return {
        async finalize(ref, input) {
            const manifest = checkManifest(input);
            await ready;
            const c = columnsOf(orgId, ref);
            const inserted = await sql`
                insert into artifact_manifest
                    (org_id, member_id, root_job_id, job_id, claim_seq, executor, session_id, stream,
                     producer, schema_version, started_at, finished_at, state, terminal_cause)
                values
                    (${c.org_id}, ${c.member_id}, ${c.root_job_id}, ${c.job_id}, ${c.claim_seq}, ${c.executor},
                     ${c.session_id}, ${c.stream}, ${manifest.producer}, ${manifest.schemaVersion},
                     ${manifest.startedAt}, ${manifest.finishedAt}, ${manifest.state}, ${manifest.terminalCause})
                on conflict do nothing
                returning stream
            `;
            if (inserted.length > 0) return { result: 'stored' };
            const recorded = (await readManifest(ref))!;
            return sameManifest(recorded, manifest) ? { result: 'duplicate' } : { result: 'conflict', recorded };
        },

        readManifest,

        async manifestsOfJob(job) {
            await ready;
            const rows = await sql<ManifestRow[]>`
                select * from artifact_manifest where org_id = ${orgId} and job_id = ${job}
                order by claim_seq, created_at, session_id, stream
            `;
            return rows.map((row) => ({
                member: row.member_id,
                root: row.root_job_id,
                job: row.job_id,
                claimSeq: row.claim_seq,
                executor: row.executor,
                session: row.session_id,
                stream: row.stream,
                manifest: toManifest(row),
            }));
        },
    };
}

export function createArtifactStore(options: ArtifactStoreOptions): ArtifactStore {
    const { sql, orgId, ready, objects, prefix } = options;
    const streamMax = options.streamMaxBytes ?? DEFAULT_STREAM_MAX_BYTES;
    const orgQuota = options.orgQuotaBytes ?? 0;
    const manifestOps = createManifestOps({ sql, orgId, ready });

    async function recordedChunk(ref: StreamRef, offset: number): Promise<ChunkRecord | null> {
        const c = columnsOf(orgId, ref);
        const rows = await sql<ChunkRow[]>`
            select byte_offset, length, sha256 from artifact_chunk
            where org_id = ${c.org_id} and member_id = ${c.member_id} and root_job_id = ${c.root_job_id}
              and job_id = ${c.job_id} and claim_seq = ${c.claim_seq} and executor = ${c.executor}
              and session_id = ${c.session_id} and stream = ${c.stream} and byte_offset = ${offset}
        `;
        return rows[0] ? toChunk(rows[0]) : null;
    }

    async function overCap(ref: StreamRef, length: number): Promise<ChunkRefusal | null> {
        const c = columnsOf(orgId, ref);
        const [stream] = await sql<{ bytes: string }[]>`
            select coalesce(sum(length), 0) as bytes from artifact_chunk
            where org_id = ${c.org_id} and member_id = ${c.member_id} and root_job_id = ${c.root_job_id}
              and job_id = ${c.job_id} and claim_seq = ${c.claim_seq} and executor = ${c.executor}
              and session_id = ${c.session_id} and stream = ${c.stream}
        `;
        if (Number(stream!.bytes) + length > streamMax) return ARTIFACT_CAUSE.streamCap;
        if (orgQuota > 0) {
            const [org] = await sql<{ bytes: string }[]>`
                select coalesce(sum(length), 0) as bytes from artifact_chunk where org_id = ${orgId}
            `;
            if (Number(org!.bytes) + length > orgQuota) return ARTIFACT_CAUSE.orgQuota;
        }
        return null;
    }

    async function readVerified(key: string, recorded: ChunkRecord): Promise<StoredChunk> {
        const body = await objects.get(key);
        if (body === null) throw new ArtifactObjectMissingError(`${key} is indexed but missing from the store`);
        if (body.length !== recorded.length || sha256Hex(body) !== recorded.sha256) {
            throw new ArtifactIntegrityError(`${key} does not match its recorded sha256`);
        }
        return { ...recorded, body };
    }

    async function readChunk(ref: StreamRef, offset: number): Promise<StoredChunk | null> {
        await ready;
        const recorded = await recordedChunk(ref, offset);
        if (!recorded) return null;
        return readVerified(chunkKey(prefix, orgId, ref, offset), recorded);
    }

    /**
     * The chunk's index row: the one already recorded, or the one this call inserts. Losing the
     * insert race to a concurrent writer reads back theirs, so the caller makes the same comparison
     * an ordinary retry makes. A refusal means nothing was recorded.
     */
    async function recordChunk(
        ref: StreamRef,
        offset: number,
        length: number,
        sha256: string
    ): Promise<ChunkRecord | ChunkRefusal> {
        const existing = await recordedChunk(ref, offset);
        if (existing) return existing;
        const refusal = await overCap(ref, length);
        if (refusal) return refusal;
        const c = columnsOf(orgId, ref);
        await sql`
            insert into artifact_chunk
                (org_id, member_id, root_job_id, job_id, claim_seq, executor, session_id, stream,
                 byte_offset, length, sha256)
            values
                (${c.org_id}, ${c.member_id}, ${c.root_job_id}, ${c.job_id}, ${c.claim_seq}, ${c.executor},
                 ${c.session_id}, ${c.stream}, ${offset}, ${length}, ${sha256})
            on conflict do nothing
        `;
        return (await recordedChunk(ref, offset))!;
    }

    function keyOf(ref: StreamRef, offset: number, body: Uint8Array): string {
        if (body.length === 0) throw new InvalidArtifactError('a chunk is at least one byte');
        if (body.length > MAX_CHUNK_BYTES) throw new InvalidArtifactError(`a chunk is at most ${MAX_CHUNK_MIB} MiB`);
        try {
            return chunkKey(prefix, orgId, ref, offset);
        } catch (e) {
            throw new InvalidArtifactError((e as Error).message);
        }
    }

    return {
        async putChunk(ref, offset, body) {
            const key = keyOf(ref, offset, body);
            await ready;
            const sha256 = sha256Hex(body);
            const recorded = await recordChunk(ref, offset, body.length, sha256);
            if (typeof recorded === 'string') return { result: 'refused', cause: recorded };
            if (recorded.sha256 !== sha256 || recorded.length !== body.length) return { result: 'conflict', recorded };
            // A row with no object (a crash between the insert and the write) is repaired by the same
            // call. A 412 is success only when what the store holds is the recorded body: the
            // recorded sha256 is this body's, so a held object that differs is an orphan from
            // outside the index, and the retry must not report it stored.
            const written = await objects.put(key, body);
            if (written === 'exists') await readVerified(key, recorded);
            return { result: written === 'created' ? 'stored' : 'duplicate', key };
        },

        readChunk,

        async readByKey(key) {
            const parsed = parseChunkKey(prefix, key);
            if (!parsed || parsed.orgId !== orgId) return { result: 'refused' };
            const chunk = await readChunk(parsed.ref, parsed.offset);
            return chunk ? { result: 'ok', chunk } : { result: 'missing' };
        },

        ...manifestOps,

        async streamsOfJob(job) {
            await ready;
            const rows = await sql<
                {
                    member_id: string;
                    root_job_id: string;
                    claim_seq: number;
                    executor: string;
                    session_id: string;
                    stream: string;
                    chunks: string;
                    bytes: string;
                }[]
            >`
                select member_id, root_job_id, claim_seq, executor, session_id, stream,
                       count(*) as chunks, coalesce(sum(length), 0) as bytes
                from artifact_chunk where org_id = ${orgId} and job_id = ${job}
                group by member_id, root_job_id, claim_seq, executor, session_id, stream
            `;
            const streams = new Map<string, StreamSummary>();
            for (const row of rows) {
                const summary: StreamSummary = {
                    member: row.member_id,
                    root: row.root_job_id,
                    job,
                    claimSeq: row.claim_seq,
                    executor: row.executor,
                    session: row.session_id,
                    stream: row.stream,
                    chunks: Number(row.chunks),
                    bytes: Number(row.bytes),
                    manifest: null,
                };
                streams.set(streamIdentity(summary), summary);
            }
            for (const { manifest, ...ref } of await manifestOps.manifestsOfJob(job)) {
                const id = streamIdentity(ref);
                streams.set(id, { chunks: 0, bytes: 0, ...streams.get(id), ...ref, manifest });
            }
            return [...streams.values()].sort(compareStreams);
        },

        async listChunks(ref) {
            await ready;
            const c = columnsOf(orgId, ref);
            const rows = await sql<ChunkRow[]>`
                select byte_offset, length, sha256 from artifact_chunk
                where org_id = ${c.org_id} and member_id = ${c.member_id} and root_job_id = ${c.root_job_id}
                  and job_id = ${c.job_id} and claim_seq = ${c.claim_seq} and executor = ${c.executor}
                  and session_id = ${c.session_id} and stream = ${c.stream}
                order by byte_offset
            `;
            return rows.map(toChunk);
        },
    };
}
