/**
 * The driver's lifecycle spans (docs/observability.md): one span per step of an attempt — provision, adopt, gate,
 * publish, settle — each its own trace root naming the job, this claim's sequence and the executor; a reaper sweep
 * with a child span per group it actually reaps, which names no claim sequence and no lease token; and a drain's
 * handover. No span covers a whole task.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { describe, expect, it } from 'vitest';
import type { BoardLease } from '../src/board/board.js';
import { handoverOf } from '../src/loop/loop.js';
import { createReaper, type OrphanGroup, type ReaperArm } from '../src/reaper.js';
import { captureSpans, runGatedPublish } from './fixtures/lifecycle-spans.js';
import { job, ok, stubBoard, stubRunner, stubRuntime } from './fixtures/loop-stubs.js';

const spans = captureSpans();

const STEPS = ['provision', 'adopt', 'gate', 'publish', 'settle'] as const;
const named = (name: string): ReadableSpan[] => spans.getFinishedSpans().filter((span) => span.name === name);

describe.each(['docker', 'kubernetes'] as const)('the lifecycle spans of one attempt under %s', (executor) => {
    it('opens each step once, a trace root naming the job, this claim and the executor', async () => {
        const { claimed } = await runGatedPublish(executor);
        const attempt = {
            'bellows.job.id': claimed.id,
            'bellows.claim.seq': claimed.claimSeq,
            'bellows.executor': executor,
        };

        const claims = named('claim').filter((span) => span.attributes['bellows.job.id'] !== undefined);
        expect(claims).toHaveLength(1);
        expect(claims[0]!.attributes).toMatchObject(attempt);
        for (const step of STEPS) {
            const opened = named(step);
            expect(opened, step).toHaveLength(1);
            expect(opened[0]!.attributes, step).toMatchObject(attempt);
            expect(opened[0]!.parentSpanContext, step).toBeUndefined();
            expect(opened[0]!.status.code, step).not.toBe(SpanStatusCode.ERROR);
        }
        expect(named('settle')[0]!.attributes['bellows.settle.kind']).toBe('verdict');
        // Nothing spans the task: every span is a claim poll or one step.
        expect(new Set(spans.getFinishedSpans().map((span) => span.name))).toEqual(
            new Set(['claim', 'reclaim.claim', ...STEPS])
        );
    });

    it('ends a gate that threw ERROR, exactly once, with no message', async () => {
        await runGatedPublish(executor, { gateLost: true });

        const gates = named('gate');
        expect(gates).toHaveLength(1);
        expect(gates[0]!.status).toEqual({ code: SpanStatusCode.ERROR });
        expect(gates[0]!.events).toEqual([]);
        expect(named('publish')).toHaveLength(0);
        const settles = named('settle');
        expect(settles).toHaveLength(1);
        expect(settles[0]!.attributes['bellows.settle.kind']).toBe('interrupt');
    });
});

const GONE = '0000000a-1111-4111-8111-111111111111';
const SPARED = '0000000b-1111-4111-8111-111111111111';
const LIVE = '0000000c-1111-4111-8111-111111111111';
const LEASE = (n: string) => `0000000${n}-2222-4222-8222-222222222222`;

const groups: OrphanGroup[] = [
    { jobId: GONE, leaseToken: LEASE('a'), createdAtMs: 0, objects: [{ kind: 'container', name: 'gone-runner' }] },
    {
        jobId: SPARED,
        leaseToken: LEASE('b'),
        createdAtMs: 0,
        objects: [{ kind: 'container', name: 'spared-runner', runner: true }],
    },
    { jobId: LIVE, leaseToken: LEASE('c'), createdAtMs: 0, objects: [{ kind: 'container', name: 'live-runner' }] },
];
// The gone job is unknown to the board; the spared one is live under another lease; the live one holds its own.
const leases: BoardLease[] = [
    { id: SPARED, status: 'running', leaseToken: LEASE('d') },
    { id: LIVE, status: 'running', leaseToken: LEASE('c') },
];

function sweepWith(reap: ReaperArm['reap']) {
    return createReaper({
        board: { leases: async () => leases },
        arm: { scan: async () => groups, reap },
        executor: 'kubernetes',
        intervalMs: 0,
        graceMs: 0,
        now: () => 1_000_000,
        log: () => {},
    }).sweep();
}

describe('the reaper spans', () => {
    it('opens one sweep root and one reap child for the one group it reaps, naming no claim and no lease', async () => {
        await sweepWith(async (group) => [`container ${group.jobId}`]);

        const sweeps = named('reap.sweep');
        expect(sweeps).toHaveLength(1);
        expect(sweeps[0]!.parentSpanContext).toBeUndefined();
        expect(sweeps[0]!.attributes).toEqual({ 'bellows.executor': 'kubernetes', 'bellows.reap.outcome': 'ok' });
        const reaps = named('reap');
        expect(reaps).toHaveLength(1);
        expect(reaps[0]!.attributes).toEqual({
            'bellows.job.id': GONE,
            'bellows.executor': 'kubernetes',
            'bellows.reap.verdict': 'gone',
        });
        expect(reaps[0]!.parentSpanContext?.spanId).toBe(sweeps[0]!.spanContext().spanId);
        expect(reaps[0]!.spanContext().traceId).toBe(sweeps[0]!.spanContext().traceId);
        expect(reaps[0]!.status.code).not.toBe(SpanStatusCode.ERROR);
        const values = spans.getFinishedSpans().flatMap((span) => Object.values(span.attributes));
        for (const group of groups) expect(values).not.toContain(group.leaseToken);
    });

    it('ends a reap whose cleanup is unconfirmed ERROR, and the sweep aborted', async () => {
        await sweepWith(async () => ({ removed: [], inconclusive: 'a read proved nothing' }));

        const reaps = named('reap');
        expect(reaps).toHaveLength(1);
        expect(reaps[0]!.status).toEqual({ code: SpanStatusCode.ERROR });
        expect(named('reap.sweep')[0]!.attributes['bellows.reap.outcome']).toBe('aborted');
    });

    it('ends a reap that threw ERROR, and the sweep error', async () => {
        await sweepWith(async () => {
            throw new Error('the delete was refused');
        });

        expect(named('reap')[0]!.status).toEqual({ code: SpanStatusCode.ERROR });
        const sweep = named('reap.sweep')[0]!;
        expect(sweep.attributes['bellows.reap.outcome']).toBe('error');
        expect(sweep.status).toEqual({ code: SpanStatusCode.ERROR });
    });
});

describe('the handover span', () => {
    it('opens one driver-wide span counting the attempts it handed over', async () => {
        const rt = stubRuntime(
            stubBoard([job(1)]).board,
            stubRunner(async () => ok())
        );

        await handoverOf(rt).run('x');

        const handovers = named('handover');
        expect(handovers).toHaveLength(1);
        expect(handovers[0]!.parentSpanContext).toBeUndefined();
        expect(handovers[0]!.attributes).toEqual({
            'bellows.executor': rt.config.executor,
            'bellows.handover.attempts': 0,
        });
    });
});
