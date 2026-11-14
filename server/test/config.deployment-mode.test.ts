import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = {
    DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
};

const load = (env: NodeJS.ProcessEnv) => loadConfig({ ...BASE, ...env });

describe('DEPLOYMENT_MODE', () => {
    it('is self-hosted with no variable', () => {
        expect(load({}).deploymentMode).toBe('self-hosted');
    });

    it('accepts self-hosted and cloud', () => {
        expect(load({ DEPLOYMENT_MODE: 'self-hosted' }).deploymentMode).toBe('self-hosted');
        // A cloud board boots only with the Free plan's limits (config.plan-defaults.test.ts).
        const free = {
            PLAN_DEFAULT_MAX_RUNNING: '1',
            PLAN_DEFAULT_MAX_QUEUED: '10',
            PLAN_DEFAULT_MAX_WALL_SECONDS: '3600',
            PLAN_DEFAULT_MAX_TOKENS: '1000000',
            PLAN_DEFAULT_MAX_STORAGE_BYTES: '1048576',
            PLAN_DEFAULT_MAX_RETENTION_DAYS: '7',
        };
        expect(load({ DEPLOYMENT_MODE: 'cloud', ...free }).deploymentMode).toBe('cloud');
    });

    it('refuses any other value, naming the variable', () => {
        expect(() => load({ DEPLOYMENT_MODE: 'Cloud' })).toThrow(/DEPLOYMENT_MODE must be "self-hosted" or "cloud"/);
        expect(() => load({ DEPLOYMENT_MODE: '' })).toThrow(/DEPLOYMENT_MODE/);
    });
});
