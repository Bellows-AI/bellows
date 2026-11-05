import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { JobActionStore } from '../src/db/jobs/job-store-actions.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import {
    githubAuth,
    jobStoreSlice,
    memoryAuthStore,
    memoryBatchStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';
import { HTTP_OK, trackApps } from './helpers-http.js';

/**
 * Offline: the `standing` every batch read carries (docs/batches.md) — the board's verdict, so a
 * client decides nothing from the raw record. The pure rules are core/test/batch-standing.test.ts;
 * this pins the wiring: which reads carry it, what it is computed from, and the unread-report case.
 */

const ORG = 'test-org';
const PR = 'https://example.test/o/api/pull/9';
const track = trackApps();

const plan = {
    planVersion: 1,
    title: 'Upgrade',
    targets: [{ key: 'web', repo: 'Bellows-AI/bellows.ai' }],
    defaultTarget: 'web',
    stages: [
        {
            key: 'one',
            tasks: ['a', 'b'].map((key) => ({
                key,
                objective: `do ${key}`,
                acceptance: 'it works',
                verification: 'npm test',
            })),
        },
    ],
};

async function setup() {
    const auth = memoryAuthStore();
    const member = auth.seedMember(ORG, 'octocat');
    const batches = memoryBatchStore();
    const config = testConfig({ auth: githubAuth(), batches: { enabled: true } });
    const base = staticRepoSource([{ owner: 'Bellows-AI', name: 'bellows.ai' }], { error: null });
    const repos = {
        ...base,
        detail: async () => ({
            repos: [{ owner: 'Bellows-AI', name: 'bellows.ai', defaultBranch: 'main', private: false, pushedAt: null }],
            installation: null,
            error: null,
        }),
    };
    const app = await buildApp({
        config,
        orgs: staticRegistry({
            config,
            repos,
            jobs: jobStoreSlice<JobActionStore>({ create: async () => ({ id: 'never' }) }),
            telemetry: stubTelemetryClient(),
            batchesByOrg: { [ORG]: batches },
        }),
        auth,
    });
    track(app);
    const cookie = await signedIn(auth, member);
    const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
        app!.inject({
            method,
            url,
            ...(payload === undefined ? {} : { payload: payload as object }),
            headers: { cookie, ...headers },
        });
    const draft = async () => ((await call('POST', '/api/batches', { plan })).json() as { id: string }).id;
    const started = async () => {
        const id = await draft();
        await call('POST', `/api/batches/${id}/start`, { version: 1 });
        return id;
    };
    const standing = async (id: string) => {
        const read = await call('GET', `/api/batches/${id}`);
        expect(read.statusCode).toBe(HTTP_OK);
        return read.json().standing;
    };
    return { call, batches, draft, started, standing };
}

describe('batch standing', () => {
    it('is draft for a draft, with no report read', async () => {
        const { draft, standing } = await setup();
        expect(await standing(await draft())).toEqual({
            verdict: 'draft',
            fence: null,
            attention: [],
            verificationFailures: [],
        });
    });

    it('rides the start answer and its replay, computed after dispatch', async () => {
        const { call, batches, draft } = await setup();
        const id = await draft();
        const headers = { 'idempotency-key': 'start-key-12345678' };
        const start = await call('POST', `/api/batches/${id}/start`, { version: 1 }, headers);
        expect(start.json()).toMatchObject({ status: 'running', standing: { verdict: 'running' } });
        batches.mark(id, 'a', { execution: 'failed' });
        batches.mark(id, 'b', { execution: 'succeeded' });
        // The replay answers the batch as it is now, not as the first start saw it.
        const replay = await call('POST', `/api/batches/${id}/start`, { version: 1 }, headers);
        expect(replay.headers['idempotency-replayed']).toBe('true');
        expect(replay.json().standing.verdict).toBe('failed');
    });

    it('carries standing on the settle long-poll and on a cancel', async () => {
        const { call, batches, started } = await setup();
        const id = await started();
        batches.mark(id, 'a', { execution: 'failed' });
        batches.mark(id, 'b', { execution: 'succeeded' });
        const held = await call('GET', `/api/batches/${id}?waitFor=terminal&timeout=1`);
        expect(held.json()).toMatchObject({ result: 'parked', batch: { standing: { verdict: 'failed' } } });
        const cancelled = await call('POST', `/api/batches/${id}/cancel`, {});
        expect(cancelled.json().standing).toMatchObject({ verdict: 'cancelled', fence: 'cancelled' });
    });

    it.each(['succeeded', 'running'])(
        'a cancelled batch with a %s task is cancelled, naming the fence',
        async (execution) => {
            const { call, batches, started, standing } = await setup();
            const id = await started();
            batches.mark(id, 'a', { execution });
            await call('POST', `/api/batches/${id}/cancel`, {});
            expect(await standing(id)).toMatchObject({ verdict: 'cancelled', fence: 'cancelled' });
        }
    );

    it('a fence committed after the snapshot is in neither the record, the report nor the standing', async () => {
        const { call, batches, started } = await setup();
        const id = await started();
        batches.mark(id, 'a', { execution: 'succeeded', pr: PR, waitReason: 'waiting for a person to merge' });
        const snapshot = batches.snapshot.bind(batches);
        batches.snapshot = async (batchId) => {
            const taken = await snapshot(batchId);
            await batches.cancel(id, null);
            return taken;
        };
        const body = (await call('GET', `/api/batches/${id}`)).json();
        expect(body.cancelledAt).toBeNull();
        expect(body.report.cancelledAt).toBeNull();
        expect(body.standing).toMatchObject({ verdict: 'needs_attention', fence: null });
    });

    it('returns the report the standing was computed from in the same body, null for a draft or an unread report', async () => {
        const { call, batches, draft, started } = await setup();
        const id = await started();
        batches.mark(id, 'a', { execution: 'succeeded', pr: PR, waitReason: 'waiting for a person to merge' });
        await call('POST', `/api/batches/${id}/cancel`, {});
        const body = (await call('GET', `/api/batches/${id}`)).json();
        expect(body.standing.fence).toBe('cancelled');
        expect(body.report.cancelledAt).toBe(body.cancelledAt);
        expect(body.report.tasks.map((entry: { key: string }) => entry.key)).toEqual(['a', 'b']);

        expect((await call('GET', `/api/batches/${await draft()}`)).json().report).toBeNull();
        batches.report = async () => {
            throw new Error('db down');
        };
        expect((await call('GET', `/api/batches/${id}`)).json().report).toBeNull();
    });

    it('reads the record and the report from one snapshot: an automerge completing mid-read cannot mix states', async () => {
        const { batches, started, standing } = await setup();
        const id = await started();
        const pr = { pr: PR, waitReason: 'waiting for the board to merge' };
        batches.mark(id, 'a', { execution: 'succeeded', gate: 'open', ...pr });
        batches.mark(id, 'b', { execution: 'succeeded', gate: 'passed' });
        batches.plantNext(id, 'a', { action: 'wait' });
        // The merge completes just after the snapshot: the old record + a later report must not combine.
        const snapshot = batches.snapshot.bind(batches);
        batches.snapshot = async (batchId) => {
            const taken = await snapshot(batchId);
            batches.mark(id, 'a', { gate: 'passed', waitReason: null, pr: 'none' });
            batches.plantNext(id, 'a', { action: 'none' });
            return taken;
        };
        expect(await standing(id)).toMatchObject({ verdict: 'running', attention: [] });
    });

    it('an expired batch is cancelled, naming the expiry', async () => {
        const { batches, started, standing } = await setup();
        const id = await started();
        batches.expire(id);
        expect(await standing(id)).toMatchObject({ verdict: 'cancelled', fence: 'expired' });
    });

    it('a failed stage verification needs attention, naming the stage', async () => {
        const { batches, started, standing } = await setup();
        const id = await started();
        batches.mark(id, 'a', { execution: 'succeeded', gate: 'passed' });
        batches.mark(id, 'b', { execution: 'succeeded', gate: 'passed' });
        batches.plantVerification(id, [
            { stage: 'one', state: 'failed', detail: 'e2e failing', headSha: 'cd89f3d2', checkedAt: 'now' },
        ]);
        const result = await standing(id);
        expect(result.verdict).toBe('needs_attention');
        expect(result.verificationFailures).toEqual([
            { stage: 'one', state: 'failed', detail: 'e2e failing', headSha: 'cd89f3d2' },
        ]);
    });

    it("reads the report's next: a PR the board merges is running, a task needing a person is listed with pr null", async () => {
        const { batches, started, standing } = await setup();
        const id = await started();
        batches.mark(id, 'a', { execution: 'succeeded', pr: PR, waitReason: 'waiting for the board to merge' });
        batches.plantNext(id, 'a', { action: 'wait' });
        expect(await standing(id)).toMatchObject({ verdict: 'running', attention: [] });

        batches.mark(id, 'b', { execution: 'running', waitReason: 'a question' });
        expect(await standing(id)).toMatchObject({
            verdict: 'needs_attention',
            attention: [{ key: 'b', stage: 'one', waitReason: 'a question', pr: null }],
        });
    });

    it('a completed batch with a force-closed task is succeeded', async () => {
        const { batches, started, standing } = await setup();
        const id = await started();
        batches.mark(id, 'a', { execution: 'succeeded', gate: 'passed' });
        batches.mark(id, 'b', { execution: 'cancelled', closedAt: '2026-10-12T06:00:00.000Z' });
        batches.complete(id);
        expect(await standing(id)).toMatchObject({ verdict: 'succeeded' });
    });

    it('answers 200 inconclusive when the report read fails, returns null or is malformed', async () => {
        const { call, batches, draft, started, standing } = await setup();
        const id = await started();
        batches.mark(id, 'a', { execution: 'succeeded' });
        batches.mark(id, 'b', { execution: 'succeeded' });
        batches.complete(id);
        const report = batches.report.bind(batches);
        const broken = [
            async () => {
                throw new Error('db down');
            },
            async () => null,
            async () => ({ tasks: 'nope' }),
        ];
        for (const read of broken) {
            batches.report = read as never;
            expect(await standing(id)).toMatchObject({ verdict: 'inconclusive' });
            // The start has already happened by the time the report is read: it must still answer.
            const fresh = await draft();
            const start = await call('POST', `/api/batches/${fresh}/start`, { version: 1 });
            expect(start.statusCode).toBe(HTTP_OK);
            expect(start.json()).toMatchObject({ status: 'running', standing: { verdict: 'inconclusive' } });
        }
        batches.report = report;
        expect(await standing(id)).toMatchObject({ verdict: 'succeeded' });
    });
});
