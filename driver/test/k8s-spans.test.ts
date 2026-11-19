import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDriverMetrics } from '../src/driver-metrics.js';
import type { K8sRequest } from '../src/k8s/k8s-transport.js';
import { metricsHarness } from './helpers-metrics.js';

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

beforeAll(() => trace.setGlobalTracerProvider(provider));
beforeEach(() => exporter.reset());
afterAll(async () => {
    trace.disable();
    await provider.shutdown();
});

const metrics = () => createDriverMetrics({ boardUrl: 'http://board:8080', meter: metricsHarness().meter });

describe('the kubernetes request wrapper, as spans', () => {
    it('makes one CLIENT span named for the closed verb and resource, carrying no path, name or namespace', async () => {
        const request: K8sRequest = async () => ({ status: 404, body: '{}' });
        await metrics().k8s(request, 'runner')(
            'GET',
            '/api/v1/namespaces/team-ns/pods/secret-pod-name/log?tailLines=5'
        );
        const [span] = exporter.getFinishedSpans();
        expect(exporter.getFinishedSpans()).toHaveLength(1);
        expect(span!.name).toBe('k8s get pods/log');
        expect(span!.kind).toBe(SpanKind.CLIENT);
        expect(span!.attributes).toEqual({
            'k8s.verb': 'get',
            'k8s.resource': 'pods/log',
            'http.response.status_code': 404,
        });
        expect(JSON.stringify([span!.name, span!.attributes])).not.toMatch(/team-ns|secret-pod-name/);
    });

    it('ends the span once, in error, and rethrows the very same error', async () => {
        const failure = new Error('socket hang up');
        const request: K8sRequest = async () => {
            throw failure;
        };
        await expect(metrics().k8s(request, 'reaper')('DELETE', '/api/v1/namespaces/ns/pods/p-1')).rejects.toBe(
            failure
        );
        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
        expect(spans[0]!.name).toBe('k8s delete pods');
    });

    it('does not reclassify an answer: a 5xx body is handed back as it came, the span stays unset', async () => {
        const reply = { status: 503, body: 'not json' };
        expect(await metrics().k8s(async () => reply, 'runner')('GET', '/api/v1/namespaces/ns/pods')).toBe(reply);
        expect(exporter.getFinishedSpans()[0]!.status.code).toBe(SpanStatusCode.UNSET);
    });
});

describe('the docker exec wrapper, as spans', () => {
    it('makes a CLIENT span per command with the closed command only', async () => {
        await metrics().docker(async () => ({ stdout: '' }), 'runner')(['rm', '-f', 'factory-job-secret']);
        const [span] = exporter.getFinishedSpans();
        expect(span!.name).toBe('docker rm');
        expect(span!.kind).toBe(SpanKind.CLIENT);
        expect(span!.attributes).toEqual({ 'docker.command': 'rm' });
    });

    it('ends in error and rethrows a failed command', async () => {
        const failure = new Error('exit 1');
        await expect(
            metrics().docker(async () => {
                throw failure;
            }, 'runner')(['ps'])
        ).rejects.toBe(failure);
        expect(exporter.getFinishedSpans()[0]!.status.code).toBe(SpanStatusCode.ERROR);
    });
});
