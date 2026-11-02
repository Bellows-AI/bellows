import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import type { OrgRuntime } from '../src/orgs.js';
import { trackApps } from './helpers-http.js';
import { jobStoreSlice, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

/** the create body's `baseBranch` — shape-checked, then existence-checked when the board can read GitHub. */
const track = trackApps();
const TRACKED = { owner: 'acme', name: 'web' };
const DEADLINE_MS = 5_000;
const MAX_TICKS = 20;
const LONG_NAME = 'b'.repeat(256);

interface Created {
    baseBranch: string | null | undefined;
    idempotency: { fingerprint: string } | undefined;
}

async function boot(branchHead?: OrgRuntime['branchHead']) {
    const created: Created[] = [];
    const jobs = jobStoreSlice<JobStore>({
        create: async (
            _command: string,
            _by: string | null,
            target?: { baseBranch?: string | null; idempotency?: Created['idempotency'] }
        ) => {
            created.push({ baseBranch: target?.baseBranch, idempotency: target?.idempotency });
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
            repos: staticRepoSource([TRACKED]),
            ...(branchHead ? { branchHead } : {}),
        }),
    });
    track(instance);
    return { instance, created };
}

const post = (instance: FastifyInstance, baseBranch: unknown, headers: Record<string, string> = {}) =>
    instance.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { repo: 'acme/web', command: 'echo hi', baseBranch } as object,
        headers,
    });

afterEach(() => {
    vi.useRealTimers();
});

describe('POST /api/jobs baseBranch', () => {
    it.each([
        ['an empty string', ''],
        ['a number', 7],
        ['a name with ..', 'a..b'],
        ['a name with a leading dash', '-x'],
        ['a 256-character name', LONG_NAME],
    ])('refuses %s as BAD_BASE_BRANCH and queues nothing', async (_label, value) => {
        const { instance, created } = await boot();
        const response = await post(instance, value);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_BASE_BRANCH');
        expect(created).toEqual([]);
    });

    it('refuses with 422 UNKNOWN_BASE_BRANCH when the remote confirms the branch is absent', async () => {
        const { instance, created } = await boot(async () => null);
        const response = await post(instance, 'release/1');
        expect(response.statusCode).toBe(422);
        expect(response.json().code).toBe('UNKNOWN_BASE_BRANCH');
        expect(created).toEqual([]);
    });

    it('accepts a branch that exists and hands it to the store', async () => {
        const read = vi.fn(async () => 'sha');
        const { instance, created } = await boot(read);
        expect((await post(instance, 'release/1')).statusCode).toBe(201);
        expect(read).toHaveBeenCalledWith('acme/web', 'release/1');
        expect(created.map((c) => c.baseBranch)).toEqual(['release/1']);
    });

    it('hands the store no branch when none is named', async () => {
        const read = vi.fn(async () => null);
        const { instance, created } = await boot(read);
        expect((await post(instance, undefined)).statusCode).toBe(201);
        expect((await post(instance, null)).statusCode).toBe(201);
        expect(read).not.toHaveBeenCalled();
        expect(created.map((c) => c.baseBranch ?? null)).toEqual([null, null]);
    });

    it('accepts when the read throws: rate limit, transport, forbidden or malformed is never a 4xx', async () => {
        const { instance, created } = await boot(async () => {
            throw new Error('GitHub says no');
        });
        expect((await post(instance, 'release/1')).statusCode).toBe(201);
        expect(created.map((c) => c.baseBranch)).toEqual(['release/1']);
    });

    it('accepts when the read outlives the deadline, and the reply arrives within it', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const { instance, created } = await boot(() => new Promise<string | null>(() => {}));
        let settled = false;
        const pending = post(instance, 'release/1').finally(() => {
            settled = true;
        });
        // The handler arms its deadline only after the request reaches it: step the clock until it fires.
        for (let tick = 0; !settled && tick < MAX_TICKS; tick++) await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
        expect((await pending).statusCode).toBe(201);
        expect(created.map((c) => c.baseBranch)).toEqual(['release/1']);
    });

    it('accepts unchecked on a board with no GitHub client', async () => {
        const { instance, created } = await boot();
        expect((await post(instance, 'release/1')).statusCode).toBe(201);
        expect(created.map((c) => c.baseBranch)).toEqual(['release/1']);
    });

    it('fingerprints the branch: the same key with another branch is a different request', async () => {
        const { instance, created } = await boot();
        const headers = { 'idempotency-key': 'attempt-0001-abcd' };
        await post(instance, 'release/1', headers);
        await post(instance, 'release/2', headers);
        const [first, second] = created.map((c) => c.idempotency?.fingerprint);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(second).not.toBe(first);
    });
});
