import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = {
    DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
};

const load = (env: NodeJS.ProcessEnv) => loadConfig({ ...BASE, ...env });

/** The chart's shape: the whole `runner.classes` map, of which the board reads names and the docker flag. */
const CHART_CLASSES = JSON.stringify({
    standard: { resources: { requests: { cpu: '500m', memory: '1Gi' } } },
    sandboxed: { runtimeClassName: 'gvisor', docker: true, nodeSelector: { pool: 'sandbox' } },
    plain: null,
});

describe('RUNNER_CLASSES on the board', () => {
    it('declares no classes when unset or empty', () => {
        expect(load({}).runnerClasses).toEqual([]);
        expect(load({ RUNNER_CLASSES: '' }).runnerClasses).toEqual([]);
        expect(load({ RUNNER_CLASSES: '  ' }).runnerClasses).toEqual([]);
    });

    it('reads each class by name with its docker flag, leaving the rest to the driver', () => {
        expect(load({ RUNNER_CLASSES: CHART_CLASSES }).runnerClasses).toEqual([
            { name: 'standard', docker: false },
            { name: 'sandboxed', docker: true },
            { name: 'plain', docker: false },
        ]);
    });

    it.each([
        ['malformed JSON', '{"standard":', /RUNNER_CLASSES must be JSON/],
        ['a JSON array', '["standard"]', /RUNNER_CLASSES must be a JSON object/],
        ['a JSON string', '"standard"', /RUNNER_CLASSES must be a JSON object/],
        ['a class that is not an object', '{"standard":"big"}', /RUNNER_CLASSES\.standard must be a JSON object/],
        ['a name that is not a DNS-1123 label', '{"Big_Class":{}}', /not a DNS-1123 label/],
        ['a docker flag that is not a boolean', '{"standard":{"docker":"yes"}}', /RUNNER_CLASSES\.standard\.docker/],
    ])('refuses boot on %s, never reading it as no classes', (_label, raw, message) => {
        expect(() => load({ RUNNER_CLASSES: raw })).toThrow(message);
    });

    it("compose's dashboard declares no classes, so a profile there names none", () => {
        const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
        const start = compose.search(/^ {4}dashboard:\s*$/m);
        expect(start).toBeGreaterThanOrEqual(0);
        const rest = compose.slice(start + 1);
        const next = rest.search(/^ {4}[a-z][a-z0-9-]*:\s*$|^[a-z]/m);
        const dashboard = next < 0 ? rest : rest.slice(0, next);
        expect(dashboard).not.toContain('RUNNER_CLASSES');
    });
});
