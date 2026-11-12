import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import type { RenameTaskResult } from '../src/db/jobs/job-store-title.js';
import { trackApps } from './helpers-http.js';
import { jobStoreSlice, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

/** `PUT /api/jobs/:id/title` — the user's rename: validated here, decided by the store. */
const track = trackApps();
const ID = '11111111-1111-4111-8111-111111111111';

interface Call {
    id: string;
    title: string;
    revision: number;
    admin: boolean | undefined;
}

async function boot(answer: RenameTaskResult) {
    const calls: Call[] = [];
    const jobs = jobStoreSlice<JobStore>({
        renameTask: async (id: string, rename: { title: string; revision: number; admin?: boolean }) => {
            calls.push({ id, title: rename.title, revision: rename.revision, admin: rename.admin });
            return answer;
        },
    });
    const config = testConfig();
    const instance: FastifyInstance = await buildApp({
        config,
        orgs: staticRegistry({ config, jobs, telemetry: stubTelemetryClient() }),
    });
    track(instance);
    return { instance, calls };
}

const put = (instance: FastifyInstance, payload: unknown, id = ID) =>
    instance.inject({ method: 'PUT', url: `/api/jobs/${id}/title`, payload: payload as object });

const OK: RenameTaskResult = { ok: true, title: 'Fix login', origin: 'user', revision: 2 };

describe('PUT /api/jobs/:id/title', () => {
    it('answers the stored title, origin and revision, normalizing what it stores', async () => {
        const { instance, calls } = await boot(OK);
        const response = await put(instance, { title: '  Fix \n login ', revision: 1 });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ title: 'Fix login', origin: 'user', revision: 2 });
        expect(calls).toEqual([{ id: ID, title: 'Fix login', revision: 1, admin: false }]);
    });

    it.each([
        ['blank', '   '],
        ['oversized', 'x'.repeat(121)],
        ['a control character', 'a\u0000b'],
        ['a bidi override', 'a‮b'],
        ['a number', 7],
        ['missing', undefined],
    ])('refuses %s as BAD_TITLE and writes nothing', async (_label, title) => {
        const { instance, calls } = await boot(OK);
        const response = await put(instance, { title, revision: 0 });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_TITLE');
        expect(calls).toEqual([]);
    });

    it.each([
        ['a string', '1'],
        ['negative', -1],
        ['fractional', 1.5],
        ['missing', undefined],
    ])('refuses a revision that is %s as BAD_BODY', async (_label, revision) => {
        const { instance, calls } = await boot(OK);
        const response = await put(instance, { title: 'ok', revision });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_BODY');
        expect(calls).toEqual([]);
    });

    it('answers 409 TITLE_STALE carrying the current title and revision', async () => {
        const { instance } = await boot({ ok: false, refusal: 'stale', title: 'Newer', origin: 'agent', revision: 5 });
        const response = await put(instance, { title: 'Mine', revision: 1 });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'TITLE_STALE', title: 'Newer', origin: 'agent', revision: 5 });
    });

    it('answers 404 for a missing task and 403 for a refused caller', async () => {
        const missing = await boot({ ok: false, refusal: 'missing' });
        expect((await put(missing.instance, { title: 'x', revision: 0 })).statusCode).toBe(404);
        const forbidden = await boot({ ok: false, refusal: 'forbidden' });
        const response = await put(forbidden.instance, { title: 'x', revision: 0 });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('FORBIDDEN');
    });

    it('refuses an id that is not a uuid without asking the store', async () => {
        const { instance, calls } = await boot(OK);
        expect((await put(instance, { title: 'x', revision: 0 }, 'not-a-uuid')).statusCode).toBe(400);
        expect(calls).toEqual([]);
    });

    it('honors the control body limit', async () => {
        const { instance, calls } = await boot(OK);
        const response = await put(instance, { title: 'x', revision: 0, padding: 'p'.repeat(5000) });
        expect(response.statusCode).toBe(413);
        expect(calls).toEqual([]);
    });
});
