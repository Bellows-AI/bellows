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
            'SECRETS_DATA_KEYS',
            'SECRETS_ACTIVE_KEY_ID',
            'SECRETS_OPERATION_KEY',
            'SECRETS_FINGERPRINT_KEY',
        ]) {
            vi.stubEnv(name, overrides[name] ?? '');
        }
    }

    it('refuses when the keys are missing, even offline', async () => {
        bootEnv({});
        await expect(start({ github: { mode: 'none' } })).rejects.toThrow('SECRETS_DATA_KEYS is required');
    });

    it('refuses an invalid key without echoing it', async () => {
        bootEnv({ SECRETS_DATA_KEYS: `k1:${SENTINEL}`, SECRETS_ACTIVE_KEY_ID: 'k1' });
        const refusal = await start({ github: { mode: 'none' } }).then(
            () => new Error('booted'),
            (e: Error) => e
        );
        expect(refusal.message).toContain('SECRETS_DATA_KEYS');
        expect(refusal.message).not.toContain(SENTINEL);
    });
});
