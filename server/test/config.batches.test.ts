import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = {
    DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
};

const load = (env: NodeJS.ProcessEnv) => loadConfig({ ...BASE, ...env });

describe('BATCHES_ENABLED', () => {
    it('is off with no variable and when false', () => {
        expect(load({}).batches).toEqual({ enabled: false });
        expect(load({ BATCHES_ENABLED: 'false' }).batches).toEqual({ enabled: false });
    });

    it('is on for true and 1', () => {
        expect(load({ BATCHES_ENABLED: 'true' }).batches).toEqual({ enabled: true });
        expect(load({ BATCHES_ENABLED: '1' }).batches).toEqual({ enabled: true });
    });

    it('refuses a value that is not a boolean, naming it', () => {
        expect(() => load({ BATCHES_ENABLED: 'maybe' })).toThrow(/BATCHES_ENABLED must be a boolean/);
    });
});
