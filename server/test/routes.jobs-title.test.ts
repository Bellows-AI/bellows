import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { trackApps } from './helpers-http.js';
import { jobStoreSlice, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

/** the create body's optional `title` (BEL-252): normalized like a rename, origin `user`, part of the idempotency fingerprint. */
const track = trackApps();

interface Created {
    title: string | null | undefined;
    fingerprint: string | undefined;
}

async function boot() {
    const created: Created[] = [];
    const jobs = jobStoreSlice<JobStore>({
        create: async (
            _command: string,
            _by: string | null,
            target?: { title?: string | null; idempotency?: { fingerprint: string } }
        ) => {
            created.push({ title: target?.title, fingerprint: target?.idempotency?.fingerprint });
            return { id: '11111111-1111-4111-8111-111111111111' };
        },
    });
    const config = testConfig();
    const instance: FastifyInstance = await buildApp({
        config,
        orgs: staticRegistry({
            config,
            jobs,
            telemetry: stubTelemetryClient(),
            repos: staticRepoSource([{ owner: 'acme', name: 'web' }]),
        }),
    });
    track(instance);
    return { instance, created };
}

const post = (instance: FastifyInstance, extra: Record<string, unknown>, headers: Record<string, string> = {}) =>
    instance.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { repo: 'acme/web', command: 'echo hi', ...extra } as object,
        headers,
    });

describe('POST /api/jobs title', () => {
    it.each([
        ['blank', '  '],
        ['oversized', 'x'.repeat(121)],
        ['a control character', 'a\u0007b'],
        ['a number', 3],
    ])('refuses a %s title as BAD_TITLE and queues nothing', async (_label, title) => {
        const { instance, created } = await boot();
        const response = await post(instance, { title });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_TITLE');
        expect(created).toEqual([]);
    });

    it('passes a normalized title to the store', async () => {
        const { instance, created } = await boot();
        expect((await post(instance, { title: '  Fix   the login ' })).statusCode).toBe(201);
        expect(created[0]!.title).toBe('Fix the login');
    });

    it.each([
        ['omitted', {}],
        ['null', { title: null }],
    ])('creates without a title when it is %s', async (_l, extra) => {
        const { instance, created } = await boot();
        expect((await post(instance, extra)).statusCode).toBe(201);
        expect(created[0]!.title ?? null).toBeNull();
    });

    it('puts the title in the idempotency fingerprint', async () => {
        const { instance, created } = await boot();
        const headers = { 'idempotency-key': 'title-key-0001' };
        await post(instance, { title: 'One' }, headers);
        await post(instance, { title: 'Two' }, headers);
        await post(instance, { title: 'One' }, headers);
        expect(created[0]!.fingerprint).toBeDefined();
        expect(created[1]!.fingerprint).not.toBe(created[0]!.fingerprint);
        expect(created[2]!.fingerprint).toBe(created[0]!.fingerprint);
    });
});
