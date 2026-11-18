import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { JobClaimStore } from '../src/db/jobs/job-store-claim.js';
import { createServerMetrics, type AdmissionOccupancy } from '../src/metrics.js';
import { jobStoreSlice, makeClaim, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import { HTTP_NOT_FOUND, trackApps } from './helpers-http.js';
import { metricsHarness, pointsIn, countOf } from './helpers-metrics.js';

const track = trackApps();
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const HTTP_DURATION = 'http.server.request.duration';

const occupancy: AdmissionOccupancy = { global: 3, orgMax: 2, repoMax: 1 };

function metricsWith(
    read: () => Promise<AdmissionOccupancy> = async () => occupancy,
    admission = { global: 8, org: 4 }
) {
    const harness = metricsHarness();
    const metrics = createServerMetrics({ admission, occupancy: read, meter: harness.meter });
    return { ...harness, metrics };
}

async function build(deps: Partial<Parameters<typeof buildApp>[0]> = {}, jobs?: Partial<JobClaimStore>) {
    const config = testConfig();
    const app = await buildApp({
        config,
        orgs: staticRegistry({
            config,
            telemetry: stubTelemetryClient(),
            ...(jobs ? { jobs: jobStoreSlice<JobClaimStore>(jobs) } : {}),
        }),
        ...deps,
    });
    track(app);
    return app;
}

describe('board metrics', () => {
    it('labels request durations by route pattern, never by raw id', async () => {
        const { metrics, points } = metricsWith();
        const app = await build({ metrics });
        await app.inject({ method: 'GET', url: '/api/version' });
        await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}` });
        await app.inject({ method: 'GET', url: '/api/no-such-route' });

        const durations = await points(HTTP_DURATION);
        expect(
            countOf(durations, {
                'http.request.method': 'GET',
                'http.route': '/api/version',
                'http.response.status_code': 200,
            })
        ).toBe(1);
        const routes = durations.map((p) => p.attributes['http.route']);
        expect(routes).toContain('/api/jobs/:id');
        expect(routes).toContain('<unmatched>');
        expect(JSON.stringify(durations.map((p) => p.attributes))).not.toContain(JOB_ID);
    });

    it('reports admission occupancy and the configured limits, with no id in an attribute', async () => {
        const { points } = metricsWith();
        expect(countOf(await points('bellows.admission.running'), { scope: 'global' })).toBe(3);
        const max = await points('bellows.admission.running.max');
        expect(countOf(max, { scope: 'org' })).toBe(2);
        expect(countOf(max, { scope: 'repo' })).toBe(1);
        const limits = await points('bellows.admission.limit');
        expect(countOf(limits, { scope: 'global' })).toBe(8);
        expect(countOf(limits, { scope: 'org' })).toBe(4);
        expect(countOf(limits, { scope: 'repo' })).toBeUndefined();
    });

    it('omits the occupancy samples when the read fails, and counts the failure', async () => {
        const { collect } = metricsWith(async () => {
            throw new Error('canceling statement due to statement timeout');
        });
        const collected = await collect();
        expect(pointsIn(collected, 'bellows.admission.running')).toEqual([]);
        expect(pointsIn(collected, 'bellows.admission.running.max')).toEqual([]);
        expect(countOf(pointsIn(collected, 'bellows.metrics.read.failures'), { source: 'admission' })).toBe(1);
        // Configured limits need no read.
        expect(countOf(pointsIn(collected, 'bellows.admission.limit'), { scope: 'global' })).toBe(8);
    });

    it('bounds an occupancy read that never returns: aborts its signal, omits the samples, counts the failure', async () => {
        let signal: AbortSignal | undefined;
        const harness = metricsHarness();
        createServerMetrics({
            admission: {},
            occupancy: (s) => {
                signal = s;
                return new Promise(() => undefined);
            },
            readDeadlineMs: 20,
            meter: harness.meter,
        });
        const collected = await harness.collect();
        expect(pointsIn(collected, 'bellows.admission.running')).toEqual([]);
        expect(signal?.aborted).toBe(true);
        expect(countOf(pointsIn(collected, 'bellows.metrics.read.failures'), { source: 'admission' })).toBe(1);
    });

    it('has no scrape endpoint', async () => {
        const app = await build({ metrics: metricsWith().metrics });
        expect((await app.inject({ method: 'GET', url: '/api/metrics' })).statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('counts claim polls by outcome', async () => {
        const claims: (() => ReturnType<JobClaimStore['claim']>)[] = [
            async () => makeClaim({ id: JOB_ID, command: 'echo', leaseToken: JOB_ID }),
            async () => null,
            async () => {
                throw new Error('db down');
            },
        ];
        const { metrics, points } = metricsWith();
        const app = await build({ metrics }, { claim: async () => claims.shift()!() });
        for (let i = 0; i < 3; i++) {
            await app.inject({ method: 'POST', url: '/api/jobs/claim', payload: { worker: 'driver-1' } });
        }
        const polls = await points('bellows.claim.polls');
        expect(countOf(polls, { outcome: 'claimed' })).toBe(1);
        expect(countOf(polls, { outcome: 'idle' })).toBe(1);
        expect(countOf(polls, { outcome: 'error' })).toBe(1);
    });

    it('observes a background pass once, by outcome, and rethrows a failure', async () => {
        const { metrics, points } = metricsWith();
        await metrics.timedPass('sweep', async () => 1);
        await expect(
            metrics.timedPass('sweep', async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        const passes = await points('bellows.background.pass.duration');
        expect(countOf(passes, { loop: 'sweep', outcome: 'ok' })).toBe(1);
        expect(countOf(passes, { loop: 'sweep', outcome: 'error' })).toBe(1);
    });
});
