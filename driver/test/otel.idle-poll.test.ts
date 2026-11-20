import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, diag, logs, metrics, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Board, type BoardJob, createBoard } from '../src/board/board.js';
import { createDriverMetrics } from '../src/driver-metrics.js';
import { withClaimSpan, withLifecycleSpan } from '../src/lifecycle-span.js';
import { startOtel, type Otel } from '../src/otel.js';
import { countOf, metricsHarness } from './helpers-metrics.js';

interface OtlpSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: number;
    status?: { code?: number; message?: string };
    attributes: { key: string; value: Record<string, string | number | boolean> }[];
}

const STATUS_ERROR = 2;
const SPAN_KIND_CLIENT = 3;
const POLLS = 'bellows.driver.claim.polls';

const WIRE = {
    id: 'job-1',
    command: 'echo hi',
    attempts: 1,
    claimSeq: 7,
    leaseToken: 'lease-1',
    ingestToken: 'ingest-1',
    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
};

const bodyOf = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });

const listen = (server: ReturnType<typeof createServer>) =>
    new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
    );

const attr = (span: OtlpSpan, key: string) => Object.values(span.attributes.find((a) => a.key === key)?.value ?? {})[0];

describe('driver claim polls over a real SDK, a loopback board and a loopback collector', () => {
    const exported: string[] = [];
    const collector = createServer((request, response) => {
        void bodyOf(request).then((body) => {
            if (request.url === '/v1/traces') exported.push(body);
            response.setHeader('content-type', 'application/json').end('{}');
        });
    });
    /** The next answer per path, and the `traceparent` each request carried. */
    const answers: Record<string, { status: number; body?: unknown }> = {};
    const traceparents: Record<string, string[]> = {};
    const fakeBoard = createServer((request, response) => {
        void bodyOf(request).then(() => {
            const path = request.url ?? '';
            traceparents[path] = [...(traceparents[path] ?? []), String(request.headers.traceparent ?? '')];
            const answer = answers[path] ?? { status: 200, body: {} };
            response.statusCode = answer.status;
            if (answer.body === undefined) response.end();
            else response.setHeader('content-type', 'application/json').end(JSON.stringify(answer.body));
        });
    });
    const harness = metricsHarness();
    let otel: Otel;
    let board: Board;
    let spans: OtlpSpan[] = [];
    /** The trace id each scenario's claim ran under, read inside the span. */
    const traces: Record<string, string> = {};
    let claimed: BoardJob | null = null;
    let claimedTraceparent = '';
    let thrown: unknown;

    const poll =
        <T>(scenario: string, call: () => Promise<T>) =>
        async (): Promise<T> => {
            traces[scenario] = trace.getActiveSpan()?.spanContext().traceId ?? '';
            return call();
        };

    beforeAll(async () => {
        const collectorUrl = await listen(collector);
        const boardUrl = await listen(fakeBoard);
        Object.assign(process.env, {
            OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl,
            OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
            OTEL_METRICS_EXPORTER: 'none',
        });
        otel = startOtel(process.env)!;
        const driverMetrics = createDriverMetrics({ boardUrl, meter: harness.meter });
        board = createBoard({
            url: boardUrl,
            leaseSeconds: 60,
            fetch: driverMetrics.fetch,
            onMalformedClaim: () => undefined,
            onPoll: driverMetrics.claimPoll,
        });

        answers['/api/jobs/claim'] = { status: 204 };
        await withClaimSpan(
            'claim',
            'docker',
            poll('idle', () => board.claim('w'))
        );

        answers['/api/jobs/claim'] = { status: 200, body: WIRE };
        claimed = await withClaimSpan(
            'claim',
            'kubernetes',
            poll('claimed', () => board.claim('w'))
        );
        claimedTraceparent = traceparents['/api/jobs/claim']!.at(-1)!;

        answers['/api/jobs/claim'] = { status: 200, body: { id: 'job-2' } };
        await withClaimSpan(
            'claim',
            'docker',
            poll('malformed', () => board.claim('w'))
        );

        answers['/api/jobs/claim'] = { status: 500, body: { error: 'down' } };
        await withClaimSpan(
            'claim',
            'docker',
            poll('error', () => board.claim('w'))
        ).catch((e: unknown) => {
            thrown = e;
        });

        answers['/api/reclaims/claim'] = { status: 204 };
        await withClaimSpan(
            'reclaim.claim',
            'docker',
            poll('reclaim', () => board.claimReclaim('w'))
        );

        await withLifecycleSpan(
            'gate',
            { 'bellows.job.id': WIRE.id, 'bellows.claim.seq': WIRE.claimSeq, 'bellows.executor': 'docker' },
            poll('gate', () => board.heartbeat(claimed!))
        );

        await otel.shutdown();
        spans = exported.flatMap((body) =>
            (JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] }).resourceSpans.flatMap(
                (r) => r.scopeSpans.flatMap((s) => s.spans)
            )
        );
    });

    afterAll(() => {
        collector.close();
        fakeBoard.close();
        for (const api of [trace, logs, metrics, context, diag]) api.disable();
    });

    const inTrace = (scenario: string) => spans.filter((s) => s.traceId === traces[scenario]);

    it('exports no span for an idle job claim and counts it idle', async () => {
        expect(traces.idle).toMatch(/^[0-9a-f]{32}$/);
        expect(inTrace('idle')).toEqual([]);
        expect(countOf(await harness.points(POLLS), { outcome: 'idle' })).toBe(1);
    });

    it('exports a claimed poll with the job attributes and joins the board by traceparent', async () => {
        expect(claimed?.id).toBe(WIRE.id);
        const claim = inTrace('claimed').find((s) => s.name === 'claim');
        expect(claim).toBeDefined();
        expect(attr(claim!, 'bellows.job.id')).toBe(WIRE.id);
        expect(Number(attr(claim!, 'bellows.claim.seq'))).toBe(WIRE.claimSeq);
        expect(attr(claim!, 'bellows.executor')).toBe('kubernetes');
        expect(claim!.parentSpanId ?? '').toBe('');
        const client = inTrace('claimed').find((s) => s.kind === SPAN_KIND_CLIENT && s.parentSpanId === claim!.spanId);
        expect(client).toBeDefined();
        expect(claimedTraceparent).toBe(`00-${claim!.traceId}-${client!.spanId}-01`);
        expect(countOf(await harness.points(POLLS), { outcome: 'claimed' })).toBe(1);
    });

    it('keeps a malformed claim as an ERROR span with no message, never idle', async () => {
        const claim = inTrace('malformed').find((s) => s.name === 'claim');
        expect(claim?.status?.code).toBe(STATUS_ERROR);
        expect(claim?.status?.message ?? '').toBe('');
        expect(attr(claim!, 'bellows.poll.idle')).toBeUndefined();
        expect(countOf(await harness.points(POLLS), { outcome: 'malformed' })).toBe(1);
    });

    it('keeps a failed claim as an ERROR span, rethrows, and counts it error', async () => {
        expect(thrown).toBeInstanceOf(Error);
        const claim = inTrace('error').find((s) => s.name === 'claim');
        expect(claim?.status?.code).toBe(STATUS_ERROR);
        expect(claim?.status?.message ?? '').toBe('');
        expect(countOf(await harness.points(POLLS), { outcome: 'error' })).toBe(1);
    });

    it('exports no span for an idle reclaim claim', () => {
        expect(traces.reclaim).toMatch(/^[0-9a-f]{32}$/);
        expect(inTrace('reclaim')).toEqual([]);
    });

    it('carries the step span trace id on a board call made inside it', () => {
        const step = inTrace('gate').find((s) => s.name === 'gate');
        expect(step).toBeDefined();
        expect(step!.parentSpanId ?? '').toBe('');
        expect(traceparents['/api/jobs/job-1/heartbeat']![0]).toMatch(new RegExp(`^00-${traces.gate}-`));
    });
});
