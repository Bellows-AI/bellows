import { describe, expect, it } from 'vitest';
import {
    buildRunActivity,
    gateActivityOf,
    pickBucketMs,
    prActivityOf,
    type ActivityRecords,
    type GateRunRecord,
    type PrOperationRecord,
    type ToolEventRecord,
} from '../src/telemetry/run-activity.js';
import { mergeCalls, type EventRow } from '../src/db/jobs/job-store-activity-records.js';
import { activityWorld, minute } from './helpers-activity.js';

/**
 * The run-activity bucketing (issues #339, #847): a run's ALREADY-assigned contributions placed into
 * buckets over the run's segment span. Temporality, ownership and run assignment are core's
 * (core/test/usage-reduce.test.ts, token-contributions tests); what is pinned here is that the
 * buckets add back to the run's usage and that an unmeasured type is never drawn as zero.
 */

const NOW = new Date(minute(60));
const FIFTEEN_MIN = 900_000;

describe('pickBucketMs', () => {
    it('picks the smallest bucket width that keeps the chart at 16 bars or fewer', () => {
        // A 2h run → 15-minute buckets, 8 of them — the issue's own example.
        expect(pickBucketMs(7_200_000)).toBe(FIFTEEN_MIN);
        expect(pickBucketMs(30 * 60_000)).toBe(300_000);
        expect(pickBucketMs(5 * 60_000)).toBe(60_000);
    });

    it('caps at the hour width for runs too long for the ladder', () => {
        expect(pickBucketMs(20 * 3_600_000)).toBe(3_600_000);
    });
});

describe('buildRunActivity', () => {
    it('places each assigned amount in the bucket that holds its instant', () => {
        const { ids, facts } = activityWorld();
        const { run } = buildRunActivity(facts, ids.task, ids.task, NOW);

        expect(run?.bucketMs).toBe(60_000);
        expect(run?.buckets).toHaveLength(10);
        expect(run?.buckets[5]?.tokens).toEqual({ input: 7, output: 100, cacheRead: null, cacheCreation: null });
        expect(run?.buckets[5]?.edits).toBe(3);
        expect(run?.buckets[4]?.tokens.output).toBe(0);
    });

    it('draws a run of the same shared session only from its own segment, not the gap or the other run', () => {
        const { ids, facts } = activityWorld();
        const { run } = buildRunActivity(facts, ids.task, ids.followUp, NOW);

        expect([run?.from, run?.to]).toEqual([minute(12), minute(20)]);
        expect(run?.usage.tokens.output).toBe(60);
        expect(run?.buckets.map((b) => b.tokens.output)).toEqual([0, 0, 0, 60, 0, 0, 0, 0]);
    });

    it('runs an open claim to now', () => {
        const { ids, facts } = activityWorld();
        const open = {
            ...facts,
            board: facts.board.map((e) => (e.jobId === ids.task ? { ...e, endedAt: null, live: true } : e)),
        };
        const { run } = buildRunActivity(open, ids.task, ids.task, NOW);

        expect(run?.to).toBe(NOW.toISOString());
    });

    it('answers no buckets for a run that measured nothing, and no run for a job outside the task', () => {
        const { ids, facts } = activityWorld();
        const quiet = { ...facts, contributions: [], edits: [] };

        const idle = buildRunActivity(quiet, ids.task, ids.task, NOW);
        expect(idle.run?.buckets).toEqual([]);
        expect(idle.run?.usage.state).toBe('unmeasured');
        expect(buildRunActivity(facts, ids.task, 'not-a-run', NOW)).toMatchObject({ run: null });
        expect(buildRunActivity(facts, 'no-such-task', ids.task, NOW)).toEqual({ task: null, run: null });
    });
});

/**
 * The gate and PR halves of the activity read (issue #983 S4): what the board recorded (`job_gate_run`,
 * `job_pr_operation`) and what the transcript confirmed (`transcript_tool_event`), reduced per run and
 * per task. An execution counts once however many records name it, and a figure nobody measured is
 * null or `partial`, never a zero.
 */
const JOB = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const exec = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const gateRun = (over: Partial<GateRunRecord> & Pick<GateRunRecord, 'executionId'>): GateRunRecord => ({
    jobId: JOB,
    gate: 'test',
    source: 'adhoc',
    filtered: false,
    outcome: 'passed',
    startedAt: minute(1),
    finishedAt: minute(2),
    ...over,
});
const toolEvent = (over: Partial<ToolEventRecord> & Pick<ToolEventRecord, 'callId'>): ToolEventRecord => ({
    jobId: JOB,
    kind: 'gate',
    operation: 'run',
    outcome: 'passed',
    executionId: null,
    operationId: null,
    prRepo: null,
    prNumber: null,
    prUrl: null,
    startedAt: null,
    endedAt: null,
    ...over,
});
const prOp = (over: Partial<PrOperationRecord> & Pick<PrOperationRecord, 'operationId'>): PrOperationRecord => ({
    jobId: JOB,
    operation: 'created',
    repo: 'acme/web',
    prNumber: 7,
    prUrl: 'https://github.com/acme/web/pull/7',
    ...over,
});
const records = (over: Partial<ActivityRecords> = {}): ActivityRecords => ({
    gateRuns: [],
    reusedGates: [],
    prOperations: [],
    toolEvents: [],
    ...over,
});

describe('gateActivityOf', () => {
    it('counts executions by outcome and sums the measured duration', () => {
        const out = gateActivityOf(
            records({
                gateRuns: [
                    gateRun({ executionId: exec(1) }),
                    gateRun({ executionId: exec(2), outcome: 'failed', startedAt: minute(3), finishedAt: minute(5) }),
                    gateRun({ executionId: exec(3), source: 'completion' }),
                ],
            }),
            [JOB]
        );
        expect(out.executions).toBe(3);
        expect(out.byOutcome).toMatchObject({ passed: 2, failed: 1 });
        expect(out.measuredMs).toBe(60_000 + 120_000 + 60_000);
        expect(out).toMatchObject({ measuredCount: 3, unmeasuredCount: 0, coverage: 'complete' });
    });

    it('counts an execution once when completion reused it and a transcript event names it too', () => {
        const out = gateActivityOf(
            records({
                gateRuns: [gateRun({ executionId: exec(1) })],
                reusedGates: [
                    { jobId: JOB, gate: 'test', executionId: exec(1), finishedAt: minute(2), reason: 'tree unchanged' },
                ],
                toolEvents: [toolEvent({ callId: 'c1', executionId: exec(1) })],
            }),
            [JOB]
        );
        expect(out.executions).toBe(1);
        expect(out.reused).toEqual([
            { jobId: JOB, gate: 'test', executionId: exec(1), finishedAt: minute(2), reason: 'tree unchanged' },
        ]);
        expect(out.observed).toMatchObject({ executions: 0 });
    });

    it('keeps a transcript-only gate run apart as observed agent activity, once per execution id', () => {
        const out = gateActivityOf(
            records({
                gateRuns: [gateRun({ executionId: exec(1) })],
                toolEvents: [
                    toolEvent({ callId: 'a', executionId: exec(9), outcome: 'failed' }),
                    toolEvent({ callId: 'b', executionId: exec(9), outcome: 'failed' }),
                    toolEvent({ callId: 'c', outcome: 'unknown' }),
                ],
            }),
            [JOB]
        );
        expect(out.executions).toBe(1);
        expect(out.observed).toMatchObject({ executions: 2, byOutcome: { failed: 1, unknown: 1 } });
        expect(out.coverage).toBe('partial');
    });

    it('leaves the duration null and the coverage partial when no timing was recorded', () => {
        const out = gateActivityOf(
            records({ gateRuns: [gateRun({ executionId: exec(1), startedAt: null, finishedAt: null })] }),
            [JOB]
        );
        expect(out).toMatchObject({ measuredMs: null, measuredCount: 0, unmeasuredCount: 1, coverage: 'partial' });
    });

    it('takes the timing of an execution from its transcript event when the record has none', () => {
        const out = gateActivityOf(
            records({
                gateRuns: [gateRun({ executionId: exec(1), startedAt: null, finishedAt: null })],
                toolEvents: [
                    toolEvent({ callId: 'c', executionId: exec(1), startedAt: minute(1), endedAt: minute(4) }),
                ],
            }),
            [JOB]
        );
        expect(out).toMatchObject({ measuredMs: 180_000, measuredCount: 1, unmeasuredCount: 0 });
    });

    it('answers null, not zero, when nothing was recorded', () => {
        expect(gateActivityOf(records(), [JOB])).toMatchObject({
            coverage: null,
            executions: null,
            byOutcome: null,
            measuredMs: null,
            observed: null,
            reused: [],
        });
    });

    it('reads only the named jobs, so a run and its task differ', () => {
        const all = records({
            gateRuns: [gateRun({ executionId: exec(1) }), gateRun({ executionId: exec(2), jobId: OTHER })],
        });
        expect(gateActivityOf(all, [JOB]).executions).toBe(1);
        expect(gateActivityOf(all, [JOB, OTHER]).executions).toBe(2);
    });
});

describe('prActivityOf', () => {
    it('counts operations apart from the distinct PRs they touched', () => {
        const out = prActivityOf(
            records({
                prOperations: [
                    prOp({ operationId: exec(1) }),
                    prOp({ operationId: exec(2), operation: 'reused' }),
                    prOp({ operationId: exec(3), prNumber: 8, prUrl: 'https://github.com/acme/web/pull/8' }),
                ],
            }),
            [JOB]
        );
        expect(out.counts).toEqual({ operations: 3, distinct: 2 });
        expect(out.operations.map((o) => o.kind)).toEqual(['created', 'reused', 'created']);
        expect(out.distinct).toEqual([
            { repo: 'acme/web', number: 7, url: 'https://github.com/acme/web/pull/7' },
            { repo: 'acme/web', number: 8, url: 'https://github.com/acme/web/pull/8' },
        ]);
        expect(out.coverage).toBe('complete');
    });

    it('adds an agent-created PR from a confirmed transcript create, and never double counts a linked publish', () => {
        const out = prActivityOf(
            records({
                prOperations: [prOp({ operationId: exec(1) })],
                toolEvents: [
                    toolEvent({
                        callId: 'p1',
                        kind: 'pr',
                        operation: 'publish',
                        operationId: exec(1),
                        prRepo: 'acme/web',
                        prNumber: 7,
                        prUrl: 'https://github.com/acme/web/pull/7',
                    }),
                    toolEvent({
                        callId: 'p2',
                        kind: 'pr',
                        operation: 'create',
                        prRepo: 'acme/web',
                        prNumber: 9,
                        prUrl: 'https://github.com/acme/web/pull/9',
                    }),
                ],
            }),
            [JOB]
        );
        expect(out.counts).toEqual({ operations: 2, distinct: 2 });
        expect(out.operations.map((o) => [o.kind, o.number])).toEqual([
            ['created', 7],
            ['agent_created', 9],
        ]);
    });

    it('marks an unconfirmed transcript PR call as partial coverage, without counting a PR', () => {
        const out = prActivityOf(
            records({ toolEvents: [toolEvent({ callId: 'p', kind: 'pr', operation: 'create', outcome: 'unknown' })] }),
            [JOB]
        );
        expect(out).toMatchObject({ coverage: 'partial', counts: { operations: 0, distinct: 0 } });
    });

    it('keeps a confirmed publish whose managed operation row is missing: the PR and its link count, the kind is unknown, coverage partial', () => {
        const out = prActivityOf(
            records({
                toolEvents: [
                    toolEvent({
                        callId: 'p1',
                        kind: 'pr',
                        operation: 'publish',
                        operationId: exec(1),
                        prRepo: 'acme/web',
                        prNumber: 7,
                        prUrl: 'https://github.com/acme/web/pull/7',
                    }),
                ],
            }),
            [JOB]
        );
        expect(out.coverage).toBe('partial');
        expect(out.counts).toEqual({ operations: 1, distinct: 1 });
        expect(out.operations.map((o) => [o.kind, o.number])).toEqual([['unknown', 7]]);
        expect(out.distinct).toEqual([{ repo: 'acme/web', number: 7, url: 'https://github.com/acme/web/pull/7' }]);
    });

    it('is partial, not complete, when a confirmed PR call carries no link to count', () => {
        const out = prActivityOf(
            records({ toolEvents: [toolEvent({ callId: 'p', kind: 'pr', operation: 'create', outcome: 'passed' })] }),
            [JOB]
        );
        expect(out).toMatchObject({ coverage: 'partial', counts: { operations: 0, distinct: 0 } });
    });

    it('reads an unknown PR call beside a managed operation as partial coverage', () => {
        const out = prActivityOf(
            records({
                prOperations: [prOp({ operationId: exec(1) })],
                toolEvents: [toolEvent({ callId: 'p', kind: 'pr', operation: 'create', outcome: 'unknown' })],
            }),
            [JOB]
        );
        expect(out).toMatchObject({ coverage: 'partial', counts: { operations: 1, distinct: 1 } });
    });

    it('answers null counts when nothing was recorded', () => {
        expect(prActivityOf(records(), [JOB])).toEqual({ coverage: null, counts: null, operations: [], distinct: [] });
    });
});

describe('mergeCalls', () => {
    const row = (over: Partial<EventRow>): EventRow => ({
        job_id: JOB,
        executor: 'claude',
        session_id: 's1',
        tool_call_id: 'c1',
        part: 'call',
        kind: 'gate',
        operation: 'run',
        outcome: null,
        execution_id: null,
        operation_id: null,
        pr_repo: null,
        pr_number: null,
        pr_url: null,
        started_at: new Date(minute(1)),
        ended_at: null,
        ...over,
    });

    it('keeps a call with no result as an unknown observation, never dropping it', () => {
        const [gate, pr] = mergeCalls([
            row({ tool_call_id: 'g' }),
            row({ tool_call_id: 'p', kind: 'pr', operation: 'create' }),
        ]);
        expect(gate).toMatchObject({ kind: 'gate', outcome: 'unknown', executionId: null });
        expect(pr).toMatchObject({ kind: 'pr', operation: 'create', outcome: 'unknown', prUrl: null });
    });

    it('drives both reducers to partial coverage with one unknown beside successful records', () => {
        const toolEvents = mergeCalls([
            row({ tool_call_id: 'g' }),
            row({ tool_call_id: 'p', kind: 'pr', operation: 'create' }),
        ]);
        const gates = gateActivityOf(records({ gateRuns: [gateRun({ executionId: exec(1) })], toolEvents }), [JOB]);
        expect(gates.coverage).toBe('partial');
        expect(gates.observed).toMatchObject({ executions: 1, byOutcome: { unknown: 1 } });
        const prs = prActivityOf(records({ prOperations: [prOp({ operationId: exec(2) })], toolEvents }), [JOB]);
        expect(prs.coverage).toBe('partial');
        expect(prs.counts).toEqual({ operations: 1, distinct: 1 });
    });
});
