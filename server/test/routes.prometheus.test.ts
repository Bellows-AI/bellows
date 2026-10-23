import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { createServerMetrics, type AdmissionOccupancy } from '../src/metrics.js';
import { CONTENT_TYPE } from '../src/prometheus.js';
import {
    buildWithAuth,
    githubAuth,
    makeClaim,
    memoryAuthStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
    TEST_JOB_BOARD_TOKEN,
} from './helpers.js';
import { HTTP_NOT_FOUND, HTTP_OK, HTTP_UNAUTHORIZED, trackApps } from './helpers-http.js';

const track = trackApps();
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const occupancy: AdmissionOccupancy = { global: 3, orgMax: 2, repoMax: 1 };

const metricsWith = (
    read: () => Promise<AdmissionOccupancy> = async () => occupancy,
    admission = { global: 8, org: 4 }
) => createServerMetrics({ admission, occupancy: read });

async function build(deps: Partial<Parameters<typeof buildApp>[0]> = {}, jobs?: Partial<JobStore>) {
    const config = testConfig();
    const app = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient(), ...(jobs ? { jobs: jobs as JobStore } : {}) }),
        ...deps,
    });
    track(app);
    return app;
}

describe('GET /api/metrics', () => {
    it('serves the 0.0.4 exposition and labels routes by pattern, never by raw id', async () => {
        const app = await build({ metrics: metricsWith() });
        await app.inject({ method: 'GET', url: '/api/version' });
        await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}` });
        await app.inject({ method: 'GET', url: '/api/no-such-route' });

        const response = await app.inject({ method: 'GET', url: '/api/metrics' });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.headers['content-type']).toBe(CONTENT_TYPE);
        const text = response.body;
        expect(text).toContain('# TYPE factory_http_request_duration_seconds histogram');
        expect(text).toContain(
            'factory_http_request_duration_seconds_count{method="GET",route="/api/version",status_class="2xx"} 1'
        );
        expect(text).toContain('route="/api/jobs/:id"');
        expect(text).toContain('route="<unmatched>"');
        expect(text).not.toMatch(UUID_ANYWHERE);
    });

    it('reports admission occupancy and the configured limits, with no id in a label', async () => {
        const app = await build({ metrics: metricsWith() });
        const text = (await app.inject({ method: 'GET', url: '/api/metrics' })).body;
        expect(text).toContain('factory_admission_running{scope="global"} 3');
        expect(text).toContain('factory_admission_running_max{scope="org"} 2');
        expect(text).toContain('factory_admission_running_max{scope="repo"} 1');
        expect(text).toContain('factory_admission_limit{scope="global"} 8');
        expect(text).toContain('factory_admission_limit{scope="org"} 4');
        expect(text).not.toContain('factory_admission_limit{scope="repo"}');
    });

    it('omits the occupancy samples when the read fails, and counts the failure', async () => {
        const app = await build({
            metrics: metricsWith(async () => {
                throw new Error('canceling statement due to statement timeout');
            }),
        });
        const text = (await app.inject({ method: 'GET', url: '/api/metrics' })).body;
        expect(text).not.toContain('factory_admission_running{');
        expect(text).not.toContain('factory_admission_running_max{');
        expect(text).toContain('factory_metrics_read_failures_total{source="admission"} 1');
        // Configured limits need no read.
        expect(text).toContain('factory_admission_limit{scope="global"} 8');
    });

    it('does not exist without metrics, and no hook observes', async () => {
        const app = await build();
        const response = await app.inject({ method: 'GET', url: '/api/metrics' });
        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('counts claim polls by outcome', async () => {
        const claims: (() => ReturnType<JobStore['claim']>)[] = [
            async () => makeClaim({ id: JOB_ID, command: 'echo', leaseToken: JOB_ID }),
            async () => null,
            async () => {
                throw new Error('db down');
            },
        ];
        const app = await build({ metrics: metricsWith() }, { claim: async () => claims.shift()!() });
        for (let i = 0; i < 3; i++) {
            await app.inject({ method: 'POST', url: '/api/jobs/claim', payload: { worker: 'driver-1' } });
        }
        const text = (await app.inject({ method: 'GET', url: '/api/metrics' })).body;
        expect(text).toContain('factory_claim_polls_total{outcome="claimed"} 1');
        expect(text).toContain('factory_claim_polls_total{outcome="idle"} 1');
        expect(text).toContain('factory_claim_polls_total{outcome="error"} 1');
    });
});

describe('GET /api/metrics credentials', () => {
    const github = async () => {
        const store = memoryAuthStore();
        const app = await buildWithAuth(githubAuth(), store, {}, { metrics: metricsWith() });
        track(app);
        return { app, store };
    };

    it('401s without a credential', async () => {
        const { app } = await github();
        expect((await app.inject({ method: 'GET', url: '/api/metrics' })).statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('401s a member session: a person is not the scraper', async () => {
        const { app, store } = await github();
        const cookie = await signedIn(store, store.seedMember('test-org', 'octocat', 'admin'));
        const response = await app.inject({ method: 'GET', url: '/api/metrics', headers: { cookie } });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('serves the shared board secret', async () => {
        const { app } = await github();
        const response = await app.inject({
            method: 'GET',
            url: '/api/metrics',
            headers: { authorization: `Bearer ${TEST_JOB_BOARD_TOKEN}` },
        });
        expect(response.statusCode).toBe(HTTP_OK);
    });
});
