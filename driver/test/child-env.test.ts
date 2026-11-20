import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withoutOtelEnv } from '../src/child-env.js';
import { run } from '../src/docker/docker-runner-support.js';

const SECRET = 'Authorization=secret_child_env';

describe('the environment of a child the driver spawns', () => {
    beforeEach(() => {
        process.env.OTEL_EXPORTER_OTLP_HEADERS = SECRET;
        process.env.OTEL_SERVICE_NAME = 'bellows-driver';
    });
    afterEach(() => {
        delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
        delete process.env.OTEL_SERVICE_NAME;
    });

    it('has no OTEL_* key while the driver’s own env keeps them', async () => {
        const { stdout } = await run(process.execPath, ['-e', 'console.log(JSON.stringify(Object.keys(process.env)))']);
        const keys = JSON.parse(stdout) as string[];
        expect(keys.filter((k) => k.startsWith('OTEL_'))).toEqual([]);
        expect(keys).toContain('PATH');
        expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(SECRET);
    });

    it('drops OTEL_* from an env it is handed, and keeps the rest', () => {
        expect(withoutOtelEnv({ OTEL_X: '1', PATH: '/bin', OTELX: 'kept' })).toEqual({ PATH: '/bin', OTELX: 'kept' });
    });
});
