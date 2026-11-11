import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { PinnedSkill } from '../src/db/jobs/job-store-skill-pin.js';
import type { SkillPinResult } from '../src/db/jobs/job-store-reads.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { SkillGoneError, SkillIntegrityError, SkillUnavailableError, type SkillStore } from '../src/db/skill-store.js';
import type { OrgRegistry } from '../src/orgs.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, testConfig } from './helpers.js';
import {
    HTTP_CONFLICT,
    HTTP_NOT_FOUND,
    HTTP_OK,
    HTTP_UNAUTHORIZED,
    HTTP_UNAVAILABLE,
    trackApps,
} from './helpers-http.js';
import { storeOutage } from './helpers-outage.js';

/**
 * Offline: the worker's read of a pinned skill bundle (BEL-273). The lease is the credential and the row's pin is the
 * access check; the job store is a stub answering that pin and the skill store a stub answering the bytes.
 */
const track = trackApps();

const JOB = '11111111-1111-4111-8111-111111111111';
const REVIEW = '22222222-2222-4222-8222-222222222222';
const LEASE = '33333333-3333-4333-8333-333333333333';
const REVIEW_LEASE = '44444444-4444-4444-8444-444444444444';
const PINNED_VERSION = '55555555-5555-4555-8555-555555555555';
const OTHER_VERSION = '66666666-6666-4666-8666-666666666666';
const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;
const SHA = 'a'.repeat(64);

const entry: PinnedSkill = { name: 'org-one', source: 'org', versionId: PINNED_VERSION, sha256: SHA };

type Reader = SkillStore['readVersion'];

async function boot(options: { reader?: Reader; noStore?: boolean; auth?: boolean } = {}) {
    const pins = new Map<string, { lease: string; pin: PinnedSkill[] }>([
        [JOB, { lease: LEASE, pin: [entry] }],
        [REVIEW, { lease: REVIEW_LEASE, pin: [] }],
    ]);
    const failing = { read: false };
    const asked: { versionId: string; access: unknown }[] = [];
    const jobs = {
        async skillPin(id: string, lease: string): Promise<SkillPinResult> {
            if (failing.read) throw storeOutage('the pin could not be read');
            const held = pins.get(id);
            if (!held) return { result: 'missing' };
            return held.lease === lease ? { result: 'ok', pin: held.pin } : { result: 'lost' };
        },
    } as unknown as JobStore;
    const reader: Reader =
        options.reader ??
        (async (versionId, access) => {
            asked.push({ versionId, access });
            return { sha256: SHA, body: new TextEncoder().encode('tar-bytes') };
        });
    const skills = { readVersion: reader } as unknown as SkillStore;
    const auth = options.auth ? memoryAuthStore() : null;
    const config = testConfig(auth ? { auth: githubAuth() } : {});
    const registry = staticRegistry({ config, jobs });
    const orgs: OrgRegistry = {
        ...registry,
        for: async (orgId) => {
            const runtime = await registry.for(orgId);
            return runtime && (options.noStore ? runtime : { ...runtime, skills });
        },
    };
    const app = await buildApp({ config, orgs, ...(auth ? { auth } : {}) });
    track(app);
    return { app, auth, pins, failing, asked };
}

const read = (app: FastifyInstance, versionId: string, over: { job?: string; lease?: string } = {}) =>
    app.inject({
        method: 'POST',
        url: `/api/jobs/${over.job ?? JOB}/skills/${versionId}/content`,
        payload: { leaseToken: over.lease ?? LEASE },
    });

describe('POST /api/jobs/:id/skills/:versionId/content', () => {
    it('serves the bundle bytes and their sha256 to a live lease whose pin holds the version', async () => {
        const { app } = await boot();

        const response = await read(app, PINNED_VERSION);

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.rawPayload.toString()).toBe('tar-bytes');
        expect(response.headers['x-content-sha256']).toBe(SHA);
    });

    it('reads the version for any owner: the pin, not the owner, is the access check', async () => {
        const { app, asked } = await boot();

        await read(app, PINNED_VERSION);

        expect(asked).toEqual([{ versionId: PINNED_VERSION, access: 'any' }]);
    });

    it.each([
        ['a stale lease', LEASE.replace('3', '9')],
        ['another job’s lease', REVIEW_LEASE],
    ])('answers 409 lease-lost for %s', async (_name, lease) => {
        const { app } = await boot();

        const response = await read(app, PINNED_VERSION, { lease });

        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe(ERROR_CODES.LEASE_LOST);
    });

    it('answers 400 for a lease token that is not a uuid', async () => {
        const { app } = await boot();

        expect((await read(app, PINNED_VERSION, { lease: 'nope' })).statusCode).toBe(400);
    });

    it('answers 404 for a version not in the row’s pin, without reading the store', async () => {
        const { app, asked } = await boot();

        const response = await read(app, OTHER_VERSION);

        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
        expect(response.json().code).toBe(ERROR_CODES.SKILL_NOT_FOUND);
        expect(asked).toEqual([]);
    });

    it('answers 404 for a version id that is not a uuid, and for a job the organization does not hold', async () => {
        const { app } = await boot();

        expect((await read(app, 'nope')).statusCode).toBe(HTTP_NOT_FOUND);
        expect((await read(app, PINNED_VERSION, { job: '77777777-7777-4777-8777-777777777777' })).statusCode).toBe(
            HTTP_NOT_FOUND
        );
    });

    it('serves a reviewer nothing: its pin is empty', async () => {
        const { app } = await boot();

        const response = await read(app, PINNED_VERSION, { job: REVIEW, lease: REVIEW_LEASE });

        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('answers 503, never an empty verdict, when the pin cannot be read', async () => {
        const { app, failing } = await boot();
        failing.read = true;

        expect((await read(app, PINNED_VERSION)).statusCode).toBe(HTTP_UNAVAILABLE);
    });

    it('answers 410, not 404, when the pinned version or its object is gone', async () => {
        const gone = await boot({ reader: async () => Promise.reject(new SkillGoneError()) });
        const absent = await boot({ reader: async () => null });

        for (const { app } of [gone, absent]) {
            const response = await read(app, PINNED_VERSION);
            expect(response.statusCode).toBe(HTTP_GONE);
            expect(response.json().code).toBe(ERROR_CODES.SKILL_GONE);
        }
    });

    it('answers 503 when the skill store or its object store is unreachable', async () => {
        const { app } = await boot({ reader: async () => Promise.reject(new SkillUnavailableError('get')) });

        expect((await read(app, PINNED_VERSION)).statusCode).toBe(HTTP_UNAVAILABLE);
    });

    it('answers 503 when this board has no skill store', async () => {
        const { app } = await boot({ noStore: true });

        expect((await read(app, PINNED_VERSION)).statusCode).toBe(HTTP_UNAVAILABLE);
    });

    it('answers 422 when the stored bytes fail the recorded sha256', async () => {
        const { app } = await boot({ reader: async () => Promise.reject(new SkillIntegrityError('differs')) });

        const response = await read(app, PINNED_VERSION);

        expect(response.statusCode).toBe(HTTP_UNPROCESSABLE);
        expect(response.json().code).toBe(ERROR_CODES.ARTIFACT_CORRUPT);
    });

    it('is a worker route: a signed-in member’s cookie is refused', async () => {
        const { app, auth } = await boot({ auth: true });
        const cookie = await signedIn(auth!, auth!.seedMember('test-org', 'octocat'));

        const response = await app.inject({
            method: 'POST',
            url: `/api/jobs/${JOB}/skills/${PINNED_VERSION}/content`,
            headers: { cookie },
            payload: { leaseToken: LEASE },
        });

        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});
