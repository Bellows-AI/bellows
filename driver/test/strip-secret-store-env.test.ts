import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripSecretStoreEnv } from '../src/strip-secret-store-env.js';

describe('stripSecretStoreEnv', () => {
    it('removes every SECRETS_ variable and nothing else', () => {
        const env: Record<string, string | undefined> = {
            SECRETS_DATA_KEYS: 'k1:x',
            SECRETS_ACTIVE_KEY_ID: 'k1',
            SECRETS_OPERATION_KEY: 'o',
            SECRETS_FINGERPRINT_KEY: 'f',
            SECRETS_FUTURE_THING: 'y',
            SECRET_PROBE: 'kept',
            JOB_BOARD_TOKEN: 'kept',
        };
        stripSecretStoreEnv(env);
        expect(Object.keys(env).sort()).toEqual(['JOB_BOARD_TOKEN', 'SECRET_PROBE']);
    });

    it('leaves a driver that was handed a key unable to forward it as RUNNER_ENV', () => {
        const env: Record<string, string | undefined> = { SECRETS_DATA_KEYS: 'k1:x', RUNNER_ENV: 'SECRETS_DATA_KEYS' };
        stripSecretStoreEnv(env);
        expect(env.SECRETS_DATA_KEYS).toBeUndefined();
    });

    it('runs first in the entry point, so no later read sees a key', () => {
        const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
        const strip = index.indexOf('stripSecretStoreEnv(process.env)');
        expect(strip).toBeGreaterThan(0);
        expect(index.slice(0, strip)).not.toMatch(/process\.env/);
    });
});
