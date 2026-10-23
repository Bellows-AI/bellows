import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { JobActionStore } from '../src/db/jobs/job-store-actions.js';
import type { JobConclusionStore } from '../src/db/jobs/job-store-conclusions.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import type { JobWorkerStore } from '../src/db/jobs/job-store-worker.js';
import { trackApps } from './helpers-http.js';
import { staticRegistry, stubTelemetryClient, testConfig, jobStoreSlice } from './helpers.js';

/**
 * Issue #821 (D1): `POST /api/jobs/:id/conclusion` stages the attempt's final envelope under its
 * lease — the very body `complete` takes, parsed by the same validation so the staged fingerprint is
 * the receipt's — and a staged conclusion binds the attempt: a different complete, a park
 * or a released interrupt under that lease is refused `409 CONCLUSION_CONFLICT`.
 */
const track = trackApps();
const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';

type Staged = {
    id: string;
    leaseToken: string;
    result: Parameters<JobWorkerStore['complete']>[2];
    leaseSeconds: number;
};
type Answer = 'ok' | 'lost' | 'missing' | 'conflict';

function stubStore(answer: Answer = 'ok'): JobStore & { staged: Staged[]; completed: Staged['result'][] } {
    const staged: Staged[] = [];
    const completed: Staged['result'][] = [];
    const settled = async () =>
        answer === 'ok' ? { result: 'ok' as const, status: 'queued' as const } : { result: answer };
    return Object.assign(
        jobStoreSlice<JobConclusionStore & JobWorkerStore & JobActionStore>({
            async stageConclusion(id: string, leaseToken: string, result: Staged['result'], leaseSeconds: number) {
                staged.push({ id, leaseToken, result, leaseSeconds });
                return { result: answer };
            },
            async complete(_id: string, _token: string, result: Staged['result']) {
                completed.push(result);
                return answer === 'ok' ? { result: 'ok', threadDone: false, reclaimId: null } : { result: answer };
            },
            suspend: settled,
            interrupt: settled,
        }),
        { staged, completed }
    );
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

const done = { leaseToken: TOKEN, status: 'succeeded', exitCode: 0, output: 'hello' };

describe('POST /api/jobs/:id/conclusion', () => {
    it('stages the body complete would take, parsed the same way', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const body = {
            ...done,
            agentTurns: 3,
            failureKind: 'gate',
            status: 'failed',
            failureCause: 'verification',
            publication: {
                repo: 'acme/web',
                prNumber: 7,
                prUrl: 'https://github.com/acme/web/pull/7',
                headBranch: 'factory/x',
                baseBranch: 'main',
            },
        };

        const staged = await post(instance, `/api/jobs/${ID}/conclusion`, { ...body, leaseSeconds: 120 });
        const completed = await post(instance, `/api/jobs/${ID}/complete`, body);

        expect(staged.statusCode).toBe(200);
        expect(staged.json()).toEqual({ id: ID, status: 'failed' });
        expect(completed.statusCode).toBe(200);
        expect(store.staged).toEqual([{ id: ID, leaseToken: TOKEN, result: store.completed[0], leaseSeconds: 120 }]);
    });

    it('renews by the default lease when the body names none, and refuses a bad one', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        expect((await post(instance, `/api/jobs/${ID}/conclusion`, done)).statusCode).toBe(200);
        expect(store.staged[0]?.leaseSeconds).toBe(300);
        const bad = await post(instance, `/api/jobs/${ID}/conclusion`, { ...done, leaseSeconds: 0 });
        expect(bad.statusCode).toBe(400);
        expect(bad.json().code).toBe('BAD_LEASE');
    });

    it.each<[string, string, Record<string, unknown>]>([
        ['no lease token', 'BAD_TOKEN', { leaseToken: undefined }],
        ['an unknown status', 'BAD_STATUS', { status: 'dead' }],
        ['a fractional exit code', 'BAD_EXIT_CODE', { exitCode: 1.5 }],
        ['a cause with no kind', 'BAD_FAILURE_KIND', { status: 'failed', failureCause: 'conflict' }],
        ['a malformed publication', 'BAD_PUBLICATION', { publication: { repo: 'acme/web' } }],
        // The columns are int4 (`job.exit_code`, `job_pr.pr_number`): a value past them would fail the
        // verdict's transaction — and a staged one every claim that commits it.
        ['an exit code past int4', 'BAD_EXIT_CODE', { exitCode: 2_147_483_648 }],
        ['an exit code below int4', 'BAD_EXIT_CODE', { exitCode: -2_147_483_649 }],
        [
            'a PR number past int4',
            'BAD_PUBLICATION',
            {
                publication: {
                    repo: 'acme/web',
                    prNumber: 2_147_483_648,
                    prUrl: 'https://github.com/acme/web/pull/2147483648',
                    headBranch: 'factory/x',
                    baseBranch: 'main',
                },
            },
        ],
    ])('refuses %s with %s, as complete does', async (_label, code, fields) => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const staged = await post(instance, `/api/jobs/${ID}/conclusion`, { ...done, ...fields });
        const completed = await post(instance, `/api/jobs/${ID}/complete`, { ...done, ...fields });

        expect([staged.statusCode, staged.json().code]).toEqual([400, code]);
        expect([completed.statusCode, completed.json().code]).toEqual([400, code]);
        expect(store.staged).toEqual([]);
    });

    it.each<[Answer, number, string]>([
        ['lost', 409, 'LEASE_LOST'],
        ['conflict', 409, 'CONCLUSION_CONFLICT'],
        ['missing', 404, 'NOT_FOUND'],
    ])('answers a %s stage %i %s', async (answer, status, code) => {
        const instance = await harnessWith(stubStore(answer));

        const response = await post(instance, `/api/jobs/${ID}/conclusion`, done);

        expect(response.statusCode).toBe(status);
        expect(response.json().code).toBe(code);
    });
});

describe('a staged conclusion refuses the attempt’s other settles', () => {
    it.each([
        ['a different complete', 'complete', done],
        ['a park', 'suspend', { leaseToken: TOKEN }],
        ['a released interrupt', 'interrupt', { leaseToken: TOKEN, reason: 'drained', release: true }],
    ])('answers %s 409 CONCLUSION_CONFLICT', async (_what, route, body) => {
        const instance = await harnessWith(stubStore('conflict'));

        const response = await post(instance, `/api/jobs/${ID}/${route}`, body);

        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('CONCLUSION_CONFLICT');
    });
});
