import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import type { PrOperationStore } from '../src/db/jobs/job-store-pr-operations.js';
import { trackApps } from './helpers-http.js';
import { staticRegistry, stubTelemetryClient, testConfig, jobStoreSlice } from './helpers.js';

/**
 * Issue #983: `POST /api/jobs/:id/pr-operation` records one managed publish operation (a PR the
 * driver created, or reused) under the attempt's lease. It is the worker's route: the lease in the
 * body is the credential, and the org comes from the job's own scope.
 */
const track = trackApps();
const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';
const OPERATION = '88888888-8888-4888-8888-888888888888';

type Written = Parameters<PrOperationStore['writePrOperation']>;
type Answer = 'ok' | 'lost' | 'missing';

const FIELDS = {
    operationId: OPERATION,
    operation: 'created' as const,
    repo: 'Bellows-AI/bellows',
    prNumber: 42,
    prUrl: 'https://github.com/Bellows-AI/bellows/pull/42',
    branch: 'fix/10',
};
const good = { leaseToken: TOKEN, ...FIELDS };

function stubStore(answer: Answer = 'ok') {
    const written: Written[] = [];
    const store = jobStoreSlice<PrOperationStore>({
        async writePrOperation(...args: Written) {
            written.push(args);
            return { result: answer };
        },
    });
    return { store, written };
}

async function harnessWith(jobs: JobStore): Promise<FastifyInstance> {
    const config = testConfig();
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, jobs, telemetry: stubTelemetryClient() }),
    });
    track(instance);
    return instance;
}

const post = (instance: FastifyInstance, payload: unknown) =>
    instance.inject({ method: 'POST', url: `/api/jobs/${ID}/pr-operation`, payload: payload as object });

describe('POST /api/jobs/:id/pr-operation', () => {
    it('stores the operation under the lease, whole', async () => {
        const { store, written } = stubStore();
        const res = await post(await harnessWith(store), good);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ id: ID, operationId: OPERATION });
        expect(written).toEqual([[ID, TOKEN, FIELDS]]);
    });

    it('takes a reused operation', async () => {
        const { store, written } = stubStore();
        const res = await post(await harnessWith(store), { ...good, operation: 'reused' });
        expect(res.statusCode).toBe(200);
        expect(written[0]![2]).toMatchObject({ operation: 'reused' });
    });

    it.each([
        ['a bad lease token', { leaseToken: 'nope' }],
        ['a non-uuid operation id', { operationId: 'op-1' }],
        ['an agent operation: only the driver’s own are recorded here', { operation: 'agent' }],
        ['a missing operation', { operation: undefined }],
        ['a blank repo', { repo: ' ' }],
        ['an oversized repo', { repo: 'r'.repeat(300) }],
        ['a fractional PR number', { prNumber: 1.5 }],
        ['a zero PR number', { prNumber: 0 }],
        ['a string PR number', { prNumber: '42' }],
        ['a non-string url', { prUrl: 7 }],
        ['an oversized url', { prUrl: `https://github.com/${'x'.repeat(3000)}` }],
        ['a blank branch', { branch: '' }],
        ['an oversized branch', { branch: 'b'.repeat(300) }],
    ])('refuses %s with 400 and stores nothing', async (_label, patch) => {
        const { store, written } = stubStore();
        const res = await post(await harnessWith(store), { ...good, ...patch });
        expect(res.statusCode).toBe(400);
        expect(written).toEqual([]);
    });

    it.each([
        ['missing', 404, 'NOT_FOUND'],
        ['lost', 409, 'LEASE_LOST'],
    ] as const)('answers %s as %i with code %s', async (answer, status, code) => {
        const res = await post(await harnessWith(stubStore(answer).store), good);
        expect(res.statusCode).toBe(status);
        expect(res.json()).toMatchObject({ code });
    });
});
