import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { trackApps } from './helpers-http.js';
import { staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

/**
 * Issue #829 (G6): `POST /api/jobs/:id/phase-checkpoint` records a post-run phase's outcome under
 * the attempt's lease; `POST /api/jobs/:id/phase-checkpoints` reads the run's back for the driver
 * that adopted or took over.
 */
const track = trackApps();
const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';

type Written = Parameters<JobStore['writePhaseCheckpoint']>;
type Answer = 'ok' | 'lost' | 'missing' | 'conflict';

function stubStore(answer: Answer = 'ok') {
    const written: Written[] = [];
    const read: [string, string, number][] = [];
    const store = {
        async writePhaseCheckpoint(...args: Written) {
            written.push(args);
            return { result: answer };
        },
        async readPhaseCheckpoints(id: string, leaseToken: string, runClaimSeq: number) {
            read.push([id, leaseToken, runClaimSeq]);
            return answer === 'ok'
                ? {
                      result: 'ok' as const,
                      checkpoints: [{ phase: 'gates' as const, claimSeq: 2, tree: 'h:2', result: { v: 1 } }],
                  }
                : { result: answer === 'conflict' ? ('lost' as const) : answer };
        },
    } as unknown as JobStore;
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

const good = { leaseToken: TOKEN, runClaimSeq: 2, phase: 'gates', tree: 'h:2', result: { verdict: 'passed' } };

describe('POST /api/jobs/:id/phase-checkpoint', () => {
    it('stores the checkpoint under the lease', async () => {
        const { store, written } = stubStore();
        const res = await post(await harnessWith(store), `/api/jobs/${ID}/phase-checkpoint`, good);
        expect(res.statusCode).toBe(200);
        expect(written).toEqual([
            [ID, TOKEN, { runClaimSeq: 2, phase: 'gates', tree: 'h:2', result: { verdict: 'passed' } }],
        ]);
    });

    it('takes the pre-agent setup phase (issue #917)', async () => {
        const { store, written } = stubStore();
        const result = { failure: { exitCode: 7, output: 'npm ERR!' } };
        const res = await post(await harnessWith(store), `/api/jobs/${ID}/phase-checkpoint`, {
            ...good,
            phase: 'setup',
            tree: null,
            result,
        });
        expect(res.statusCode).toBe(200);
        expect(written[0]![2]).toMatchObject({ phase: 'setup', result });
    });

    it('takes a null tree and a null result', async () => {
        const { store, written } = stubStore();
        const res = await post(await harnessWith(store), `/api/jobs/${ID}/phase-checkpoint`, {
            ...good,
            phase: 'post',
            tree: null,
            result: null,
        });
        expect(res.statusCode).toBe(200);
        expect(written[0]![2]).toMatchObject({ tree: null, result: null });
    });

    it.each([
        ['a bad token', { leaseToken: 'nope' }],
        ['an unknown phase', { phase: 'merge' }],
        ['a fractional run claim', { runClaimSeq: 1.5 }],
        ['a zero run claim', { runClaimSeq: 0 }],
        ['a string run claim', { runClaimSeq: '2' }],
        ['a numeric tree', { tree: 7 }],
        ['a missing result', { result: undefined }],
    ])('refuses %s with 400 and stores nothing', async (_label, patch) => {
        const { store, written } = stubStore();
        const res = await post(await harnessWith(store), `/api/jobs/${ID}/phase-checkpoint`, { ...good, ...patch });
        expect(res.statusCode).toBe(400);
        expect(written).toEqual([]);
    });

    it.each([
        ['missing', 404, 'NOT_FOUND'],
        ['lost', 409, 'LEASE_LOST'],
        ['conflict', 409, 'PHASE_CHECKPOINT_CONFLICT'],
    ] as const)('answers %s as %i with code %s', async (answer, status, code) => {
        const res = await post(await harnessWith(stubStore(answer).store), `/api/jobs/${ID}/phase-checkpoint`, good);
        expect(res.statusCode).toBe(status);
        expect(res.json()).toMatchObject({ code });
    });
});

describe('POST /api/jobs/:id/phase-checkpoints', () => {
    it('answers the run checkpoints', async () => {
        const { store, read } = stubStore();
        const res = await post(await harnessWith(store), `/api/jobs/${ID}/phase-checkpoints`, {
            leaseToken: TOKEN,
            runClaimSeq: 2,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ checkpoints: [{ phase: 'gates', claimSeq: 2, tree: 'h:2', result: { v: 1 } }] });
        expect(read).toEqual([[ID, TOKEN, 2]]);
    });

    it('refuses a bad token or run claim with 400', async () => {
        const instance = await harnessWith(stubStore().store);
        for (const payload of [
            { leaseToken: 'x', runClaimSeq: 2 },
            { leaseToken: TOKEN, runClaimSeq: 0 },
        ]) {
            expect((await post(instance, `/api/jobs/${ID}/phase-checkpoints`, payload)).statusCode).toBe(400);
        }
    });

    it('answers a lost lease as 409 and an unknown job as 404', async () => {
        const body = { leaseToken: TOKEN, runClaimSeq: 2 };
        expect(
            (await post(await harnessWith(stubStore('lost').store), `/api/jobs/${ID}/phase-checkpoints`, body))
                .statusCode
        ).toBe(409);
        expect(
            (await post(await harnessWith(stubStore('missing').store), `/api/jobs/${ID}/phase-checkpoints`, body))
                .statusCode
        ).toBe(404);
    });
});
