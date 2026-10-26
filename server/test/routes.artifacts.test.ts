import { OCTET_STREAM_CONTENT_TYPE } from '@factory-ai/core';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ArtifactStore, Manifest, ManifestInput } from '../src/artifacts/artifact-store.js';
import type { StreamRef } from '../src/artifacts/keys.js';
import type { JobArtifactScope, JobStore } from '../src/db/jobs/job-store-types.js';
import { UNATTRIBUTED_MEMBER } from '../src/routes/jobs/job-handlers-artifacts.js';
import { trackApps } from './helpers-http.js';
import { staticRegistry, testConfig } from './helpers.js';

const track = trackApps();

const JOB = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const SESSION = 'session-1';
const STREAM = 'log';

/**
 * A job store that answers the claim scope and refuses everything else: an upload that reached any
 * other method — a status, session, gates, verdict or publication write — would throw.
 */
function scopeOnlyStore(scope: JobArtifactScope | null, extra: Partial<JobStore> = {}) {
    const base = { artifactScope: async () => scope, ...extra } satisfies Partial<JobStore>;
    return new Proxy(base, {
        get(target, name) {
            if (name in target) return target[name as keyof typeof target];
            // `await` probes `then`; a thenable that throws would read as a failed store.
            if (name === 'then') return Reflect.get(target, name);
            return () => {
                throw new Error(`an artifact upload must not call JobStore.${String(name)}`);
            };
        },
    }) as unknown as JobStore;
}

/** An index that stores each (stream, offset) once, like the real one, and records what reached it. */
function memoryArtifacts() {
    const chunks = new Map<string, Uint8Array>();
    const manifests = new Map<string, Manifest>();
    const puts: { ref: StreamRef; offset: number }[] = [];
    const finalizes: StreamRef[] = [];
    const at = (ref: StreamRef, offset: number) => `${JSON.stringify(ref)}@${offset}`;
    const store = {
        async putChunk(ref, offset, body) {
            puts.push({ ref, offset });
            const held = chunks.get(at(ref, offset));
            if (!held) {
                chunks.set(at(ref, offset), body);
                return { result: 'stored', key: at(ref, offset) };
            }
            const same = Buffer.compare(Buffer.from(held), Buffer.from(body)) === 0;
            if (same) return { result: 'duplicate', key: at(ref, offset) };
            return { result: 'conflict', recorded: { offset, length: held.length, sha256: '0'.repeat(64) } };
        },
        async listChunks(ref) {
            return [...chunks]
                .filter(([k]) => k.startsWith(`${JSON.stringify(ref)}@`))
                .map(([k, body]) => ({
                    offset: Number(k.split('@').pop()),
                    length: body.length,
                    sha256: '0'.repeat(64),
                }));
        },
        async readChunk(ref, offset) {
            const body = chunks.get(at(ref, offset));
            return body ? { offset, length: body.length, sha256: '0'.repeat(64), body } : null;
        },
        async finalize(ref, input: ManifestInput) {
            finalizes.push(ref);
            const manifest = { ...input, terminalCause: input.terminalCause ?? null };
            const key = JSON.stringify(ref);
            if (manifests.has(key)) return { result: 'duplicate' };
            manifests.set(key, manifest);
            return { result: 'stored' };
        },
    } as ArtifactStore;
    return { store, chunks, puts, finalizes };
}

async function boot(
    scope: JobArtifactScope | null,
    artifacts?: ArtifactStore,
    extra: Partial<JobStore> = {}
): Promise<FastifyInstance> {
    const config = testConfig();
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, jobs: scopeOnlyStore(scope, extra), artifacts }),
    });
    track(instance);
    return instance;
}

const CURRENT_CLAIM = 3;
const SCOPE: JobArtifactScope = { member: MEMBER, root: ROOT, claimSeq: CURRENT_CLAIM };

/** The chunk route's query for one stream coordinate, with any field overridden to something malformed. */
const chunkQuery = (claimSeq: number, offset: number, over: Record<string, string> = {}) =>
    new URLSearchParams({
        claimSeq: String(claimSeq),
        executor: 'claude-code',
        session: SESSION,
        stream: STREAM,
        offset: String(offset),
        ...over,
    });

const sendChunk = (instance: FastifyInstance, query: URLSearchParams, text: string) =>
    instance.inject({
        method: 'PUT',
        url: `/api/jobs/${JOB}/artifact/chunk?${query}`,
        headers: { 'content-type': OCTET_STREAM_CONTENT_TYPE },
        payload: Buffer.from(text),
    });

const putChunk = (instance: FastifyInstance, claimSeq: number, offset: number, text: string) =>
    sendChunk(instance, chunkQuery(claimSeq, offset), text);

const MANIFEST = {
    executor: 'claude-code',
    session: SESSION,
    stream: STREAM,
    producer: 'driver',
    schemaVersion: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    state: 'complete',
};

const putManifest = (instance: FastifyInstance, claimSeq: number, over: Record<string, unknown> = {}) =>
    instance.inject({
        method: 'PUT',
        url: `/api/jobs/${JOB}/artifact/manifest`,
        payload: { ...MANIFEST, claimSeq, ...over },
    });

describe('PUT /api/jobs/:id/artifact/chunk', () => {
    it('files a chunk under the member, root, job and claim the row names', async () => {
        const fake = memoryArtifacts();
        const instance = await boot(SCOPE, fake.store);

        const response = await putChunk(instance, CURRENT_CLAIM, 0, 'hello');

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ result: 'stored', offset: 0 });
        expect(fake.puts).toEqual([
            {
                offset: 0,
                ref: {
                    member: MEMBER,
                    root: ROOT,
                    job: JOB,
                    claimSeq: CURRENT_CLAIM,
                    executor: 'claude-code',
                    session: SESSION,
                    stream: STREAM,
                },
            },
        ]);
    });

    it('files non-text bytes on the checkpoint stream and accepts its checkpoint_cap manifest', async () => {
        const fake = memoryArtifacts();
        const instance = await boot(SCOPE, fake.store);
        const query = chunkQuery(CURRENT_CLAIM, 0, { stream: 'checkpoint', session: 'none' });

        const chunk = await instance.inject({
            method: 'PUT',
            url: `/api/jobs/${JOB}/artifact/chunk?${query}`,
            headers: { 'content-type': OCTET_STREAM_CONTENT_TYPE },
            payload: Buffer.from([0x00, 0xff, 0xfe, 0x80]),
        });
        const manifest = await putManifest(instance, CURRENT_CLAIM, {
            stream: 'checkpoint',
            session: 'none',
            state: 'truncated',
            terminalCause: 'checkpoint_cap',
        });

        expect(chunk.statusCode).toBe(200);
        expect(fake.puts[0]!.ref).toMatchObject({ stream: 'checkpoint', session: 'none' });
        expect(manifest.statusCode).toBe(200);
    });

    it('files an unattributed job under the placeholder member', async () => {
        const fake = memoryArtifacts();
        const instance = await boot({ ...SCOPE, member: null }, fake.store);

        await putChunk(instance, CURRENT_CLAIM, 0, 'hello');

        expect(fake.puts[0]!.ref.member).toBe(UNATTRIBUTED_MEMBER);
    });

    it('stores a stale attempt’s chunk under its own claim and touches no job state', async () => {
        // The job has been reclaimed twice since claim 1 ran: no lease of claim 1 is live, and the
        // store below throws on any JobStore method but the scope read.
        const fake = memoryArtifacts();
        const instance = await boot(SCOPE, fake.store);

        const stale = await putChunk(instance, 1, 0, 'from the old attempt');
        const current = await putChunk(instance, CURRENT_CLAIM, 0, 'from the new attempt');

        expect(stale.statusCode).toBe(200);
        expect(current.statusCode).toBe(200);
        expect(fake.puts.map((put) => put.ref.claimSeq)).toEqual([1, CURRENT_CLAIM]);
        expect(fake.chunks.size).toBe(2);
    });

    it('stores a chunk once when the response was lost and the driver retries it', async () => {
        const fake = memoryArtifacts();
        const instance = await boot(SCOPE, fake.store);

        const first = await putChunk(instance, CURRENT_CLAIM, 0, 'hello');
        const retry = await putChunk(instance, CURRENT_CLAIM, 0, 'hello');

        expect(first.json().result).toBe('stored');
        expect(retry.statusCode).toBe(200);
        expect(retry.json().result).toBe('duplicate');
        expect(fake.chunks.size).toBe(1);
    });

    it('answers 409 ARTIFACT_CONFLICT for a different body at a stored offset', async () => {
        const instance = await boot(SCOPE, memoryArtifacts().store);
        await putChunk(instance, CURRENT_CLAIM, 0, 'hello');

        const response = await putChunk(instance, CURRENT_CLAIM, 0, 'other');

        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('ARTIFACT_CONFLICT');
    });

    it('refuses a claim sequence the job has not reached, or never had', async () => {
        const fake = memoryArtifacts();
        const instance = await boot(SCOPE, fake.store);

        for (const claimSeq of [0, CURRENT_CLAIM + 1]) {
            const response = await putChunk(instance, claimSeq, 0, 'hello');
            expect(response.statusCode).toBe(400);
            expect(response.json().code).toBe('BAD_CLAIM_SEQ');
        }
        const missing = await sendChunk(instance, chunkQuery(1, 0, { claimSeq: 'x' }), 'hello');
        expect(missing.json().code).toBe('BAD_CLAIM_SEQ');
        expect(fake.puts).toEqual([]);
    });

    it('answers 413 ARTIFACT_REFUSED with the cause when the index refuses the chunk', async () => {
        const refusing = {
            putChunk: async () => ({ result: 'refused', cause: 'stream_cap' }),
        } as unknown as ArtifactStore;
        const instance = await boot(SCOPE, refusing);

        const response = await putChunk(instance, CURRENT_CLAIM, 0, 'hello');

        expect(response.statusCode).toBe(413);
        expect(response.json()).toMatchObject({ code: 'ARTIFACT_REFUSED', cause: 'stream_cap' });
    });

    it('answers 400 BAD_ARTIFACT for a malformed stream coordinate', async () => {
        const { InvalidArtifactError } = await import('../src/artifacts/artifact-store.js');
        const invalid = {
            putChunk: async () => {
                throw new InvalidArtifactError('session is not a valid key segment');
            },
        } as unknown as ArtifactStore;
        const instance = await boot(SCOPE, invalid);

        const response = await sendChunk(instance, chunkQuery(CURRENT_CLAIM, 0, { session: '../x' }), 'hello');

        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_ARTIFACT');
    });

    it('answers 404 for a job the org does not have, and 503 when no store is configured', async () => {
        const unknown = await boot(null, memoryArtifacts().store);
        expect((await putChunk(unknown, 1, 0, 'x')).statusCode).toBe(404);

        const bare = await boot(SCOPE);
        const response = await putChunk(bare, 1, 0, 'x');
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('ARTIFACTS_UNAVAILABLE');
    });
});

describe('PUT /api/jobs/:id/artifact/manifest', () => {
    it('finalizes a stale attempt’s stream under its own claim and touches no job state', async () => {
        const fake = memoryArtifacts();
        const instance = await boot(SCOPE, fake.store);

        const response = await putManifest(instance, 1);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ result: 'stored' });
        expect(fake.finalizes).toEqual([expect.objectContaining({ job: JOB, claimSeq: 1, stream: STREAM })]);
    });

    it('is a no-op the second time', async () => {
        const instance = await boot(SCOPE, memoryArtifacts().store);
        await putManifest(instance, CURRENT_CLAIM);

        const retry = await putManifest(instance, CURRENT_CLAIM);

        expect(retry.statusCode).toBe(200);
        expect(retry.json()).toEqual({ result: 'duplicate' });
    });

    it('refuses a claim ahead of the job’s and a manifest missing its fields', async () => {
        const instance = await boot(SCOPE, memoryArtifacts().store);

        const ahead = await putManifest(instance, CURRENT_CLAIM + 1);
        const incomplete = await putManifest(instance, 1, { state: 'finished' });

        expect(ahead.json().code).toBe('BAD_CLAIM_SEQ');
        expect(incomplete.statusCode).toBe(400);
        expect(incomplete.json().code).toBe('BAD_ARTIFACT');
    });
});

describe('the transcript tool ingest', () => {
    type Ingest = Parameters<JobStore['ingestTranscriptTools']>;
    const recorder = (fail = false) => {
        const calls: { id: string; input: Ingest[1] }[] = [];
        const ingestTranscriptTools: JobStore['ingestTranscriptTools'] = async (id, input) => {
            calls.push({ id, input });
            if (fail) throw new Error('the board is down');
            return { result: 'ok', written: 0 };
        };
        return { calls, ingestTranscriptTools };
    };
    const raw =
        (claimSeq: number, offset: number, text: string, over: Record<string, string> = {}) =>
        (instance: FastifyInstance) =>
            sendChunk(instance, chunkQuery(claimSeq, offset, { stream: 'transcript-raw', ...over }), text);

    it('reads a transcript-raw chunk with its neighbours, under the claim and executor of the stream, not the label', async () => {
        const fake = memoryArtifacts();
        const ingest = recorder();
        const instance = await boot(SCOPE, fake.store, ingest);
        await raw(CURRENT_CLAIM, 0, 'a\n')(instance);
        await raw(CURRENT_CLAIM, 2, 'b\n')(instance);
        await raw(CURRENT_CLAIM, 4, 'c\n')(instance);

        expect(ingest.calls.map((c) => c.input.chunks.map((x) => x.offset))).toEqual([[0], [0, 2], [2, 4]]);
        expect(ingest.calls[2]).toMatchObject({
            id: JOB,
            input: { executor: 'claude-code', stream: 'transcript-raw', claimSeq: CURRENT_CLAIM },
        });
        // The artifact's session segment is a label; the ingest reads the session out of the records.
        expect(JSON.stringify(ingest.calls[2]?.input)).not.toContain(SESSION);
    });

    it('a repeated put reads the same chunk again; the store is what makes that a no-op', async () => {
        const ingest = recorder();
        const instance = await boot(SCOPE, memoryArtifacts().store, ingest);
        await raw(CURRENT_CLAIM, 0, 'a\n')(instance);
        const again = await raw(CURRENT_CLAIM, 0, 'a\n')(instance);
        expect(again.json()).toEqual({ result: 'duplicate', offset: 0 });
        expect(ingest.calls).toHaveLength(2);
    });

    it('a finalize reads every chunk of the stream', async () => {
        const ingest = recorder();
        const instance = await boot(SCOPE, memoryArtifacts().store, ingest);
        await raw(CURRENT_CLAIM, 0, 'a\n')(instance);
        await raw(CURRENT_CLAIM, 2, 'b\n')(instance);
        ingest.calls.length = 0;
        const done = await putManifest(instance, CURRENT_CLAIM, { stream: 'transcript-raw' });
        expect(done.statusCode).toBe(200);
        expect(ingest.calls.map((c) => c.input.chunks.map((x) => x.offset))).toEqual([
            [0, 2],
            [0, 2],
        ]);
    });

    it('other streams, and executors it cannot read, are never read', async () => {
        const ingest = recorder();
        const instance = await boot(SCOPE, memoryArtifacts().store, ingest);
        await putChunk(instance, CURRENT_CLAIM, 0, 'log line\n');
        await raw(CURRENT_CLAIM, 0, 'a\n', { executor: 'some-other-agent' })(instance);
        await putManifest(instance, CURRENT_CLAIM);
        expect(ingest.calls).toEqual([]);
    });

    it('a failing ingest never fails the upload', async () => {
        const instance = await boot(SCOPE, memoryArtifacts().store, recorder(true));
        const put = await raw(CURRENT_CLAIM, 0, 'a\n')(instance);
        const done = await putManifest(instance, CURRENT_CLAIM, { stream: 'transcript-raw' });
        expect(put.statusCode).toBe(200);
        expect(done.statusCode).toBe(200);
    });

    it('a refused or conflicting put is not read', async () => {
        const ingest = recorder();
        const instance = await boot(SCOPE, memoryArtifacts().store, ingest);
        await raw(CURRENT_CLAIM, 0, 'a\n')(instance);
        ingest.calls.length = 0;
        const conflict = await raw(CURRENT_CLAIM, 0, 'different\n')(instance);
        expect(conflict.statusCode).toBe(409);
        expect(ingest.calls).toEqual([]);
    });
});
