import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

const ENV = { FACTORY_URL: 'http://board', FACTORY_TOKEN: 'fat_abc' };
const ID = '11111111-1111-4111-8111-111111111111';

const PLAN = {
    planVersion: 1,
    title: 'Overnight',
    targets: [
        { key: 'api', repo: 'o/api' },
        { key: 'web', repo: 'o/web', branch: 'dev' },
    ],
    defaultTarget: 'api',
    policy: 'human',
    concurrency: 2,
    stages: [
        {
            key: 'build',
            policy: 'automerge',
            tasks: [
                { key: 'a', objective: 'o', required: true, completion: { kind: 'pr' } },
                { key: 'b', target: 'web', objective: 'o', required: true, completion: { kind: 'pr' } },
            ],
        },
    ],
};

const task = (key: string, execution: string, extra: Record<string, unknown> = {}) => ({
    key,
    stage: 'build',
    execution,
    pr: 'none',
    gate: 'open',
    waitReason: null,
    rootJobId: null,
    ...extra,
});

const record = (status: string, tasks: unknown[], extra: Record<string, unknown> = {}) => ({
    id: ID,
    status,
    version: 3,
    plan: PLAN,
    tasks,
    createdAt: 'c',
    updatedAt: 'u',
    startedAt: status === 'started' ? 's' : null,
    startedBy: null,
    createdBy: null,
    cancelledAt: null,
    expiredAt: null,
    verification: [],
    ...extra,
});

/** A stage's combined verification row, as the record and the report both carry it. */
const verified = (state: string, detail: string | null = null) => ({
    stage: 'build',
    state,
    detail,
    headSha: 'cd89f3d2',
    checkedAt: '2026-10-12T17:45:09.298Z',
});

const OBSERVED_AT = '2026-10-12T08:00:00.000Z';

/** The board's morning report (`GET /api/batches/:id/report`), as the server builds it. */
const REPORT = (state = 'running') => ({
    id: ID,
    title: 'Overnight',
    state,
    startedAt: '2026-10-12T00:00:00.000Z',
    deadlineAt: '2026-10-12T12:00:00.000Z',
    expiredAt: state === 'expired' ? '2026-10-12T12:00:00.000Z' : null,
    cancelledAt: state === 'cancelled' ? '2026-10-12T07:00:00.000Z' : null,
    completedAt: null,
    budgets: { infraRetries: 2, repairs: 2, timeLimitMinutes: 720 },
    prs: { merged: [], open: [{ task: 'a', url: 'https://github.com/o/api/pull/9' }] },
    verification: [],
    tasks: [
        {
            key: 'a',
            stage: 'build',
            required: true,
            execution: 'succeeded',
            gate: 'open',
            attempts: 2,
            infraRetries: 0,
            repairs: 1,
            manualRetries: 0,
            remaining: { infraRetries: 2, repairs: 1 },
            attention: null,
            waitReason: 'waiting for a person to merge https://github.com/o/api/pull/9',
            pr: 'https://github.com/o/api/pull/9',
            job: '/api/jobs/j1',
            usage: { wallClockMs: 5000, agentTurns: 7, tokens: null },
            observation: {
                outcome: 'checks_pending',
                checks: 'pending',
                mergeability: 'clean',
                review: 'none',
                headSha: 'h1',
                targetSha: 't1',
                stale: false,
                observedAt: OBSERVED_AT,
                error: null,
            },
            next: { action: 'merge', url: 'https://github.com/o/api/pull/9' },
        },
        {
            key: 'b',
            stage: 'build',
            required: true,
            execution: 'failed',
            gate: 'open',
            attempts: 1,
            infraRetries: 0,
            repairs: 0,
            manualRetries: 1,
            remaining: { infraRetries: 2, repairs: 2 },
            attention: 'configuration',
            waitReason: 'failed on configuration or permission, which a retry cannot fix (job j2)',
            pr: null,
            job: '/api/jobs/j2',
            usage: { wallClockMs: 0, agentTurns: 0, tokens: null },
            observation: null,
            next: { action: 'retry', method: 'POST', path: `/api/batches/${ID}/tasks/b/retry` },
        },
    ],
    latestObservationAt: OBSERVED_AT,
    unavailable: ['tokens', 'cost'],
    totals: {
        accepted: 0,
        failed: 1,
        needsAttention: 2,
        infraRetries: 0,
        repairs: 1,
        wallClockMs: 5000,
        agentTurns: 7,
    },
});

const isReport = (sent: Sent) => sent.url.endsWith('/report');

interface Sent {
    method: string;
    url: string;
    body: unknown;
    key: string | null;
}

async function cli(
    argv: string[],
    respond: (sent: Sent, n: number) => Response,
    extra: { files?: Record<string, string>; clock?: { t: number } } = {}
) {
    const out: string[] = [];
    const err: string[] = [];
    const sent: Sent[] = [];
    const clock = extra.clock ?? { t: 0 };
    const fetch = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
        const entry: Sent = {
            method: init?.method ?? 'GET',
            url: String(url),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
            key: new Headers(init?.headers).get('idempotency-key'),
        };
        sent.push(entry);
        return respond(entry, sent.length);
    }) as unknown as typeof globalThis.fetch;
    const code = await run(argv, {
        env: ENV,
        fetch,
        now: () => clock.t,
        sleep: async (ms) => {
            clock.t += ms;
        },
        readFile: async (path) => {
            const text = extra.files?.[path];
            if (text === undefined) throw new Error('ENOENT');
            return text;
        },
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
    });
    return { code, out: out.join(''), err: err.join(''), sent };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(body, { status, headers });

describe('batch import / update', () => {
    it('creates a draft from a plan file, carrying the plan whole', async () => {
        const result = await cli(
            ['batch', 'import', '--file', 'plan.json', '--idempotency-key', 'key-12345678', '--json'],
            () => json({ id: ID, status: 'draft', version: 1 }, 201),
            { files: { 'plan.json': JSON.stringify(PLAN) } }
        );
        expect(result.code).toBe(0);
        expect(result.sent).toEqual([
            { method: 'POST', url: 'http://board/api/batches', body: { plan: PLAN }, key: 'key-12345678' },
        ]);
        expect(JSON.parse(result.out).data).toEqual({ id: ID, status: 'draft', version: 1 });
    });

    it('refuses an unreadable or non-JSON plan before any request', async () => {
        const missing = await cli(['batch', 'import', '--file', 'nope.json'], () => json({}));
        const bad = await cli(['batch', 'import', '--file', 'bad.json'], () => json({}), {
            files: { 'bad.json': '{not json' },
        });
        const none = await cli(['batch', 'import'], () => json({}));
        for (const result of [missing, bad, none]) {
            expect(result.code).toBe(2);
            expect(result.sent).toEqual([]);
        }
    });

    it('shows every path-addressed plan issue of a rejected plan', async () => {
        const result = await cli(
            ['batch', 'import', '--file', 'plan.json'],
            () =>
                json(
                    {
                        error: 'The batch plan is not valid',
                        code: 'BAD_BATCH',
                        issues: [
                            { path: 'stages[0].tasks[1].target', message: 'unknown target "x"' },
                            { path: '', message: 'needs a title' },
                        ],
                    },
                    400
                ),
            { files: { 'plan.json': '{}' } }
        );
        expect(result.code).toBe(1);
        expect(result.err).toContain('stages[0].tasks[1].target: unknown target "x"');
        expect(result.err).toContain('needs a title');
        expect(result.err).toContain('[BAD_BATCH]');
    });

    it('replaces a draft at the version read, and surfaces a stale one', async () => {
        const ok = await cli(
            ['batch', 'update', ID, '--version', '3', '--stdin'],
            () => json({ id: ID, status: 'draft', version: 4 }),
            {}
        );
        // No stdin reader is injected, so the plan cannot be read: usage, nothing sent.
        expect(ok.code).toBe(2);
        expect(ok.sent).toEqual([]);

        const stale = await cli(
            ['batch', 'update', ID, '--version', '3', '--file', 'plan.json'],
            () => json({ error: 'The draft is at version 5', code: 'BATCH_STALE', version: 5 }, 409),
            { files: { 'plan.json': JSON.stringify(PLAN) } }
        );
        expect(stale.code).toBe(1);
        expect(stale.err).toContain('BATCH_STALE');
        expect(stale.sent).toEqual([
            { method: 'PUT', url: `http://board/api/batches/${ID}`, body: { version: 3, plan: PLAN }, key: null },
        ]);

        const unversioned = await cli(['batch', 'update', ID, '--file', 'plan.json'], () => json({}), {
            files: { 'plan.json': '{}' },
        });
        expect(unversioned.code).toBe(2);
    });
});

describe('batch validate / start / inspect / list', () => {
    it('shows effective stage policies and concurrency before start', async () => {
        const result = await cli(['batch', 'validate', ID], () => json({ valid: true, version: 3, plan: PLAN }));
        expect(result.code).toBe(0);
        expect(result.out).toContain('policy human · concurrency 2');
        expect(result.out).toContain('target web: o/web@dev');
    });

    it('names the executor scope beside the executor, for the batch and a task that differs', async () => {
        const scoped = {
            ...PLAN,
            executor: 'Main ORG',
            executorScope: 'org',
            stages: [
                {
                    key: 'build',
                    tasks: [
                        { key: 'a', objective: 'o', required: true, completion: { kind: 'pr' } },
                        {
                            key: 'b',
                            objective: 'o',
                            executor: 'mine',
                            executorScope: 'user',
                            required: true,
                            completion: { kind: 'pr' },
                        },
                    ],
                },
            ],
        };
        const result = await cli(['batch', 'validate', ID], () => json({ valid: true, version: 3, plan: scoped }));
        expect(result.out).toContain('executor Main ORG (org)');
        const inspected = await cli(['batch', 'inspect', ID], () =>
            json(record('draft', [task('a', 'pending'), task('b', 'pending')], { plan: scoped }))
        );
        expect(inspected.out).toContain('executor Main ORG (org)');
        expect(inspected.out).toContain('b pending · gate open · target api · executor mine (user)');
        expect(inspected.out).toMatch(/a pending · gate open · target api\n/);
    });

    it('round-trips a multi-repository draft on inspect, with each task target and the human gate', async () => {
        const result = await cli(['batch', 'inspect', ID, '--json'], () =>
            json(record('draft', [task('a', 'pending'), task('b', 'pending')]))
        );
        const data = JSON.parse(result.out).data;
        expect(data.batch.plan).toEqual(PLAN);
        expect(data.verdict).toBeNull();

        const human = await cli(['batch', 'inspect', ID], () =>
            json(record('draft', [task('a', 'pending'), task('b', 'pending')]))
        );
        expect(human.out).toContain('b pending · gate open · target web');
        expect(human.out).toContain('a pending · gate open · target api');
    });

    it('names a failed stage verification on inspect, under its stage, with the verdict it forces', async () => {
        const parked = record('started', [task('a', 'succeeded', { gate: 'passed' })], {
            verification: [verified('failed', 'checks on main fail: e2e failing')],
        });
        const result = await cli(['batch', 'inspect', ID], (sent) => json(isReport(sent) ? REPORT() : parked));
        expect(result.out).toContain('verdict needs_attention');
        expect(result.out).toContain('  verification failed: checks on main fail: e2e failing (at cd89f3d2)');
    });

    it('carries the report of a started batch on inspect, and reads none for a draft', async () => {
        const started = await cli(['batch', 'inspect', ID, '--json'], (sent) =>
            json(isReport(sent) ? REPORT() : record('started', [task('a', 'running')]))
        );
        expect(JSON.parse(started.out).data.report).toEqual(REPORT());

        const draft = await cli(['batch', 'inspect', ID, '--json'], () =>
            json(record('draft', [task('a', 'pending')]))
        );
        expect(JSON.parse(draft.out).data.report).toBeNull();
        expect(draft.sent.some(isReport)).toBe(false);
    });

    it('explains the single-target limit and keeps the draft when start refuses a multi-repository plan', async () => {
        const result = await cli(['batch', 'start', ID, '--version', '3'], () =>
            json({ error: 'one target only', code: 'BATCH_UNSUPPORTED', reason: 'multi_target' }, 409)
        );
        expect(result.code).toBe(1);
        expect(result.err).toContain('one target only');
        expect(result.err).toContain('draft is unchanged');
        expect(result.err).toContain('one repository target');
    });

    it('starts at the quoted version and marks a replay', async () => {
        const result = await cli(
            ['batch', 'start', ID, '--version', '3', '--idempotency-key', 'key-12345678', '--json'],
            () => json(record('started', [task('a', 'running')]), 200, { 'idempotency-replayed': 'true' })
        );
        expect(result.code).toBe(0);
        expect(result.sent).toEqual([
            { method: 'POST', url: `http://board/api/batches/${ID}/start`, body: { version: 3 }, key: 'key-12345678' },
        ]);
        expect(JSON.parse(result.out).data.replayed).toBe(true);
    });

    it('says a start that got no answer may have landed, and how to recover', async () => {
        const result = await cli(['batch', 'start', ID, '--version', '3'], () => json({ error: 'boom' }, 500));
        expect(result.code).toBe(1);
        expect(result.err).toContain('may have been applied');
    });

    it('lists batches', async () => {
        const result = await cli(['batch', 'list'], () =>
            json({ batches: [{ id: ID, title: 'T', status: 'draft', version: 1, taskCount: 2 }] })
        );
        expect(result.out).toBe(`${ID} draft v1 2 task(s) "T"\n`);
    });

    it('is usage when a verb is missing its arguments', async () => {
        const result = await cli(['batch', 'retry', ID], () => json({}));
        expect(result.code).toBe(2);
        expect(result.sent).toEqual([]);
    });
});

describe('batch wait', () => {
    /** Answers the batch reads in order, and every report read with `report`. */
    const wait = (states: unknown[], argv: string[] = [], report: unknown = REPORT()) => {
        let reads = 0;
        return cli(['batch', 'wait', ID, '--json', ...argv], (sent) => {
            if (isReport(sent)) return json(report);
            reads += 1;
            return json(states[Math.min(reads, states.length) - 1]);
        });
    };

    it('exits 0 once every task succeeded, polling until then', async () => {
        const result = await wait([
            record('started', [task('a', 'running')]),
            record('started', [task('a', 'succeeded')]),
        ]);
        expect(result.code).toBe(0);
        expect(result.sent.filter((sent) => !isReport(sent))).toHaveLength(2);
        expect(JSON.parse(result.out).outcome).toBe('succeeded');
    });

    it('exits 4 on a failed task, 5 on a cancelled batch', async () => {
        const failed = await wait([record('started', [task('a', 'succeeded'), task('b', 'failed')])]);
        const cancelled = await wait([record('started', [task('a', 'cancelled'), task('b', 'succeeded')])]);
        expect(failed.code).toBe(4);
        expect(cancelled.code).toBe(5);
    });

    it('exits 6 naming the human review gate and the PR needing action', async () => {
        const waiting = record('started', [
            task('a', 'running', { waitReason: 'human review', pr: 'https://github.com/o/api/pull/9' }),
            task('b', 'running'),
        ]);
        const result = await cli(['batch', 'wait', ID], (sent) => json(isReport(sent) ? REPORT() : waiting));
        expect(result.code).toBe(6);
        expect(result.out).toContain('a: human review (pr https://github.com/o/api/pull/9)');

        const asJson = await wait([waiting]);
        expect(JSON.parse(asJson.out).data.needsAction.map((entry: { key: string }) => entry.key)).toEqual(['a']);
    });

    it('exits 6 on a failed stage verification, naming the stage and why, though no task waits', async () => {
        const parked = record('started', [task('a', 'succeeded', { gate: 'passed' })], {
            verification: [verified('failed', 'checks on main at cd89f3d2 fail: e2e failing')],
        });
        const result = await cli(['batch', 'wait', ID], (sent) => json(isReport(sent) ? REPORT() : parked));
        expect(result.code).toBe(6);
        expect(result.out).toContain('stage build verification failed: checks on main at cd89f3d2 fail: e2e failing');
    });

    it('keeps waiting while a stage verification is only pending', async () => {
        const verifying = record('started', [task('a', 'succeeded', { gate: 'passed' })], {
            verification: [verified('pending')],
        });
        expect((await wait([verifying], ['--timeout', '12'])).code).toBe(3);
    });

    it('exits 3 when the budget ends with the batch still moving, leaving it running', async () => {
        const result = await wait([record('started', [task('a', 'running')])], ['--timeout', '12']);
        expect(result.code).toBe(3);
        expect(JSON.parse(result.out).outcome).toBe('timeout');
        // Only reads: a wait never writes.
        expect(result.sent.every((sent) => sent.method === 'GET')).toBe(true);
    });

    it('carries the report in what it ends with, whatever the ending', async () => {
        const settled = await wait([record('started', [task('a', 'succeeded')])]);
        const timedOut = await wait([record('started', [task('a', 'running')])], ['--timeout', '12']);
        expect(JSON.parse(settled.out).data.report).toEqual(REPORT());
        expect(JSON.parse(timedOut.out).data.report).toEqual(REPORT());
    });

    it('ends an expired batch as cancelled, naming it expired, and a cancelled one as cancelled', async () => {
        const fenced = (field: string) =>
            record('started', [task('a', 'succeeded', { waitReason: 'waiting for a person to merge x' })], {
                [field]: '2026-10-12T12:00:00.000Z',
            });
        const expired = await cli(['batch', 'wait', ID], (sent) =>
            json(isReport(sent) ? REPORT('expired') : fenced('expiredAt'))
        );
        const cancelled = await cli(['batch', 'wait', ID], (sent) =>
            json(isReport(sent) ? REPORT('cancelled') : fenced('cancelledAt'))
        );
        expect(expired.code).toBe(5);
        expect(expired.out).toContain(`${ID} expired`);
        expect(cancelled.code).toBe(5);
        expect(cancelled.out).toContain(`${ID} cancelled`);

        const asJson = await wait([fenced('expiredAt')], [], REPORT('expired'));
        expect(JSON.parse(asJson.out)).toMatchObject({ outcome: 'cancelled', data: { report: { state: 'expired' } } });
        expect(asJson.sent.every((sent) => sent.method === 'GET')).toBe(true);
    });

    it('an interrupted wait ends 130 and never cancels the batch', async () => {
        const controller = new AbortController();
        const sent: string[] = [];
        const fetch = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
            // As the platform's fetch does: an aborted signal rejects the request.
            if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
            sent.push(init?.method ?? 'GET');
            return isReport({ method: 'GET', url: String(url), body: null, key: null })
                ? json(REPORT())
                : json(record('started', [task('a', 'running')]));
        }) as unknown as typeof globalThis.fetch;

        const code = await run(['batch', 'wait', ID, '--json'], {
            env: ENV,
            fetch,
            signal: controller.signal,
            sleep: async () => controller.abort(),
            stdout: () => undefined,
            stderr: () => undefined,
        });

        expect(code).toBe(130);
        expect(sent.every((method) => method === 'GET')).toBe(true);
    });

    it('refuses to wait on a draft', async () => {
        const result = await cli(['batch', 'wait', ID], () => json(record('draft', [task('a', 'pending')])));
        expect(result.code).toBe(1);
        expect(result.err).toContain('draft');
    });
});

describe('batch report', () => {
    it('reads the report route and prints each task’s next action, observation age and unavailable usage', async () => {
        const clock = { t: Date.parse(OBSERVED_AT) + 90_000 };
        const result = await cli(['batch', 'report', ID], () => json(REPORT()), { clock });

        expect(result.code).toBe(0);
        expect(result.sent).toEqual([
            { method: 'GET', url: `http://board/api/batches/${ID}/report`, body: null, key: null },
        ]);
        expect(result.out).toContain(`${ID} running "Overnight"`);
        expect(result.out).toContain('tokens: unavailable · cost: unavailable');
        expect(result.out).toContain('latest observation 1m ago');
        expect(result.out).toContain('observed checks_pending 1m ago');
        expect(result.out).toContain('next: merge https://github.com/o/api/pull/9');
        expect(result.out).toContain(`next: retry POST /api/batches/${ID}/tasks/b/retry`);
        expect(result.out).toContain('remaining infra 2, repairs 1');
        expect(result.out).toContain('manual 1');
        // A task with no PR has nothing to observe, and says nothing about it.
        expect(result.out).not.toContain('observed: none yet');
    });

    it('prints each stage verification, a failed one with why', async () => {
        const report = { ...REPORT('parked'), verification: [verified('failed', 'checks on main fail: e2e failing')] };
        const result = await cli(['batch', 'report', ID], () => json(report));
        expect(result.out).toContain('stage build verification failed: checks on main fail: e2e failing');
    });

    it('prints the report itself as JSON', async () => {
        const result = await cli(['batch', 'report', ID, '--json'], () => json(REPORT('expired')));
        expect(JSON.parse(result.out).data).toEqual(REPORT('expired'));
    });

    it('is usage without a batch id', async () => {
        const result = await cli(['batch', 'report'], () => json(REPORT()));
        expect(result.code).toBe(2);
        expect(result.sent).toEqual([]);
    });
});

describe('batch retry / accept / cancel', () => {
    it('posts to the task and batch routes and surfaces the board answer', async () => {
        const retry = await cli(['batch', 'retry', ID, 'a'], () => json({ ok: true }));
        const accept = await cli(['batch', 'accept', ID, 'a'], () => json({ ok: true }));
        const cancel = await cli(['batch', 'cancel', ID], () => json({ ok: true }));
        expect(retry.sent[0]).toMatchObject({ method: 'POST', url: `http://board/api/batches/${ID}/tasks/a/retry` });
        expect(accept.sent[0]).toMatchObject({ method: 'POST', url: `http://board/api/batches/${ID}/tasks/a/accept` });
        expect(cancel.sent[0]).toMatchObject({ method: 'POST', url: `http://board/api/batches/${ID}/cancel` });
        expect([retry.code, accept.code, cancel.code]).toEqual([0, 0, 0]);
    });

    it('surfaces the board refusing an unavailable operation or a forced code-changing completion', async () => {
        const unsupported = await cli(['batch', 'cancel', ID], () =>
            json({ error: 'Batch cancel is not available yet', code: 'BATCH_UNSUPPORTED' }, 409)
        );
        expect(unsupported.code).toBe(1);
        expect(unsupported.err).toContain('BATCH_UNSUPPORTED');
        const noTask = await cli(['batch', 'accept', ID, 'zzz'], () =>
            json({ error: 'No such task', code: 'NOT_FOUND' }, 404)
        );
        expect(noTask.code).toBe(1);
        expect(noTask.sent).toHaveLength(1);
    });
});
