import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import type { GateRunStore } from '../src/db/jobs/job-store-gate-runs.js';
import { trackApps } from './helpers-http.js';
import { staticRegistry, stubTelemetryClient, testConfig, jobStoreSlice } from './helpers.js';

/**
 * Issue #983: `POST /api/jobs/:id/gate-run` records one gate execution under the attempt's lease;
 * `POST /api/jobs/:id/gate-runs` reads the run's latest row per gate back for the driver's completion
 * pass. Both are the worker's routes: the lease in the body is the credential.
 */
const track = trackApps();
const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';
const EXECUTION = '77777777-7777-4777-8777-777777777777';

type Written = Parameters<GateRunStore['writeGateRun']>;
type Answer = 'ok' | 'lost' | 'missing' | 'conflict';

const READ_ROW = {
    runClaimSeq: 2,
    claimSeq: 2,
    executionId: EXECUTION,
    gate: 'test',
    identity: 'a'.repeat(64),
    filtered: false,
    source: 'adhoc' as const,
    outcome: 'passed' as const,
    exitCode: 0,
    treeBefore: 'h:1',
    treeAfter: 'h:1',
    mutatedSince: false,
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: '2026-10-26T10:01:00.000Z',
};

function stubStore(answer: Answer = 'ok') {
    const written: Written[] = [];
    const read: [string, string, number][] = [];
    const store = jobStoreSlice<GateRunStore>({
        async writeGateRun(...args: Written) {
            written.push(args);
            return { result: answer };
        },
        async readGateRuns(id: string, leaseToken: string, runClaimSeq: number) {
            read.push([id, leaseToken, runClaimSeq]);
            return answer === 'ok'
                ? { result: 'ok' as const, runs: [READ_ROW] }
                : { result: answer === 'conflict' ? ('lost' as const) : answer };
        },
    });
    return { store, written, read };
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

const post = (instance: FastifyInstance, url: string, payload: unknown) =>
    instance.inject({ method: 'POST', url, payload: payload as object });

const { claimSeq: _claimSeq, ...WRITE_FIELDS } = READ_ROW;
const good = { leaseToken: TOKEN, ...WRITE_FIELDS };

describe('POST /api/jobs/:id/gate-run', () => {
    it('stores the row under the lease, whole', async () => {
        const { store, written } = stubStore();
        const res = await post(await harnessWith(store), `/api/jobs/${ID}/gate-run`, good);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ id: ID, executionId: EXECUTION });
        expect(written).toEqual([[ID, TOKEN, WRITE_FIELDS]]);
    });

    it('takes a running row: no exit code, no tree after, no finish', async () => {
        const { store, written } = stubStore();
        const running = {
            ...good,
            outcome: 'running',
            exitCode: null,
            treeAfter: null,
            mutatedSince: null,
            finishedAt: null,
        };
        const res = await post(await harnessWith(store), `/api/jobs/${ID}/gate-run`, running);
        expect(res.statusCode).toBe(200);
        expect(written[0]![2]).toMatchObject({ outcome: 'running', exitCode: null, finishedAt: null });
    });

    it.each([
        ['a bad lease token', { leaseToken: 'nope' }],
        ['a fractional run claim', { runClaimSeq: 1.5 }],
        ['a zero run claim', { runClaimSeq: 0 }],
        ['a non-uuid execution id', { executionId: 'run-1' }],
        ['a blank gate name', { gate: ' ' }],
        ['a gate name past the limit', { gate: 'g'.repeat(65) }],
        ['an identity that is not a 64-hex digest', { identity: 'secret-value' }],
        ['a non-boolean filtered flag', { filtered: 'no' }],
        ['an unknown source', { source: 'cron' }],
        ['an unknown outcome', { outcome: 'maybe' }],
        ['a fractional exit code', { exitCode: 1.5 }],
        ['a numeric tree', { treeBefore: 7 }],
        ['an oversized tree', { treeAfter: 'x'.repeat(300) }],
        ['a string mutation flag', { mutatedSince: 'no' }],
        ['a start time that is not a date', { startedAt: 'yesterday' }],
        ['a numeric finish time', { finishedAt: 7 }],
        ['a missing outcome', { outcome: undefined }],
    ])('refuses %s with 400 and stores nothing', async (_label, patch) => {
        const { store, written } = stubStore();
        const res = await post(await harnessWith(store), `/api/jobs/${ID}/gate-run`, { ...good, ...patch });
        expect(res.statusCode).toBe(400);
        expect(written).toEqual([]);
    });

    it.each([
        ['missing', 404, 'NOT_FOUND'],
        ['lost', 409, 'LEASE_LOST'],
        ['conflict', 409, 'GATE_RUN_CONFLICT'],
    ] as const)('answers %s as %i with code %s', async (answer, status, code) => {
        const res = await post(await harnessWith(stubStore(answer).store), `/api/jobs/${ID}/gate-run`, good);
        expect(res.statusCode).toBe(status);
        expect(res.json()).toMatchObject({ code });
    });
});

describe('POST /api/jobs/:id/gate-runs', () => {
    it('answers the run’s rows under the lease', async () => {
        const { store, read } = stubStore();
        const res = await post(await harnessWith(store), `/api/jobs/${ID}/gate-runs`, {
            leaseToken: TOKEN,
            runClaimSeq: 2,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ runs: [READ_ROW] });
        expect(read).toEqual([[ID, TOKEN, 2]]);
    });

    it.each([
        ['a bad lease token', { leaseToken: 'nope', runClaimSeq: 2 }],
        ['a fractional run claim', { leaseToken: TOKEN, runClaimSeq: 1.5 }],
        ['a missing run claim', { leaseToken: TOKEN }],
    ])('refuses %s with 400', async (_label, payload) => {
        const { store, read } = stubStore();
        const res = await post(await harnessWith(store), `/api/jobs/${ID}/gate-runs`, payload);
        expect(res.statusCode).toBe(400);
        expect(read).toEqual([]);
    });

    it.each([
        ['missing', 404],
        ['lost', 409],
    ] as const)('answers a %s job as %i', async (answer, status) => {
        const res = await post(await harnessWith(stubStore(answer).store), `/api/jobs/${ID}/gate-runs`, {
            leaseToken: TOKEN,
            runClaimSeq: 2,
        });
        expect(res.statusCode).toBe(status);
    });
});
