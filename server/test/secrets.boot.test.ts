import { afterEach, describe, expect, it, vi } from 'vitest';
import { start } from '../src/main.js';

afterEach(() => {
    vi.unstubAllEnvs();
});

const SENTINEL = 'sentinel-not-a-key-value';

/** Boot refuses before it opens a pool or a port; the message names the variable and never its value. */
describe('start() without secret-store keys', () => {
    function bootEnv(overrides: Record<string, string>) {
        vi.stubEnv('DATABASE_URL', 'postgres://nobody:nothing@127.0.0.1:1/never_connected_test');
        vi.stubEnv('AUTH_MODE', 'none');
        vi.stubEnv('PORT', '18999');
        for (const name of [
            'SECRETS_BACKEND',
            'SECRETS_DATA_KEYS',
            'SECRETS_ACTIVE_KEY_ID',
            'SECRETS_OPERATION_KEY',
            'SECRETS_FINGERPRINT_KEY',
            'SECRETS_AWS_REGION',
            'SECRETS_AWS_PREFIX',
        ]) {
            vi.stubEnv(name, overrides[name] ?? '');
        }
    }

    it('refuses when the backend is not selected, naming the variable and the command that adds it', async () => {
        bootEnv({});
        const refusal = await start({ github: { mode: 'none' } }).then(
            () => new Error('booted'),
            (e: Error) => e
        );
        expect(refusal.message).toContain('SECRETS_BACKEND is required');
        expect(refusal.message).toContain('npm run secrets:init');
    });

    it('refuses an external backend that lacks the operation key, even though it needs no data keys', async () => {
        bootEnv({
            SECRETS_BACKEND: 'aws',
            SECRETS_AWS_REGION: 'eu-west-1',
            SECRETS_AWS_PREFIX: 'factory/test',
        });
        vi.stubEnv('AWS_ROLE_ARN', 'arn:aws:iam::000000000000:role/example');
        vi.stubEnv('AWS_WEB_IDENTITY_TOKEN_FILE', '/var/run/token');
        const refusal = await start({ github: { mode: 'none' } }).then(
            () => new Error('booted'),
            (e: Error) => e
        );
        expect(refusal.message).toContain('SECRETS_OPERATION_KEY is required');
    });

    it('refuses when the keys are missing, even offline', async () => {
        bootEnv({ SECRETS_BACKEND: 'database' });
        await expect(start({ github: { mode: 'none' } })).rejects.toThrow('SECRETS_DATA_KEYS is required');
    });

    it('refuses an invalid key without echoing it', async () => {
        bootEnv({ SECRETS_BACKEND: 'database', SECRETS_DATA_KEYS: `k1:${SENTINEL}`, SECRETS_ACTIVE_KEY_ID: 'k1' });
        const refusal = await start({ github: { mode: 'none' } }).then(
            () => new Error('booted'),
            (e: Error) => e
        );
        expect(refusal.message).toContain('SECRETS_DATA_KEYS');
        expect(refusal.message).not.toContain(SENTINEL);
    });
});
