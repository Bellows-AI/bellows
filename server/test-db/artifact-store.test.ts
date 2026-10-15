import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import {
    ARTIFACT_CAUSE,
    ArtifactIntegrityError,
    createArtifactStore,
    InvalidArtifactError,
    type ArtifactStore,
} from '../src/artifacts/artifact-store.js';
import { chunkKey, type StreamRef } from '../src/artifacts/keys.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { createJobStore } from '../src/db/job-store.js';
import { BACKENDS } from '../test/artifacts-backends.js';
import { mustCreate, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/** The artifact index (070) over each backend: idempotency, conflict, scoping and finalization, on a real database. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const AUTHOR = testUser('artifact-author');
const LEASE_SECONDS = 300;

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [AUTHOR] });
let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (body: Uint8Array | null | undefined) => (body ? new TextDecoder().decode(body) : null);

/** A fresh stream: ids are generated, never literal, so tests share no coordinates. */
const streamRef = (over: Partial<StreamRef> = {}): StreamRef => ({
    member: randomUUID(),
    root: randomUUID(),
    job: randomUUID(),
    claimSeq: 1,
    executor: 'claude-code',
    session: randomUUID(),
    stream: 'raw',
    ...over,
});

const MANIFEST = {
    producer: 'exporter',
    schemaVersion: 1,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:05:00Z'),
    state: 'complete' as const,
};

const chunkRows = async (ref: StreamRef, org = ORG) =>
    sql<{ byte_offset: string; sha256: string }[]>`
        select byte_offset, sha256 from artifact_chunk
        where org_id = ${org} and job_id = ${ref.job} and stream = ${ref.stream} order by byte_offset
    `;

describe.skipIf(!enabled).each(BACKENDS)('artifact index over $name', ({ make, prefix, skip }) => {
    async function setup(
        over: { streamMaxBytes?: number; orgQuotaBytes?: number; objects?: (o: ObjectStore) => ObjectStore } = {}
    ) {
        const { objects: wrap, ...limits } = over;
        const raw = await make();
        const objects = wrap ? wrap(raw) : raw;
        const build = (orgId: string): ArtifactStore =>
            createArtifactStore({ sql, orgId, ready: Promise.resolve(), objects, prefix, ...limits });
        return { raw, store: build(ORG), other: build(OTHER_ORG), build };
    }

    it.skipIf(skip)('stores a chunk, records it in the index and reads it back verified', async () => {
        const { store } = await setup();
        const ref = streamRef();
        const put = await store.putChunk(ref, 0, bytes('hello'));
        expect(put).toMatchObject({ result: 'stored', key: chunkKey(prefix, ORG, ref, 0) });
        expect(await store.listChunks(ref)).toEqual([
            expect.objectContaining({ offset: 0, length: 5, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        ]);
        expect(text((await store.readChunk(ref, 0))?.body)).toBe('hello');
    });

    it.skipIf(skip)('is idempotent: the same chunk twice leaves one row and one object', async () => {
        const { store, raw } = await setup();
        const ref = streamRef();
        await store.putChunk(ref, 0, bytes('same bytes'));
        expect(await store.putChunk(ref, 0, bytes('same bytes'))).toMatchObject({ result: 'duplicate' });
        expect(await chunkRows(ref)).toHaveLength(1);
        expect(text(await raw.get(chunkKey(prefix, ORG, ref, 0)))).toBe('same bytes');
    });

    it.skipIf(skip)('refuses a different body at the same stream and offset, and keeps the first', async () => {
        const { store, raw } = await setup();
        const ref = streamRef();
        await store.putChunk(ref, 40, bytes('original'));
        const refused = await store.putChunk(ref, 40, bytes('replacement'));
        expect(refused).toMatchObject({ result: 'conflict', recorded: { offset: 40, length: 8 } });
        expect(await chunkRows(ref)).toHaveLength(1);
        expect(text(await raw.get(chunkKey(prefix, ORG, ref, 40)))).toBe('original');
        expect(text((await store.readChunk(ref, 40))?.body)).toBe('original');
    });

    it.skipIf(skip)('keeps chunks of other offsets, streams and attempts apart', async () => {
        const { store } = await setup();
        const ref = streamRef();
        await store.putChunk(ref, 0, bytes('a'));
        await store.putChunk(ref, 1, bytes('b'));
        await store.putChunk({ ...ref, stream: 'derived' }, 0, bytes('c'));
        await store.putChunk({ ...ref, claimSeq: 2 }, 0, bytes('d'));
        expect((await store.listChunks(ref)).map((c) => c.offset)).toEqual([0, 1]);
        expect(text((await store.readChunk({ ...ref, stream: 'derived' }, 0))?.body)).toBe('c');
        expect(text((await store.readChunk({ ...ref, claimSeq: 2 }, 0))?.body)).toBe('d');
    });

    it.skipIf(skip)('lets one of several concurrent writers of different bodies win and refuses the rest', async () => {
        const { store } = await setup();
        const ref = streamRef();
        const results = await Promise.all(
            Array.from({ length: 6 }, (_, i) => store.putChunk(ref, 0, bytes(`writer ${i} body`)))
        );
        expect(results.filter((r) => r.result === 'stored')).toHaveLength(1);
        expect(results.filter((r) => r.result === 'conflict')).toHaveLength(5);
        expect(await chunkRows(ref)).toHaveLength(1);
    });

    it.skipIf(skip)('accepts concurrent identical retries as successes', async () => {
        const { store } = await setup();
        const ref = streamRef();
        const results = await Promise.all(Array.from({ length: 6 }, () => store.putChunk(ref, 0, bytes('retry'))));
        expect(results.every((r) => r.result === 'stored' || r.result === 'duplicate')).toBe(true);
        expect(await chunkRows(ref)).toHaveLength(1);
    });

    it.skipIf(skip)(
        'inserts the index row before the store write: a failed write leaves the row, and a retry completes it',
        async () => {
            let failNext = true;
            const { store, raw } = await setup({
                objects: (o) => ({
                    ...o,
                    put: async (key, body) => {
                        if (failNext) {
                            failNext = false;
                            throw new Error('store unavailable');
                        }
                        return o.put(key, body);
                    },
                }),
            });
            const ref = streamRef();
            await expect(store.putChunk(ref, 0, bytes('first try'))).rejects.toThrow('store unavailable');
            expect(await chunkRows(ref)).toHaveLength(1);
            expect(await raw.get(chunkKey(prefix, ORG, ref, 0))).toBeNull();

            // The recorded body is the only one that may complete it.
            expect(await store.putChunk(ref, 0, bytes('other body'))).toMatchObject({ result: 'conflict' });
            expect(await store.putChunk(ref, 0, bytes('first try'))).toMatchObject({ result: 'stored' });
            expect(text((await store.readChunk(ref, 0))?.body)).toBe('first try');
        }
    );

    it.skipIf(skip)(
        'does not count a 412 as success when the store holds a body the index did not record',
        async () => {
            const { store, raw } = await setup();
            const ref = streamRef();
            await raw.put(chunkKey(prefix, ORG, ref, 0), bytes('planted outside the index'));
            await expect(store.putChunk(ref, 0, bytes('the real chunk'))).rejects.toBeInstanceOf(
                ArtifactIntegrityError
            );
        }
    );

    it.skipIf(skip)('refuses to serve bytes that no longer match the recorded sha256', async () => {
        const { store, raw } = await setup();
        const ref = streamRef();
        await store.putChunk(ref, 0, bytes('as written'));
        await raw.delete(chunkKey(prefix, ORG, ref, 0));
        await raw.put(chunkKey(prefix, ORG, ref, 0), bytes('tampered!!'));
        await expect(store.readChunk(ref, 0)).rejects.toBeInstanceOf(ArtifactIntegrityError);
        await raw.delete(chunkKey(prefix, ORG, ref, 0));
        await expect(store.readChunk(ref, 0)).rejects.toThrow(/missing from the store/);
    });

    it.skipIf(skip)('does not serve an object the index does not know, even though the store holds it', async () => {
        const { store, raw } = await setup();
        const ref = streamRef();
        await raw.put(chunkKey(prefix, ORG, ref, 0), bytes('unindexed'));
        expect(await store.readChunk(ref, 0)).toBeNull();
    });

    it.skipIf(skip)('refuses another organization’s artifact, by coordinates and by key', async () => {
        const { store, other } = await setup();
        const ref = streamRef();
        const { key } = (await store.putChunk(ref, 0, bytes('tenant secret'))) as { key: string };
        await store.finalize(ref, MANIFEST);

        // Same coordinates, other org: nothing there.
        expect(await other.readChunk(ref, 0)).toBeNull();
        expect(await other.listChunks(ref)).toEqual([]);
        expect(await other.readManifest(ref)).toBeNull();
        expect(await other.manifestsOfJob(ref.job)).toEqual([]);
        // The key itself is not a capability.
        expect(await other.readByKey(key)).toEqual({ result: 'refused' });
        expect(await store.readByKey(key)).toMatchObject({ result: 'ok' });
        // A forged key naming the other org with coordinates it does not hold is refused too, and
        // an unindexed key of the caller's own org is merely missing.
        expect(await other.readByKey(chunkKey(prefix, ORG, ref, 0))).toEqual({ result: 'refused' });
        expect(await store.readByKey(chunkKey(prefix, ORG, ref, 99))).toEqual({ result: 'missing' });
        expect(await store.readByKey('not/an/artifact/key')).toEqual({ result: 'refused' });
    });

    it.skipIf(skip)('writes the same coordinates in two orgs as two independent artifacts', async () => {
        const { store, other, raw } = await setup();
        const ref = streamRef();
        await store.putChunk(ref, 0, bytes('org one'));
        expect(await other.putChunk(ref, 0, bytes('org two'))).toMatchObject({ result: 'stored' });
        expect(text((await store.readChunk(ref, 0))?.body)).toBe('org one');
        expect(text((await other.readChunk(ref, 0))?.body)).toBe('org two');
        expect(text(await raw.get(chunkKey(prefix, OTHER_ORG, ref, 0)))).toBe('org two');
    });

    it.skipIf(skip)(
        'refuses a chunk that crosses the stream cap, but still accepts a retry of one already stored',
        async () => {
            const { store } = await setup({ streamMaxBytes: 10 });
            const ref = streamRef();
            await store.putChunk(ref, 0, bytes('123456'));
            expect(await store.putChunk(ref, 6, bytes('78901'))).toEqual({
                result: 'refused',
                cause: ARTIFACT_CAUSE.streamCap,
            });
            expect(await store.putChunk(ref, 0, bytes('123456'))).toMatchObject({ result: 'duplicate' });
            expect(await store.putChunk(ref, 6, bytes('7890'))).toMatchObject({ result: 'stored' });
            expect(await chunkRows(ref)).toHaveLength(2);
        }
    );

    it.skipIf(skip)('refuses a chunk that crosses the org quota, counting only its own org', async () => {
        const { store, other } = await setup({ orgQuotaBytes: 8 });
        await store.putChunk(streamRef(), 0, bytes('12345'));
        expect(await store.putChunk(streamRef(), 0, bytes('6789'))).toEqual({
            result: 'refused',
            cause: ARTIFACT_CAUSE.orgQuota,
        });
        expect(await other.putChunk(streamRef(), 0, bytes('123456'))).toMatchObject({ result: 'stored' });
    });

    it.skipIf(skip)(
        'refuses malformed coordinates and empty or oversized chunks as invalid, not as store errors',
        async () => {
            const { store } = await setup();
            await expect(store.putChunk(streamRef({ session: '../x' }), 0, bytes('a'))).rejects.toBeInstanceOf(
                InvalidArtifactError
            );
            await expect(store.putChunk(streamRef(), -1, bytes('a'))).rejects.toBeInstanceOf(InvalidArtifactError);
            await expect(store.putChunk(streamRef(), 0, new Uint8Array())).rejects.toBeInstanceOf(InvalidArtifactError);
        }
    );

    describe('manifests', () => {
        it.skipIf(skip)('records producer, schema version, timestamps, state and terminal cause once', async () => {
            const { store } = await setup();
            const ref = streamRef();
            const truncated = { ...MANIFEST, state: 'truncated' as const, terminalCause: ARTIFACT_CAUSE.streamCap };
            expect(await store.finalize(ref, truncated)).toEqual({ result: 'stored' });
            expect(await store.readManifest(ref)).toEqual(truncated);
            // Identical repeat: idempotent. Different content: refused, original kept.
            expect(await store.finalize(ref, truncated)).toEqual({ result: 'duplicate' });
            expect(await store.finalize(ref, MANIFEST)).toMatchObject({
                result: 'conflict',
                recorded: { state: 'truncated' },
            });
            expect((await store.readManifest(ref))?.state).toBe('truncated');
        });

        it.skipIf(skip)('requires a cause exactly when the stream is not complete', async () => {
            const { store } = await setup();
            await expect(store.finalize(streamRef(), { ...MANIFEST, state: 'partial' })).rejects.toBeInstanceOf(
                InvalidArtifactError
            );
            await expect(
                store.finalize(streamRef(), { ...MANIFEST, terminalCause: 'stream_cap' })
            ).rejects.toBeInstanceOf(InvalidArtifactError);
            await expect(store.finalize(streamRef(), { ...MANIFEST, state: 'bogus' as never })).rejects.toBeInstanceOf(
                InvalidArtifactError
            );
            await expect(store.finalize(streamRef(), { ...MANIFEST, schemaVersion: 0 })).rejects.toBeInstanceOf(
                InvalidArtifactError
            );
        });

        it.skipIf(skip)('lists a job’s manifests across attempts, sessions and streams', async () => {
            const { store } = await setup();
            const ref = streamRef();
            await store.finalize(ref, MANIFEST);
            await store.finalize(
                { ...ref, stream: 'derived' },
                { ...MANIFEST, state: 'partial', terminalCause: 'lost_unacknowledged' }
            );
            await store.finalize({ ...ref, claimSeq: 2 }, MANIFEST);
            const listed = await store.manifestsOfJob(ref.job);
            expect(listed.map((m) => [m.claimSeq, m.stream, m.manifest.state])).toEqual([
                [1, 'raw', 'complete'],
                [1, 'derived', 'partial'],
                [2, 'raw', 'complete'],
            ]);
        });

        it.skipIf(skip)('keeps artifact finalization independent of the task verdict', async () => {
            const { build } = await setup();
            const store = build(ORG);
            const jobs = createJobStore({ sql, orgId: ORG });
            const finish = async (status: 'succeeded' | 'failed') => {
                const { id } = await mustCreate(
                    jobs.create(`echo ${status}`, AUTHOR.id, { repo: null, executor: null })
                );
                const claim = await jobs.claim('artifact-worker', LEASE_SECONDS);
                await jobs.complete(id, claim!.leaseToken, {
                    status,
                    exitCode: status === 'succeeded' ? 0 : 1,
                    output: null,
                });
                return id;
            };
            const succeeded = await finish('succeeded');
            const failed = await finish('failed');

            // A task that succeeded can leave a truncated transcript; one that failed, a complete one.
            const a = streamRef({ job: succeeded });
            const b = streamRef({ job: failed });
            await store.finalize(a, { ...MANIFEST, state: 'truncated', terminalCause: ARTIFACT_CAUSE.streamCap });
            await store.finalize(b, MANIFEST);

            expect((await jobs.get(succeeded))?.status).toBe('succeeded');
            expect((await jobs.get(failed))?.status).toBe('failed');
            expect((await store.readManifest(a))?.state).toBe('truncated');
            expect((await store.readManifest(b))?.state).toBe('complete');
            // Finalizing never moved a verdict, and the verdict columns carry no artifact state.
            const columns = await sql<{ column_name: string }[]>`
                select column_name from information_schema.columns where table_name = 'job' and column_name like '%artifact%'
            `;
            expect(columns).toEqual([]);
        });
    });
});

describe.skipIf(!enabled)('the old job_artifact storage', () => {
    it('is gone: no table survives migration 070', async () => {
        const [row] = await sql<{ present: string | null }[]>`select to_regclass('job_artifact')::text as present`;
        expect(row?.present).toBeNull();
    });
});
