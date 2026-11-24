import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ArtifactStore, StreamSummary } from '../src/artifacts/artifact-store.js';
import type { StreamRef } from '../src/artifacts/keys.js';
import type { JobReadStore } from '../src/db/jobs/job-store-reads.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import type { RestoreScope, RestoreScopeResult } from '../src/db/restore-types.js';
import { trackApps } from './helpers-http.js';
import { staticRegistry, testConfig } from './helpers.js';

/** `POST /api/jobs/:id/gate-log`: one gate run's whole output, by execution id, from the caller's own thread. */
const track = trackApps();

const JOB = '11111111-1111-4111-8111-111111111111';
const FOLLOW = '44444444-4444-4444-8444-444444444444';
const FOREIGN = '55555555-5555-4555-8555-555555555555';
const ROOT = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const LEASE = '66666666-6666-4666-8666-666666666666';
const RUN = '77777777-7777-4777-8777-777777777777';
const OTHER_RUN = '88888888-8888-4888-8888-888888888888';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text);

const SCOPE: RestoreScope = {
    root: ROOT,
    checkpoint: null,
    jobs: [
        { id: JOB, member: MEMBER, claimSeq: 2 },
        { id: FOLLOW, member: null, claimSeq: 1 },
    ],
};

interface Held {
    ref: StreamRef;
    chunks: string[];
    terminalCause?: string;
}
const held = (job: string, stream: string, chunks: string[], terminalCause?: string): Held => ({
    ref: { member: MEMBER, root: ROOT, job, claimSeq: 1, executor: 'claude-code', session: 'none', stream },
    chunks,
    ...(terminalCause ? { terminalCause } : {}),
});

/** An index over `streams`, each chunk at the byte offset its predecessors end at. */
function memoryArtifacts(streams: Held[], gone = false): ArtifactStore {
    const offsets = (h: Held) => {
        let at = 0;
        return h.chunks.map((text) => {
            const body = bytes(text);
            const chunk = { offset: at, body };
            at += body.length;
            return chunk;
        });
    };
    const find = (r: StreamRef) => streams.find((h) => JSON.stringify(h.ref) === JSON.stringify(r));
    return {
        async streamsOfJob(job: string): Promise<StreamSummary[]> {
            return streams
                .filter((h) => h.ref.job === job)
                .map((h) => ({ ...h.ref, chunks: h.chunks.length, bytes: 0, manifest: null }));
        },
        async listChunks(r: StreamRef) {
            return offsets(find(r)!).map((c) => ({ offset: c.offset, length: c.body.length, sha256: sha(c.body) }));
        },
        async readChunk(r: StreamRef, offset: number) {
            const c = offsets(find(r)!).find((x) => x.offset === offset)!;
            return gone ? null : { offset, length: c.body.length, sha256: sha(c.body), body: c.body };
        },
        async readManifest(r: StreamRef) {
            const cause = find(r)?.terminalCause ?? null;
            return { terminalCause: cause } as never;
        },
    } as unknown as ArtifactStore;
}

function boot(artifacts?: ArtifactStore) {
    const answer = (id: string, lease: string): RestoreScopeResult =>
        id === JOB && lease === LEASE ? { result: 'ok', scope: SCOPE } : { result: id === JOB ? 'lost' : 'missing' };
    const jobs = {
        restoreScope: async (id: string, lease: string) => answer(id, lease),
    } satisfies Partial<JobReadStore>;
    const config = testConfig();
    return buildApp({ config, orgs: staticRegistry({ config, jobs: jobs as unknown as JobStore, artifacts }) }).then(
        (app) => {
            track(app);
            return app;
        }
    );
}

const post = (app: FastifyInstance, payload: Record<string, unknown>, id = JOB) =>
    app.inject({ method: 'POST', url: `/api/jobs/${id}/gate-log`, payload });

const STREAMS = [
    held(FOLLOW, `gate-test-${RUN}`, ['FAIL a.test.ts\n', 'Tests  1 failed\n']),
    held(JOB, `gate-lint-${OTHER_RUN}`, ['lint output']),
    held(JOB, 'transcript', ['not a gate log']),
];

describe('POST /api/jobs/:id/gate-log', () => {
    it('answers the whole output of a run of the thread, found by its execution id', async () => {
        const app = await boot(memoryArtifacts(STREAMS));
        const response = await post(app, { leaseToken: LEASE, executionId: RUN });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ text: 'FAIL a.test.ts\nTests  1 failed\n', truncated: false });
    });

    it('says the head was cut when the driver kept a tail', async () => {
        const app = await boot(memoryArtifacts([held(JOB, `gate-test-${RUN}`, ['tail'], 'head_dropped')]));
        const response = await post(app, { leaseToken: LEASE, executionId: RUN });
        expect(response.json()).toEqual({ text: 'tail', truncated: true });
    });

    it('answers 404 for a run with no stream, and when the store lost its chunks', async () => {
        const app = await boot(memoryArtifacts(STREAMS));
        const unknown = await post(app, { leaseToken: LEASE, executionId: '99999999-9999-4999-8999-999999999999' });
        expect(unknown.statusCode).toBe(404);
        const lost = await boot(memoryArtifacts(STREAMS, true));
        expect((await post(lost, { leaseToken: LEASE, executionId: RUN })).statusCode).toBe(404);
    });

    it('refuses a missing or malformed execution id', async () => {
        const app = await boot(memoryArtifacts(STREAMS));
        expect((await post(app, { leaseToken: LEASE })).statusCode).toBe(400);
        expect((await post(app, { leaseToken: LEASE, executionId: 'a/../b' })).statusCode).toBe(400);
    });

    it('refuses a lease the row no longer holds, an unknown job, and an org with no store', async () => {
        const app = await boot(memoryArtifacts(STREAMS));
        const lost = await post(app, { leaseToken: '77777777-7777-4777-8777-777777777778', executionId: RUN });
        expect(lost.statusCode).toBe(409);
        expect(lost.json().code).toBe(ERROR_CODES.LEASE_LOST);
        expect((await post(app, { leaseToken: LEASE, executionId: RUN }, FOREIGN)).statusCode).toBe(404);
        expect((await post(await boot(), { leaseToken: LEASE, executionId: RUN })).statusCode).toBe(503);
    });
});
