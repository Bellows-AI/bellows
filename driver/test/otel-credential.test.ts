import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = createRequire(import.meta.url)('../../docker/opencode-executor/otel-credential.cjs') as {
    parseHeaders: (list: string) => Record<string, string>;
    writeCopy: (env: Record<string, string | undefined>) => string | null;
};

const HEADERS = 'x-factory-job-id=job-1,x-factory-ingest-token=ingest-1';

/** A HOME and a root-owned-style otel.json, as the driver renders it (no credential). */
function scene() {
    const root = mkdtempSync(join(tmpdir(), 'otel-credential-'));
    const config = join(root, 'otel.json');
    const rendered = JSON.stringify({ endpoint: 'http://collector:4318', protocol: 'http/json' });
    writeFileSync(config, rendered);
    return { home: join(root, 'home'), config, rendered };
}

// The opencode plugin reads headers from its otel.json alone; the rendered one is world-readable,
// so the entrypoint's helper writes a private copy with the attempt's headers merged in.
describe('the opencode telemetry credential copy', () => {
    it('merges the OTLP headers into a private copy, leaving the rendered file untouched', () => {
        const { home, config, rendered } = scene();
        const copy = helper.writeCopy({
            HOME: home,
            OPENCODE_OTEL_CONFIG_PATH: config,
            OTEL_EXPORTER_OTLP_HEADERS: HEADERS,
        });
        expect(copy).toBe(join(home, '.factory-otel', 'otel.json'));
        expect(JSON.parse(readFileSync(copy!, 'utf8'))).toEqual({
            endpoint: 'http://collector:4318',
            protocol: 'http/json',
            headers: { 'x-factory-job-id': 'job-1', 'x-factory-ingest-token': 'ingest-1' },
        });
        expect(readFileSync(config, 'utf8')).toBe(rendered);
    });

    // The tool uid shares the CLI's group: the copy and its directory open to the CLI's uid alone.
    it('is 0600 in a 0700 directory, and replaced on every start', () => {
        const { home, config } = scene();
        const env = { HOME: home, OPENCODE_OTEL_CONFIG_PATH: config, OTEL_EXPORTER_OTLP_HEADERS: HEADERS };
        helper.writeCopy(env);
        const copy = helper.writeCopy({ ...env, OTEL_EXPORTER_OTLP_HEADERS: 'x-factory-job-id=job-2' })!;
        expect(statSync(join(home, '.factory-otel')).mode & 0o777).toBe(0o700);
        expect(statSync(copy).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(copy, 'utf8')).headers).toEqual({ 'x-factory-job-id': 'job-2' });
    });

    it('writes nothing without the headers', () => {
        const { home, config } = scene();
        expect(helper.writeCopy({ HOME: home, OPENCODE_OTEL_CONFIG_PATH: config })).toBeNull();
    });
});
