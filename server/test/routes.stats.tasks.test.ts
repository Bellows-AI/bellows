import { describe, expect, it } from 'vitest';
import { TEST_REPO, harness, stubTelemetryClient, usageFactsOf } from './helpers.js';
import { trackApps } from './helpers-http.js';

const track = trackApps();

const taskHarness = async () => {
    const OTHER_REPO_TOKENS = 90_000;
    const telemetry = stubTelemetryClient({
        facts: () =>
            usageFactsOf([
                // t1: two measured sessions, 1k and 3k billable tokens.
                { sessionId: 'a', taskId: 't1', input: 600, output: 400, at: '2026-08-20T01:00:00Z' },
                { sessionId: 'b', taskId: 't1', input: 2400, output: 600, at: '2026-08-20T02:00:00Z' },
                // t2: one measured session and one null — the null contributor is skipped,
                // and the task still enters the token distribution on what it measured.
                { sessionId: 'c', taskId: 't2', input: 500, output: 500, at: '2026-08-20T03:00:00Z' },
                { sessionId: 'd', taskId: 't2', input: null, output: null, at: '2026-08-20T04:00:00Z' },
                // An other-repo session: excluded from the totals above, excluded here too.
                {
                    sessionId: 'e',
                    taskId: 't5',
                    input: OTHER_REPO_TOKENS,
                    output: OTHER_REPO_TOKENS,
                    at: '2026-08-20T05:00:00Z',
                    repo: 'Other/repo',
                },
            ]),
        runs: () => [
            {
                rootJobId: 't1',
                repo: TEST_REPO,
                createdBy: 'u-alice',
                createdAt: '2026-08-19T00:00:00Z',
                agentTurns: 9,
                wallClockMs: 600_000,
            },
            {
                rootJobId: 't1',
                repo: TEST_REPO,
                createdBy: 'u-alice',
                createdAt: '2026-08-20T05:00:00Z',
                agentTurns: 4,
                wallClockMs: 300_000,
            },
            // t2's only run is unmeasured: excluded from the turn distribution only.
            {
                rootJobId: 't2',
                repo: TEST_REPO,
                createdBy: 'u-bob',
                createdAt: '2026-08-20T06:00:00Z',
                agentTurns: null,
                wallClockMs: null,
            },
            // An other-repo task: out of the repo scope the totals apply, so out of here too.
            {
                rootJobId: 't5',
                repo: 'Other/repo',
                createdBy: 'u-bob',
                createdAt: '2026-08-20T07:00:00Z',
                agentTurns: 50,
                wallClockMs: 60_000,
            },
        ],
    });
    return harness({ telemetry });
};

describe('GET /api/stats task statistics', () => {
    it('reports the per-task distributions over the range, with their counts', async () => {
        const h = await taskHarness();
        const app = track(h.app);
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const OTHER_REPO_TOKENS = 90_000;
        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        // Tokens: t1 totals 4k over its two sessions, t2 1k — the null contributor skipped,
        // and the other-repo task t5 nowhere in the distribution.
        expect(body.tasks.tokensPerTask).toEqual({ avg: 2500, p50: 1000, p95: 4000, tasks: 2 });
        expect(body.tasks.tokensPerTask.p95).toBeLessThan(OTHER_REPO_TOKENS);
        // Job turns: t1 ran twice, t2 once — t2 counts here even though its run was unmeasured.
        expect(body.tasks.jobTurnsPerTask).toEqual({ avg: 1.5, p50: 1, p95: 2, tasks: 2 });
        // Agent turns: t1 banks 9 + 4 = 13; t2 for its unmeasured run and t5 for its repo are
        // both out.
        expect(body.tasks.agentTurnsPerTask).toEqual({ avg: 13, p50: 13, p95: 13, tasks: 1 });
        // Wall clock: t1 banks 600k + 300k ms; t2's never-executed run leaves it out here too.
        expect(body.tasks.wallClockPerTask).toEqual({ avg: 900_000, p50: 900_000, p95: 900_000, tasks: 1 });
    });

    it('answers null figures, not zeros, for a range with nothing in it', async () => {
        const h = await taskHarness();
        const app = track(h.app);
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const url = '/api/stats?range=custom&from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z';
        const body = (await app.inject({ method: 'GET', url })).json();
        expect(body.telemetry.totals.sessions).toBe(0);
        expect(body.tasks.tokensPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(body.tasks.jobTurnsPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(body.tasks.agentTurnsPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(body.tasks.wallClockPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
    });
});
