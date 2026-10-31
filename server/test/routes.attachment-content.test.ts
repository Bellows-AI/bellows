import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { createAttachmentStore } from '../src/attachments/attachment-store.js';
import type { ClaimAttachment } from '../src/db/jobs/job-store-attachments.js';
import type { AttachmentSetResult } from '../src/db/jobs/job-store-reads.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import type { OrgRegistry } from '../src/orgs.js';
import { memoryAttachmentRows, textBytes } from './helpers-attachments.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, testConfig } from './helpers.js';
import {
    HTTP_CONFLICT,
    HTTP_NOT_FOUND,
    HTTP_OK,
    HTTP_UNAUTHORIZED,
    HTTP_UNAVAILABLE,
    trackApps,
} from './helpers-http.js';

/**
 * Offline: the worker's content route. The lease is the credential, and the set the lease's job carries is the access
 * check; the job store is a stub answering that set, the attachment store is the real logic over an in-memory row
 * double and a filesystem object store.
 */
const track = trackApps();

const JOB = '11111111-1111-4111-8111-111111111111';
const REVIEW = '22222222-2222-4222-8222-222222222222';
const LEASE = '33333333-3333-4333-8333-333333333333';
const REVIEW_LEASE = '44444444-4444-4444-8444-444444444444';
const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;

async function boot(options: { objects?: (base: ObjectStore) => Partial<ObjectStore>; auth?: boolean } = {}) {
    const rows = memoryAttachmentRows();
    const base = createFilesystemStore(await mkdtemp(join(tmpdir(), 'attachment-content-')));
    const store = createAttachmentStore({
        rows,
        objects: { ...base, ...options.objects?.(base) },
        orgId: 'test-org',
        prefix: '',
    });
    /** A stored, bound file: uploaded through the real store, then bound the way the job store binds it. */
    const bound = async (name: string, text: string): Promise<ClaimAttachment & { state: 'bound' }> => {
        const { meta } = await store.upload({
            uploaderId: 'u',
            name,
            mediaType: 'text/plain',
            bytes: textBytes(text),
        });
        rows.all.find((r) => r.id === meta.id)!.state = 'bound';
        return {
            id: meta.id,
            name,
            mediaType: 'text/plain',
            size: meta.size,
            sha256: meta.sha256,
            originJobId: JOB,
            state: 'bound',
        };
    };
    const sets = new Map<string, { lease: string; files: ClaimAttachment[] }>();
    const failing = { read: false };
    const jobs = {
        async attachmentSet(id: string, lease: string): Promise<AttachmentSetResult> {
            if (failing.read) throw new Error('the set could not be read');
            const held = sets.get(id);
            if (!held) return { result: 'missing' };
            return held.lease === lease ? { result: 'ok', attachments: held.files } : { result: 'lost' };
        },
    } as unknown as JobStore;
    const auth = options.auth ? memoryAuthStore() : null;
    const config = testConfig(auth ? { auth: githubAuth() } : {});
    const registry = staticRegistry({ config, jobs });
    const orgs: OrgRegistry = {
        ...registry,
        for: async (orgId) => {
            const runtime = await registry.for(orgId);
            return runtime && { ...runtime, attachments: store };
        },
    };
    const app = await buildApp({ config, orgs, ...(auth ? { auth } : {}) });
    track(app);
    return { app, auth, bound, sets, failing, rows };
}

const read = (app: FastifyInstance, attachmentId: string, over: { job?: string; lease?: string } = {}) =>
    app.inject({
        method: 'POST',
        url: `/api/jobs/${over.job ?? JOB}/attachments/${attachmentId}/content`,
        payload: { leaseToken: over.lease ?? LEASE },
    });

describe('POST /api/jobs/:id/attachments/:attachmentId/content', () => {
    it('serves the bytes and their sha256 to a live lease whose set holds the file', async () => {
        const { app, bound, sets } = await boot();
        const file = await bound('a.txt', 'hello');
        sets.set(JOB, { lease: LEASE, files: [file] });

        const response = await read(app, file.id);

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.rawPayload.toString()).toBe('hello');
        expect(response.headers['x-content-sha256']).toBe(file.sha256);
    });

    it.each([
        ['a stale lease', LEASE.replace('3', '9')],
        ['another job’s lease', REVIEW_LEASE],
    ])('answers 409 lease-lost for %s', async (_name, lease) => {
        const { app, bound, sets } = await boot();
        const file = await bound('a.txt', 'hello');
        sets.set(JOB, { lease: LEASE, files: [file] });

        const response = await read(app, file.id, { lease });

        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe(ERROR_CODES.LEASE_LOST);
    });

    it('answers 404 for a file of another thread in the same organization', async () => {
        const { app, bound, sets } = await boot();
        const mine = await bound('mine.txt', 'a');
        const theirs = await bound('theirs.txt', 'b');
        sets.set(JOB, { lease: LEASE, files: [mine] });

        const response = await read(app, theirs.id);

        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
        expect(response.json().code).toBe(ERROR_CODES.ATTACHMENT_NOT_FOUND);
    });

    it('answers 404 for a job the organization does not hold', async () => {
        const { app, bound } = await boot();
        const file = await bound('a.txt', 'hello');

        const response = await read(app, file.id);

        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('answers 404 once the thread is removed and the set no longer names the file', async () => {
        const { app, bound, sets } = await boot();
        const file = await bound('a.txt', 'hello');
        sets.set(JOB, { lease: LEASE, files: [] });

        expect((await read(app, file.id)).statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('answers 503, never an empty verdict, when the set cannot be read', async () => {
        const { app, bound, sets, failing } = await boot();
        const file = await bound('a.txt', 'hello');
        sets.set(JOB, { lease: LEASE, files: [file] });
        failing.read = true;

        expect((await read(app, file.id)).statusCode).toBe(HTTP_UNAVAILABLE);
    });

    it('answers 410 when the store definitively no longer holds a bound file', async () => {
        let missing = false;
        const { app, bound, sets } = await boot({
            objects: (base) => ({ get: async (key) => (missing ? null : base.get(key)) }),
        });
        const file = await bound('a.txt', 'hello');
        sets.set(JOB, { lease: LEASE, files: [file] });
        missing = true;

        const response = await read(app, file.id);

        expect(response.statusCode).toBe(HTTP_GONE);
        expect(response.json().code).toBe(ERROR_CODES.ATTACHMENT_GONE);
    });

    it('answers 503 when the object store throws', async () => {
        let broken = false;
        const { app, bound, sets } = await boot({
            objects: (base) => ({
                get: async (key) => {
                    if (broken) throw new Error('store down');
                    return base.get(key);
                },
            }),
        });
        const file = await bound('a.txt', 'hello');
        sets.set(JOB, { lease: LEASE, files: [file] });
        broken = true;

        expect((await read(app, file.id)).statusCode).toBe(HTTP_UNAVAILABLE);
    });

    it('answers 422 when the stored bytes fail the recorded sha256', async () => {
        let tampered = false;
        const { app, bound, sets } = await boot({
            objects: (base) => ({ get: async (key) => (tampered ? textBytes('other') : base.get(key)) }),
        });
        const file = await bound('a.txt', 'hello');
        sets.set(JOB, { lease: LEASE, files: [file] });
        tampered = true;

        const response = await read(app, file.id);

        expect(response.statusCode).toBe(HTTP_UNPROCESSABLE);
        expect(response.json().code).toBe(ERROR_CODES.ARTIFACT_CORRUPT);
    });

    it('serves a review the reviewed job’s files under the review row’s own lease', async () => {
        const { app, bound, sets } = await boot();
        const inherited = await bound('inherited.txt', 'seen');
        const newer = await bound('newer.txt', 'later');
        sets.set(JOB, { lease: LEASE, files: [inherited, newer] });
        sets.set(REVIEW, { lease: REVIEW_LEASE, files: [inherited] });

        const ok = await read(app, inherited.id, { job: REVIEW, lease: REVIEW_LEASE });
        const tooNew = await read(app, newer.id, { job: REVIEW, lease: REVIEW_LEASE });
        const callerLease = await read(app, inherited.id, { job: REVIEW, lease: LEASE });

        expect(ok.statusCode).toBe(HTTP_OK);
        expect(ok.rawPayload.toString()).toBe('seen');
        expect(tooNew.statusCode).toBe(HTTP_NOT_FOUND);
        expect(callerLease.statusCode).toBe(HTTP_CONFLICT);
    });

    it('is a worker route: a signed-in member’s cookie is refused', async () => {
        const { app, auth, bound, sets } = await boot({ auth: true });
        const file = await bound('a.txt', 'hello');
        sets.set(JOB, { lease: LEASE, files: [file] });
        const cookie = await signedIn(auth!, auth!.seedMember('test-org', 'octocat'));

        const response = await app.inject({
            method: 'POST',
            url: `/api/jobs/${JOB}/attachments/${file.id}/content`,
            headers: { cookie },
            payload: { leaseToken: LEASE },
        });

        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});
