import { describe, expect, it } from 'vitest';
import { loadConfig, resolveConfig } from '../src/config.js';

const DB = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----';
const env = (extra: NodeJS.ProcessEnv = {}) => ({ DATABASE_URL: DB, ...extra });
const app = (extra: NodeJS.ProcessEnv = {}) => env({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: PEM, ...extra });

describe('the GitHub App', () => {
    it('is the only configuration there is: missing credentials refuse to boot', () => {
        /*
         * The environment cannot produce "fetches nothing" — not by forgetting a variable, and not
         * by any variable at all. A deployment without the App would render an empty dashboard that
         * reads as data loss rather than as a missing credential.
         *
         * The offline tooling still runs without a credential, but only by passing the code-only
         * `none` arm to resolveConfig — a sentence in code, never in the environment.
         */
        expect(() => loadConfig(env())).toThrow(/GITHUB_APP_ID is not set/);
        expect(loadConfig(app()).github).toMatchObject({ mode: 'app' });
    });

    it('is never inferred from whether an app id happens to be set', () => {
        // A mode reached by typo is the failure nobody notices. GITHUB_APP_IDD must leave the
        // deployment loudly unconfigured, not quietly reading nothing.
        expect(() => loadConfig(env({ GITHUB_APP_IDD: '123', GITHUB_APP_PRIVATE_KEY: PEM }))).toThrow(
            /GITHUB_APP_ID is not set/
        );
    });

    it('names the missing key individually, not "the App is incomplete"', () => {
        // The operator has one key to fix and should not have to diff the example file to find it.
        expect(() => loadConfig(app({ GITHUB_APP_ID: undefined }))).toThrow(/GITHUB_APP_ID is not set/);
        expect(() => loadConfig(app({ GITHUB_APP_PRIVATE_KEY: undefined }))).toThrow(
            /GITHUB_APP_PRIVATE_KEY is not set/
        );
    });
});

describe('the code-only none arm', () => {
    it('is reachable only through resolveConfig, never through the environment', () => {
        // The seam the offline tooling uses: seed, the admin CLIs and the offline entry pass the
        // config in code. Nothing env-reachable can produce this value.
        const { config } = resolveConfig({ env: app(), github: { mode: 'none' } });
        expect(config.github).toEqual({ mode: 'none' });
        expect(() => loadConfig(app())).not.toThrow();
    });
});

describe('the App private key', () => {
    it('is carried as a PEM, and only its shape is checked here', () => {
        // loadConfig does no I/O and no crypto: GITHUB_APP_PRIVATE_KEY_FILE is read by
        // resolveConfig, and createPrivateKey runs when the token provider is constructed.
        expect(loadConfig(app()).github).toMatchObject({ privateKeyPem: PEM });
    });

    it('accepts base64, because a PEM is multi-line and a .env value is not', () => {
        const config = loadConfig(app({ GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString('base64') }));
        expect(config.github).toMatchObject({ privateKeyPem: PEM });
    });

    it('rejects something that is neither', () => {
        expect(() => loadConfig(app({ GITHUB_APP_PRIVATE_KEY: 'ghp_a_personal_access_token' }))).toThrow(
            /not a PEM private key/
        );
    });

    it('carries no installation id: the orgs are the installations now (#99)', () => {
        // Installation tokens mint per organization from organization.installation_id, so a
        // process-wide one has nothing to point at. The variable's refusal is a row in
        // config.org.test.ts's retired-variable table.
        expect('installationId' in (loadConfig(app()).github as object)).toBe(false);
    });
});

describe('the API host', () => {
    it('defaults to api.github.com and drops a trailing slash', () => {
        expect(loadConfig(app()).github).toMatchObject({ apiUrl: 'https://api.github.com' });
        expect(loadConfig(app({ GITHUB_API_URL: 'http://127.0.0.1:8125/' })).github).toMatchObject({
            apiUrl: 'http://127.0.0.1:8125',
        });
    });
});

describe('the webhook secret', () => {
    it('is optional, and unset means the installation webhook route does not exist', () => {
        expect(loadConfig(app()).webhookSecret).toBeNull();
        // Compose passes several variables empty, so whitespace-only is unset too.
        expect(loadConfig(app({ GITHUB_WEBHOOK_SECRET: '   ' })).webhookSecret).toBeNull();
    });

    it('refuses a secret short enough to enumerate', () => {
        // The HMAC decides whose memberships get deleted, so the secret is a credential —
        // timing-safe comparison does not help a key a caller can guess. Same floor, and same
        // failure shape, as SESSION_SECRET's.
        const MIN_WEBHOOK_SECRET_LENGTH = 32;
        expect(() => loadConfig(app({ GITHUB_WEBHOOK_SECRET: 'short' }))).toThrow(/at least 32 characters/);
        expect(loadConfig(app({ GITHUB_WEBHOOK_SECRET: 'x'.repeat(MIN_WEBHOOK_SECRET_LENGTH) })).webhookSecret).toBe(
            'x'.repeat(MIN_WEBHOOK_SECRET_LENGTH)
        );
    });
});
