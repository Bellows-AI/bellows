import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ArtifactIntegrityError, type ArtifactStore, type StreamSummary } from '../src/artifacts/artifact-store.js';
import type { StreamRef } from '../src/artifacts/keys.js';
import type { JobStore } from '../src/db/job-store-types.js';
import type { CheckpointPointer, RestoreScope, RestoreScopeResult } from '../src/db/restore-types.js';
import { trackApps } from './helpers-http.js';
import { staticRegistry, testConfig } from './helpers.js';

/** Issue #775, slice 3: the restore reads — a live lease sees its own thread's checkpoint and raw transcripts. */
const track = trackApps();

const JOB = '11111111-1111-4111-8111-111111111111';
const FOLLOW = '44444444-4444-4444-8444-444444444444';
const FOREIGN = '55555555-5555-4555-8555-555555555555';
const ROOT = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const LEASE = '66666666-6666-4666-8666-666666666666';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const POINTER: CheckpointPointer = {
    jobId: JOB,
    claimSeq: 2,
    executor: 'claude-code',
    session: 'sess-a',
    truncated: false,
    cause: null,
    finalizedAt: new Date('2026-01-01T00:05:00Z'),
};
const SCOPE: RestoreScope = {
    root: ROOT,
    checkpoint: POINTER,
    jobs: [
        { id: JOB, member: MEMBER, claimSeq: 2 },
        { id: FOLLOW, member: null, claimSeq: 1 },
    ],
};

interface Held {
    ref: StreamRef;
    chunks: { offset: number; body: Uint8Array }[];
}
const ref = (over: Partial<StreamRef>): StreamRef => ({
    member: MEMBER,
    root: ROOT,
    job: JOB,
    claimSeq: 2,
    executor: 'claude-code',
    session: 'sess-a',
    stream: 'checkpoint',
    ...over,
});
const bytes = (text: string) => new TextEncoder().encode(text);

/** An index holding `held`, recording which jobs' streams the route listed. */
function memoryArtifacts(held: Held[]) {
    const listed: string[] = [];
    const same = (a: StreamRef, b: StreamRef) => JSON.stringify(a) === JSON.stringify(b);
    const store = {
        async streamsOfJob(job: string): Promise<StreamSummary[]> {
            listed.push(job);
            return held
                .filter((h) => h.ref.job === job)
                .map((h) => ({
                    ...h.ref,
                    chunks: h.chunks.length,
                    bytes: h.chunks.reduce((n, c) => n + c.body.length, 0),
                    manifest: null,
                }));
        },
        async listChunks(r: StreamRef) {
            const found = held.find((h) => same(h.ref, r));
            return (found?.chunks ?? []).map((c) => ({ offset: c.offset, length: c.body.length, sha256: sha(c.body) }));
        },
        async readChunk(r: StreamRef, offset: number) {
            const c = held.find((h) => same(h.ref, r))?.chunks.find((x) => x.offset === offset);
            return c ? { offset, length: c.body.length, sha256: sha(c.body), body: c.body } : null;
        },
    } as unknown as ArtifactStore;
    return { store, listed };
}

function boot(answer: (id: string, lease: string) => RestoreScopeResult, artifacts?: ArtifactStore) {
    const jobs = new Proxy(
        { restoreScope: async (id: string, lease: string) => answer(id, lease) },
        {
            get(target, name) {
                if (name in target) return target[name as keyof typeof target];
                if (name === 'then') return;
                return () => {
                    throw new Error(`a restore read must not call JobStore.${String(name)}`);
                };
            },
        }
    ) as unknown as JobStore;
    const config = testConfig();
    return buildApp({ config, orgs: staticRegistry({ config, jobs, artifacts }) }).then((app) => {
        track(app);
        return app;
    });
}

const live =
    (scope: RestoreScope = SCOPE) =>
    (id: string, lease: string): RestoreScopeResult =>
        id === JOB && lease === LEASE ? { result: 'ok', scope } : { result: id === JOB ? 'lost' : 'missing' };

const post = (app: FastifyInstance, path: string, payload: Record<string, unknown>, id = JOB) =>
    app.inject({ method: 'POST', url: `/api/jobs/${id}/${path}`, payload });

const HELD: Held[] = [
    {
        ref: ref({}),
        chunks: [
            { offset: 0, body: bytes('header\n') },
            { offset: 7, body: bytes('BUNDLE') },
        ],
    },
    { ref: ref({ stream: 'transcript-raw' }), chunks: [{ offset: 0, body: bytes('{"a":1}\n') }] },
    { ref: ref({ stream: 'transcript' }), chunks: [{ offset: 0, body: bytes('normalized') }] },
    {
        ref: ref({ stream: 'transcript-raw', executor: 'opencode', session: 'oc' }),
        chunks: [{ offset: 0, body: bytes('x') }],
    },
    {
        ref: ref({ job: FOLLOW, member: 'unattributed', claimSeq: 1, session: 'sess-b', stream: 'transcript-raw' }),
        chunks: [{ offset: 0, body: bytes('{"b":2}\n') }],
    },
    {
        ref: ref({ job: FOREIGN, root: FOREIGN, stream: 'transcript-raw' }),
        chunks: [{ offset: 0, body: bytes('secret') }],
    },
];

describe.each(['checkpoint', 'checkpoint/chunk', 'transcripts', 'transcripts/chunk'])(
    'POST /api/jobs/:id/%s',
    (path) => {
        const body = {
            leaseToken: LEASE,
            offset: 0,
            jobId: JOB,
            claimSeq: 2,
            executor: 'claude-code',
            session: 'sess-a',
        };

        it('refuses a lease the row no longer holds with LEASE_LOST', async () => {
            const app = await boot(live(), memoryArtifacts(HELD).store);
            const response = await post(app, path, { ...body, leaseToken: '77777777-7777-4777-8777-777777777777' });
            expect(response.statusCode).toBe(409);
            expect(response.json().code).toBe(ERROR_CODES.LEASE_LOST);
        });

        it('answers 404 for an unknown job and 400 for a malformed lease token', async () => {
            const app = await boot(live(), memoryArtifacts(HELD).store);
            expect((await post(app, path, body, FOREIGN)).statusCode).toBe(404);
            const malformed = await post(app, path, { ...body, leaseToken: 'nope' });
            expect(malformed.statusCode).toBe(400);
            expect(malformed.json().code).toBe(ERROR_CODES.BAD_TOKEN);
        });

        it('answers 503 when the org has no artifact store', async () => {
            const app = await boot(live());
            expect((await post(app, path, body)).statusCode).toBe(503);
        });
    }
);

describe('POST /api/jobs/:id/checkpoint', () => {
    it('answers an explicit none when the thread has no pointer', async () => {
        const fake = memoryArtifacts(HELD);
        const app = await boot(live({ ...SCOPE, checkpoint: null }), fake.store);
        const response = await post(app, 'checkpoint', { leaseToken: LEASE });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ state: 'none' });
        expect(fake.listed).toEqual([]);
    });

    it('describes the pointed stream: identity, truncation, and every chunk with its sha256', async () => {
        const fake = memoryArtifacts(HELD);
        const app = await boot(live(), fake.store);
        const response = await post(app, 'checkpoint', { leaseToken: LEASE });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            state: 'found',
            checkpoint: {
                jobId: JOB,
                claimSeq: 2,
                executor: 'claude-code',
                session: 'sess-a',
                truncated: false,
                cause: null,
                finalizedAt: '2026-01-01T00:05:00.000Z',
                bytes: 13,
                chunks: [
                    { offset: 0, length: 7, sha256: sha(bytes('header\n')) },
                    { offset: 7, length: 6, sha256: sha(bytes('BUNDLE')) },
                ],
            },
        });
        expect(fake.listed).toEqual([JOB]);
    });

    it('answers gone, apart from none, when the pointed stream is no longer in the index', async () => {
        const app = await boot(live(), memoryArtifacts([]).store);
        const response = await post(app, 'checkpoint', { leaseToken: LEASE });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ state: 'gone' });
    });
});

describe('POST /api/jobs/:id/checkpoint/chunk', () => {
    it('serves one chunk of the pointed stream as bytes with its sha256', async () => {
        const app = await boot(live(), memoryArtifacts(HELD).store);
        const response = await post(app, 'checkpoint/chunk', { leaseToken: LEASE, offset: 7 });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('application/octet-stream');
        expect(response.headers['x-chunk-sha256']).toBe(sha(bytes('BUNDLE')));
        expect(response.rawPayload.toString()).toBe('BUNDLE');
    });

    it('answers 404 for an offset that is not a chunk, and for a thread with no pointer', async () => {
        const app = await boot(live(), memoryArtifacts(HELD).store);
        expect((await post(app, 'checkpoint/chunk', { leaseToken: LEASE, offset: 3 })).statusCode).toBe(404);
        const none = await boot(live({ ...SCOPE, checkpoint: null }), memoryArtifacts(HELD).store);
        expect((await post(none, 'checkpoint/chunk', { leaseToken: LEASE, offset: 0 })).statusCode).toBe(404);
    });

    it('answers 422 ARTIFACT_CORRUPT for a chunk whose stored bytes fail their sha256: not a store outage', async () => {
        const fake = memoryArtifacts(HELD).store;
        const corrupt = Object.assign(Object.create(fake), {
            readChunk: async () => {
                throw new ArtifactIntegrityError('the chunk does not match its recorded sha256');
            },
        }) as ArtifactStore;
        const app = await boot(live(), corrupt);
        const response = await post(app, 'checkpoint/chunk', { leaseToken: LEASE, offset: 7 });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ code: ERROR_CODES.ARTIFACT_CORRUPT });
    });

    it('answers 400 for a missing or malformed offset', async () => {
        const app = await boot(live(), memoryArtifacts(HELD).store);
        expect((await post(app, 'checkpoint/chunk', { leaseToken: LEASE })).statusCode).toBe(400);
        expect((await post(app, 'checkpoint/chunk', { leaseToken: LEASE, offset: -1 })).statusCode).toBe(400);
    });
});

describe('POST /api/jobs/:id/transcripts', () => {
    it('lists the raw Claude transcripts of every row of the thread, and nothing else', async () => {
        const fake = memoryArtifacts(HELD);
        const app = await boot(live(), fake.store);
        const response = await post(app, 'transcripts', { leaseToken: LEASE });
        expect(response.statusCode).toBe(200);
        expect(response.json().streams).toEqual([
            {
                jobId: JOB,
                claimSeq: 2,
                executor: 'claude-code',
                session: 'sess-a',
                bytes: 8,
                chunks: [{ offset: 0, length: 8, sha256: sha(bytes('{"a":1}\n')) }],
            },
            {
                jobId: FOLLOW,
                claimSeq: 1,
                executor: 'claude-code',
                session: 'sess-b',
                bytes: 8,
                chunks: [{ offset: 0, length: 8, sha256: sha(bytes('{"b":2}\n')) }],
            },
        ]);
        expect(fake.listed.sort()).toEqual([FOLLOW, JOB].sort());
    });
});

describe('POST /api/jobs/:id/transcripts/chunk', () => {
    const coords = {
        leaseToken: LEASE,
        jobId: FOLLOW,
        claimSeq: 1,
        executor: 'claude-code',
        session: 'sess-b',
        offset: 0,
    };

    it('serves a chunk of a thread row, under the author that row is filed with', async () => {
        const app = await boot(live(), memoryArtifacts(HELD).store);
        const response = await post(app, 'transcripts/chunk', coords);
        expect(response.statusCode).toBe(200);
        expect(response.rawPayload.toString()).toBe('{"b":2}\n');
        expect(response.headers['x-chunk-sha256']).toBe(sha(bytes('{"b":2}\n')));
    });

    it('refuses a job outside the thread, even when the stream exists', async () => {
        const app = await boot(live(), memoryArtifacts(HELD).store);
        const response = await post(app, 'transcripts/chunk', {
            ...coords,
            jobId: FOREIGN,
            claimSeq: 2,
            session: 'sess-a',
        });
        expect(response.statusCode).toBe(404);
    });

    it('answers 400 for a malformed coordinate', async () => {
        const app = await boot(live(), memoryArtifacts(HELD).store);
        expect((await post(app, 'transcripts/chunk', { ...coords, jobId: 'x' })).statusCode).toBe(400);
        expect((await post(app, 'transcripts/chunk', { ...coords, claimSeq: 'one' })).statusCode).toBe(400);
        expect((await post(app, 'transcripts/chunk', { ...coords, session: 'a/b' })).statusCode).toBe(400);
    });
});
