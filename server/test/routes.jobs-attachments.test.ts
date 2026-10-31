import type { AttachmentMeta } from '@factory-ai/core';
import { MAX_FILES_PER_REQUEST } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AttachmentRefusedError } from '../src/db/jobs/job-store-attachments.js';
import type { JobActionStore } from '../src/db/jobs/job-store-actions.js';
import type { JobReadStore } from '../src/db/jobs/job-store-reads.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import { githubAuth, jobStoreSlice, memoryAuthStore, signedIn, staticRegistry, testConfig } from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CREATED,
    HTTP_FORBIDDEN,
    HTTP_OK,
    HTTP_PAYLOAD_TOO_LARGE,
    trackApps,
} from './helpers-http.js';

/**
 * Offline: how the job routes carry a task's `attachments` — the create and follow-up fields, the
 * idempotency fingerprint and the thread read. Who may bind which file is the store's
 * (server/test-db/job-store.attachments.test.ts).
 */

const track = trackApps();
const ID = '11111111-1111-4111-8111-111111111111';
const FILE_A = '22222222-2222-4222-8222-222222222222';
const FILE_B = '33333333-3333-4333-8333-333333333333';

type CreateTarget = { attachmentIds?: string[]; idempotency?: { fingerprint: string } | undefined };

async function boot(overrides: Record<string, unknown> = {}) {
    const auth = memoryAuthStore();
    const member = auth.seedMember('test-org', 'octocat');
    const creates: CreateTarget[] = [];
    const followUps: { attachmentIds: string[] | undefined }[] = [];
    const jobs = jobStoreSlice<JobActionStore & JobReadStore>({
        async create(_command: string, _by: string | null, target: CreateTarget) {
            creates.push(target);
            return { id: crypto.randomUUID() };
        },
        async createFollowUp(...args: unknown[]) {
            followUps.push({ attachmentIds: args[5] as string[] | undefined });
            return { id: crypto.randomUUID() };
        },
        ...overrides,
    });
    const config = testConfig({ auth: githubAuth() });
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, repos: staticRepoSource([{ owner: 'acme', name: 'web' }]), jobs }),
        auth,
    });
    track(app);
    return { instance: app, creates, followUps, cookie: await signedIn(auth, member) };
}

type Booted = Awaited<ReturnType<typeof boot>>;

const create = (b: Booted, extra: Record<string, unknown>, key?: string) =>
    b.instance.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { cookie: b.cookie, ...(key ? { 'idempotency-key': key } : {}) },
        payload: { repo: 'acme/web', command: 'look at the shot', ...extra },
    });

const followUp = (b: Booted, extra: Record<string, unknown>) =>
    b.instance.inject({
        method: 'POST',
        url: `/api/jobs/${ID}/follow-up`,
        headers: { cookie: b.cookie },
        payload: { command: 'again', ...extra },
    });

const manyIds = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());

describe('POST /api/jobs attachments', () => {
    it('hands the store the ids, or an empty list when none is named', async () => {
        const b = await boot();
        expect((await create(b, { attachments: [FILE_A, FILE_B] })).statusCode).toBe(HTTP_CREATED);
        expect((await create(b, {})).statusCode).toBe(HTTP_CREATED);
        expect(b.creates.map((c) => c.attachmentIds)).toEqual([[FILE_A, FILE_B], []]);
    });

    it.each([
        ['a string', FILE_A],
        ['an object', { id: FILE_A }],
        ['a non-uuid member', ['not-a-uuid']],
        ['a non-string member', [7]],
        ['more than the request limit', manyIds(MAX_FILES_PER_REQUEST + 1)],
        ['a repeated id', [FILE_A, FILE_A]],
    ])('refuses %s with BAD_ATTACHMENT and creates nothing', async (_name, attachments) => {
        const b = await boot();
        const res = await create(b, { attachments });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json()).toMatchObject({ code: 'BAD_ATTACHMENT' });
        expect(b.creates).toEqual([]);
    });

    it.each([
        ['not-authorized', HTTP_FORBIDDEN, 'ATTACHMENT_NOT_AUTHORIZED'],
        ['too-large', HTTP_PAYLOAD_TOO_LARGE, 'ATTACHMENT_TOO_LARGE'],
        ['too-many', HTTP_BAD_REQUEST, 'BAD_ATTACHMENT'],
        ['duplicate', HTTP_BAD_REQUEST, 'BAD_ATTACHMENT'],
    ] as const)('answers a store refusal %s as %i %s', async (reason, status, code) => {
        const b = await boot({
            async create() {
                throw new AttachmentRefusedError(reason);
            },
        });
        const res = await create(b, { attachments: [FILE_A] });
        expect(res.statusCode).toBe(status);
        expect(res.json()).toMatchObject({ code });
    });

    it('fingerprints the attachments, in order, for the idempotency key', async () => {
        const b = await boot();
        const key = 'attachments-key-1';
        await create(b, { attachments: [FILE_A, FILE_B] }, key);
        await create(b, { attachments: [FILE_B, FILE_A] }, key);
        await create(b, { attachments: [FILE_A, FILE_B] }, key);
        const prints = b.creates.map((c) => c.idempotency?.fingerprint);
        expect(prints[0]).toBe(prints[2]);
        expect(prints[0]).not.toBe(prints[1]);
    });
});

describe('POST /api/jobs/:id/follow-up attachments', () => {
    it('passes the ids and refuses a malformed list', async () => {
        const b = await boot();
        expect((await followUp(b, { attachments: [FILE_A] })).statusCode).toBe(HTTP_CREATED);
        expect((await followUp(b, {})).statusCode).toBe(HTTP_CREATED);
        expect(b.followUps.map((f) => f.attachmentIds ?? [])).toEqual([[FILE_A], []]);
        const bad = await followUp(b, { attachments: 'nope' });
        expect(bad.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(bad.json()).toMatchObject({ code: 'BAD_ATTACHMENT' });
    });

    it('answers a store refusal as 403 ATTACHMENT_NOT_AUTHORIZED', async () => {
        const b = await boot({
            async createFollowUp() {
                throw new AttachmentRefusedError('not-authorized');
            },
        });
        const res = await followUp(b, { attachments: [FILE_A] });
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json()).toMatchObject({ code: 'ATTACHMENT_NOT_AUTHORIZED' });
    });
});

describe('GET /api/jobs/:id/thread attachments', () => {
    it('serves each row with the files the store attached to it', async () => {
        const meta: AttachmentMeta = {
            id: FILE_A,
            name: 'shot.png',
            mediaType: 'image/png',
            size: 10,
            sha256: 'abc',
            state: 'bound',
        };
        const b = await boot({
            async thread() {
                return [
                    { id: ID, attachments: [meta] },
                    { id: FILE_B, attachments: [] },
                ];
            },
        });
        const res = await b.instance.inject({
            method: 'GET',
            url: `/api/jobs/${ID}/thread`,
            headers: { cookie: b.cookie },
        });
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.json().jobs.map((j: { attachments: AttachmentMeta[] }) => j.attachments)).toEqual([[meta], []]);
    });
});
