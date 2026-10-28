import { afterEach, describe, expect, it, vi } from 'vitest';
import { start } from '../src/main.js';

afterEach(() => {
    vi.unstubAllEnvs();
});

const SENTINEL = 'sentinel-not-a-key-value';

/** What the process itself needs; everything else in the ambient environment is blanked before a boot. */
const PROCESS_BASICS = /^(PATH|HOME|TMPDIR|TMP|TEMP|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TZ|NODE_[A-Z_]+|VITEST[A-Z_]*)$/;

/** Boot refuses before it opens a pool or a port; the message names the variable and never its value. */
describe('start() without secret-store keys', () => {
    function bootEnv(overrides: Record<string, string>) {
        // A runner's gate environment carries variables boot refuses first (a retired GITHUB_TOKEN or
        // BASE_BRANCH), which would win over the refusal under test. Empty is unset for config.
        for (const name of Object.keys(process.env)) {
            if (!PROCESS_BASICS.test(name)) vi.stubEnv(name, '');
        }
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
            'SECRETS_VAULT_ADDR',
            'SECRETS_VAULT_MOUNT',
            'SECRETS_VAULT_PREFIX',
            'SECRETS_VAULT_AUTH',
            'SECRETS_VAULT_ROLE',
            'SECRETS_VAULT_TOKEN_FILE',
            'SECRETS_VAULT_TOKEN',
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

    it.each(['SECRETS_VAULT_ADDR', 'SECRETS_VAULT_MOUNT', 'SECRETS_VAULT_PREFIX', 'SECRETS_VAULT_AUTH'])(
        'refuses a vault backend that lacks %s, naming it',
        async (missing) => {
            const env: Record<string, string> = {
                SECRETS_BACKEND: 'vault',
                SECRETS_OPERATION_KEY: Buffer.alloc(32, 7).toString('base64'),
                SECRETS_FINGERPRINT_KEY: Buffer.alloc(32, 8).toString('base64'),
                SECRETS_VAULT_ADDR: 'http://127.0.0.1:8200',
                SECRETS_VAULT_MOUNT: 'secret',
                SECRETS_VAULT_PREFIX: 'factory/test',
                SECRETS_VAULT_AUTH: 'token',
                SECRETS_VAULT_TOKEN: SENTINEL,
            };
            delete env[missing];
            bootEnv(env);
            const refusal = await start({ github: { mode: 'none' } }).then(
                () => new Error('booted'),
                (e: Error) => e
            );
            expect(refusal.message).toContain(`${missing} is required`);
            expect(refusal.message).not.toContain(SENTINEL);
        }
    );

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
