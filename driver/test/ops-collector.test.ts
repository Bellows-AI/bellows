import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readRepoFile as read } from './fixtures/repo-files.js';

const CONFIG = 'charts/factory/files/ops-collector.yaml';
const DEBUG = 'charts/factory/files/ops-collector-debug.yaml';

type Pipeline = { receivers?: string[]; processors?: string[]; exporters?: string[] };
type Config = {
    receivers: {
        otlp: { protocols: Record<string, { endpoint: string }> };
        prometheus: { config: { scrape_configs: { static_configs: { targets: string[] }[] }[] } };
    };
    processors: { tail_sampling: { policies: { type: string; [key: string]: unknown }[] } };
    exporters: { otlp_http: { endpoint: string; headers: string } };
    service: {
        pipelines: Record<string, Pipeline>;
        telemetry: { metrics: { readers: { pull: { exporter: { prometheus: { host: string; port: number } } } }[] } };
    };
};

const config = parse(read(CONFIG)) as Config;

describe('the ops collector config shared by the chart and compose', () => {
    it('receives OTLP over HTTP on 4318 only', () => {
        expect(config.receivers.otlp.protocols.http.endpoint).toBe('0.0.0.0:4318');
        expect(config.receivers.otlp.protocols).not.toHaveProperty('grpc');
    });

    it('runs traces through memory_limiter, batch, tail_sampling in that order', () => {
        expect(config.service.pipelines.traces.processors).toEqual(['memory_limiter', 'batch', 'tail_sampling']);
    });

    it('tail-samples errors, slow traces and a share of the rest', () => {
        const policies = config.processors.tail_sampling.policies;
        expect(policies.map((policy) => policy.type)).toEqual(['status_code', 'latency', 'probabilistic']);
        expect(policies[0]).toMatchObject({ status_code: { status_codes: ['ERROR'] } });
        expect(policies[1]).toMatchObject({ latency: { threshold_ms: '${env:OPS_LATENCY_THRESHOLD_MS}' } });
        expect(policies[2]).toMatchObject({ probabilistic: { sampling_percentage: '${env:OPS_TAIL_PERCENT}' } });
    });

    it('exports every pipeline to the backend and nowhere else', () => {
        for (const pipeline of Object.values(config.service.pipelines)) {
            expect(pipeline.exporters).toEqual(['otlp_http']);
        }
        expect(config.exporters.otlp_http.endpoint).toBe('${env:OPS_BACKEND_ENDPOINT}');
        expect(config.exporters.otlp_http.headers).toBe('${env:OPS_BACKEND_HEADERS}');
        // The header comment names these on purpose (why the file never uses them): pin the config.
        const text = read(CONFIG).replace(/^\s*#.*$/gm, '');
        for (const forbidden of ['/api/otlp', 'dashboard', 'headers_setter', '{{']) {
            expect(text).not.toContain(forbidden);
        }
    });

    it("sends the collector's own metrics to the backend", () => {
        const scrape = config.receivers.prometheus.config.scrape_configs[0].static_configs[0];
        expect(scrape.targets).toEqual(['127.0.0.1:8888']);
        expect(config.service.pipelines.metrics.receivers).toContain('prometheus');
        const reader = config.service.telemetry.metrics.readers[0].pull.exporter.prometheus;
        expect(reader).toEqual({ host: '127.0.0.1', port: 8888 });
    });

    it('adds a file exporter to traces only in the debug overlay', () => {
        const overlay = parse(read(DEBUG)) as {
            exporters: Record<string, unknown>;
            service: { pipelines: Record<string, Pipeline> };
        };
        expect(Object.keys(overlay)).toEqual(['exporters', 'service']);
        expect(Object.keys(overlay.exporters)).toEqual(['file']);
        expect(Object.keys(overlay.service.pipelines)).toEqual(['traces']);
        expect(overlay.service.pipelines.traces.exporters).toEqual(['otlp_http', 'file']);
    });
});
