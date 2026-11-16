import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE = {
    DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
};

const load = (env: NodeJS.ProcessEnv) => loadConfig({ ...BASE, ...env });

describe('PLATFORM_MODEL_PROVIDED', () => {
    it('is off with no variable and when false', () => {
        expect(load({}).platformModelProvided).toBe(false);
        expect(load({ PLATFORM_MODEL_PROVIDED: 'false' }).platformModelProvided).toBe(false);
    });

    it('is on for true', () => {
        expect(load({ PLATFORM_MODEL_PROVIDED: 'true' }).platformModelProvided).toBe(true);
    });

    it('refuses a value that is not a boolean, naming it', () => {
        expect(() => load({ PLATFORM_MODEL_PROVIDED: 'yes please' })).toThrow(
            /PLATFORM_MODEL_PROVIDED must be a boolean/
        );
    });
});
