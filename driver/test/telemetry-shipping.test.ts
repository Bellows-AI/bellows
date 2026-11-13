import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
    claudeManagedSettings,
    opencodeOtelConfig,
    telemetryConfig,
    telemetryConfigTar,
    telemetryCopyTarget,
} from '../src/telemetry-config.js';
import { readRepoFile as read } from './fixtures/repo-files.js';

/** The attempt's export credential: its job id and the ingest token its claim carries. */
const CREDENTIAL = { jobId: 'job-1', ingestToken: 'ingest-1' };

describe('runner telemetry shipping', () => {
    // The driver's copy of the baked managed settings (it may not import from docker/): the file
    // it delivers root-owned to every claude-code runner must be the baked one with only the
    // endpoint swapped and the attempt's credential added, or a rendered run would ship a
    // different telemetry policy than the image.
    it('renders the baked claude managed settings with only the endpoint and the credential headers changed', () => {
        const baked = JSON.parse(read('docker/claude-executor/managed-settings.json')) as {
            env: Record<string, string>;
        };
        expect(JSON.parse(claudeManagedSettings('http://otel.example:4318', CREDENTIAL))).toEqual({
            ...baked,
            env: {
                ...baked.env,
                OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.example:4318',
                OTEL_EXPORTER_OTLP_HEADERS: 'x-factory-job-id=job-1,x-factory-ingest-token=ingest-1',
            },
        });
        // Auto mode is pinned: a session left in default mode denies every unlisted command.
        expect(JSON.parse(claudeManagedSettings('http://otel.example:4318', CREDENTIAL)).permissions.defaultMode).toBe(
            'auto'
        );
    });

    // The plugin reads only otel.json (never OTEL_EXPORTER_OTLP_HEADERS) and hands its `headers`
    // to both the metric and the log exporter.
    it('renders the baked opencode otel.json with only the endpoint and the credential headers changed', () => {
        const baked = JSON.parse(read('docker/opencode-executor/otel.json')) as Record<string, string>;
        expect(JSON.parse(opencodeOtelConfig('http://otel.example:4318', CREDENTIAL))).toEqual({
            ...baked,
            endpoint: 'http://otel.example:4318',
            headers: { 'x-factory-job-id': 'job-1', 'x-factory-ingest-token': 'ingest-1' },
        });
    });

    // The baked files stay credential-free: a hand-run container has no attempt to name.
    it('bakes no credential into either image’s telemetry config', () => {
        expect(read('docker/claude-executor/managed-settings.json')).not.toContain('OTEL_EXPORTER_OTLP_HEADERS');
        expect(read('docker/opencode-executor/otel.json')).not.toContain('headers');
    });

    // Each executor's file lands where its CLI reads it: claude's managed-settings directory, and
    // the root-owned directory the opencode image's OPENCODE_OTEL_CONFIG_PATH names.
    it.each([
        ['claude-code', '/etc/claude-code', 'managed-settings.json'],
        ['opencode', '/etc/opencode-otel', 'otel.json'],
    ] as const)('places the %s telemetry config at %s/%s', (executor, dir, file) => {
        expect(telemetryConfig(executor, 'http://x:4318', CREDENTIAL)).toMatchObject({ dir, file });
    });

    // No executor, no file: the same refusal executorImage makes, never a silent pick.
    it('refuses to place a telemetry config for a task with no executor type', () => {
        expect(() => telemetryConfig(null, 'http://x:4318', CREDENTIAL)).toThrow(/no configured executor type/);
    });

    it('names the opencode config path the driver renders into', () => {
        expect(read('docker/opencode-executor/Dockerfile')).toContain(
            'ENV OPENCODE_OTEL_CONFIG_PATH=/etc/opencode-otel/otel.json\n'
        );
    });

    // `docker cp -` keeps the owner and mode the archive's header names, so the header is the
    // whole of the delivery's security: root:root and 0444, whoever runs the driver. Extracted
    // with the system tar, so a malformed header or checksum fails here, not in a runner.
    //
    // The directory rides the archive too, extracted into its parent: an image without it — a
    // custom runner image, the stubs scripts/test-jobs.sh runs — still gets a root-owned 0755 one.
    it('archives the telemetry config and its directory root-owned for docker cp into the parent', () => {
        const telemetry = telemetryConfig('claude-code', 'http://otel.example:4318', CREDENTIAL);
        expect(telemetryCopyTarget(telemetry)).toBe('/etc');
        const tar = telemetryConfigTar(telemetry);
        const field = (block: number, offset: number, width: number) =>
            tar
                .subarray(block * 512 + offset, block * 512 + offset + width)
                .toString('ascii')
                .replace(/\0.*$/s, '');
        const header = (block: number) => ({
            name: field(block, 0, 100),
            mode: Number.parseInt(field(block, 100, 8), 8),
            uid: Number.parseInt(field(block, 108, 8), 8),
            gid: Number.parseInt(field(block, 116, 8), 8),
            type: field(block, 156, 1),
        });
        expect(header(0)).toEqual({ name: 'claude-code/', mode: 0o755, uid: 0, gid: 0, type: '5' });
        expect(header(1)).toEqual({
            name: 'claude-code/managed-settings.json',
            mode: 0o444,
            uid: 0,
            gid: 0,
            type: '0',
        });
        expect(
            execFileSync('tar', ['-xOf', '-', 'claude-code/managed-settings.json'], { input: tar }).toString('utf8')
        ).toBe(claudeManagedSettings('http://otel.example:4318', CREDENTIAL));
    });

    it('configures both agents for OTLP/HTTP JSON while keeping prompt and tool bodies private', () => {
        const claude = JSON.parse(read('docker/claude-executor/managed-settings.json')) as {
            env: Record<string, string>;
        };
        const opencode = JSON.parse(read('docker/opencode-executor/otel.json')) as Record<string, string>;

        expect(claude.env).toMatchObject({
            CLAUDE_CODE_ENABLE_TELEMETRY: '1',
            OTEL_METRICS_EXPORTER: 'otlp',
            OTEL_LOGS_EXPORTER: 'otlp',
            OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
            OTEL_METRICS_INCLUDE_ACCOUNT_UUID: 'false',
            OTEL_LOG_USER_PROMPTS: '0',
            OTEL_LOG_ASSISTANT_RESPONSES: '0',
            OTEL_LOG_TOOL_DETAILS: '0',
        });
        expect(opencode).toEqual({
            endpoint: 'http://collector:4318',
            protocol: 'http/json',
            metricsTemporality: 'delta',
        });
    });

    it.each(['docker/otel-collector.yaml', 'charts/factory/files/collector.yaml'])(
        '%s preserves the loss-aware and privacy-preserving pipeline',
        (relative) => {
            const collector = read(relative);
            expect(collector).toContain('endpoint: 0.0.0.0:4318');
            expect(collector).toContain('encoding: json');
            expect(collector).toContain('compression: none');
            expect(collector).toMatch(
                /retry_on_failure:\n\s+enabled: true\n\s+initial_interval: 5s\n\s+max_elapsed_time: 300s/
            );
            // The chart's collector puts memory_limiter first (it runs under a memory limit); the
            // privacy-preserving part of the pipeline is the same on both.
            expect(collector).toMatch(
                /processors: \[(memory_limiter, )?filter\/drop-cost, attributes\/strip-identity, batch\]/
            );
            expect(collector).toMatch(/processors: \[(memory_limiter, )?attributes\/strip-identity, batch\]/);
            expect(collector).toContain('exporters: [otlp_http/dashboard]');
        }
    );

    // The board authenticates each export by the attempt that sent it, so the collector must carry
    // every request's credential headers to its dashboard hop: the receiver keeps them as client
    // metadata, the batch never mixes two attempts' points under one request, and headers_setter
    // writes them back onto the export. A shared deployment secret is gone.
    it.each(['docker/otel-collector.yaml', 'charts/factory/files/collector.yaml'])(
        '%s forwards each export’s attempt credential to the board',
        (relative) => {
            const config = parse(read(relative)) as CollectorConfig;
            const keys = ['x-factory-job-id', 'x-factory-ingest-token'];

            expect(config.receivers.otlp.protocols.http.include_metadata).toBe(true);
            expect(config.receivers.otlp.protocols.grpc.include_metadata).toBe(true);
            expect(config.processors.batch.metadata_keys).toEqual(keys);
            expect(config.extensions.headers_setter.headers).toEqual(
                keys.map((key) => ({ action: 'upsert', key, from_context: key }))
            );
            expect(config.exporters['otlp_http/dashboard']?.auth).toEqual({ authenticator: 'headers_setter' });
            expect(config.exporters['otlp_http/dashboard']?.headers).toBeUndefined();
            expect(config.service.extensions).toContain('headers_setter');
            expect(read(relative)).not.toContain('INGEST_TOKEN');
        }
    );

    it('renders the Helm collector config from the chart file, with no ingest secret in its env', () => {
        const template = read('charts/factory/templates/collector.yaml');

        expect(template).toContain('{{ tpl (.Files.Get "files/collector.yaml") . | indent 8 }}');
        expect(template).not.toContain('INGEST_TOKEN');
    });
});

interface CollectorConfig {
    receivers: { otlp: { protocols: Record<'grpc' | 'http', { include_metadata?: boolean }> } };
    processors: { batch: { metadata_keys?: string[] } };
    extensions: { headers_setter: { headers: unknown[] } };
    exporters: Record<string, { auth?: unknown; headers?: unknown }>;
    service: { extensions?: string[] };
}
