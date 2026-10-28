import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadSecretBackend, rotationKeys } from '../src/secrets/secret-backend.js';
import { SecretKeyConfigError } from '../src/secrets/secret-keys.js';

/** Mode selection (docs/secrets.md): one backend per deployment, required on every boot, no value ever echoed. */
const SENTINEL = 'sentinel-not-a-config-value';
const key = () => randomBytes(32).toString('base64');

const operation = () => ({ SECRETS_OPERATION_KEY: key(), SECRETS_FINGERPRINT_KEY: key() });
const database = () => ({
    SECRETS_BACKEND: 'database',
    SECRETS_DATA_KEYS: `k1:${key()}`,
    SECRETS_ACTIVE_KEY_ID: 'k1',
    ...operation(),
});
const aws = (extra: Record<string, string> = {}) => ({
    SECRETS_BACKEND: 'aws',
    SECRETS_AWS_REGION: 'eu-west-1',
    SECRETS_AWS_PREFIX: 'factory/stage',
    AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/token',
    AWS_ROLE_ARN: 'arn:aws:iam::000000000000:role/example',
    ...operation(),
    ...extra,
});

function refusal(env: Record<string, string>): Error {
    try {
        loadSecretBackend(env);
    } catch (e) {
        return e as Error;
    }
    throw new Error('expected a refusal');
}

describe('loadSecretBackend', () => {
    it('requires SECRETS_BACKEND on every boot and points an old secrets.env at secrets:init', () => {
        const { SECRETS_BACKEND: _omitted, ...withoutBackend } = database();
        const error = refusal(withoutBackend);
        expect(error).toBeInstanceOf(SecretKeyConfigError);
        expect(error.message).toContain('SECRETS_BACKEND is required');
        expect(error.message).toContain('npm run secrets:init');
        expect(refusal({ ...database(), SECRETS_BACKEND: '  ' }).message).toContain('SECRETS_BACKEND is required');
    });

    it('refuses an unknown backend without echoing it', () => {
        const error = refusal({ ...database(), SECRETS_BACKEND: SENTINEL });
        expect(error.message).toContain('SECRETS_BACKEND must be one of');
        expect(error.message).not.toContain(SENTINEL);
    });

    it('loads the database backend with the data keys', () => {
        const loaded = loadSecretBackend(database());
        expect(loaded.kind).toBe('database');
        if (loaded.kind !== 'database') throw new Error('unreachable');
        expect(loaded.keys.activeKeyId).toBe('k1');
        expect(loaded.keys.operationKey).toHaveLength(32);
    });

    it('still names the missing key in database mode', () => {
        const { SECRETS_DATA_KEYS: _omitted, ...rest } = database();
        expect(refusal(rest).message).toContain('SECRETS_DATA_KEYS is required');
    });

    it('loads the aws backend without data keys', () => {
        const loaded = loadSecretBackend(aws());
        expect(loaded.kind).toBe('aws');
        if (loaded.kind !== 'aws') throw new Error('unreachable');
        expect(loaded.aws).toEqual({
            region: 'eu-west-1',
            prefix: 'factory/stage',
            endpoint: null,
            staticCredentials: null,
        });
        expect('dataKeys' in loaded.keys).toBe(false);
    });

    it('takes an endpoint and a static key pair for development', () => {
        const loaded = loadSecretBackend(
            aws({
                SECRETS_AWS_ENDPOINT: 'http://127.0.0.1:5000',
                SECRETS_AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
                SECRETS_AWS_SECRET_ACCESS_KEY: 'example-secret',
                AWS_WEB_IDENTITY_TOKEN_FILE: '',
                AWS_ROLE_ARN: '',
            })
        );
        if (loaded.kind !== 'aws') throw new Error('unreachable');
        expect(loaded.aws.endpoint).toBe('http://127.0.0.1:5000');
        expect(loaded.aws.staticCredentials).toEqual({
            accessKeyId: 'AKIAEXAMPLE',
            secretAccessKey: 'example-secret',
        });
    });

    it('requires the operation and fingerprint keys in aws mode too', () => {
        const { SECRETS_OPERATION_KEY: _a, ...noOperation } = aws();
        expect(refusal(noOperation).message).toContain('SECRETS_OPERATION_KEY is required');
        const { SECRETS_FINGERPRINT_KEY: _b, ...noFingerprint } = aws();
        expect(refusal(noFingerprint).message).toContain('SECRETS_FINGERPRINT_KEY is required');
    });

    it.each(['SECRETS_AWS_REGION', 'SECRETS_AWS_PREFIX'])('requires %s in aws mode', (name) => {
        const env = aws();
        delete (env as Record<string, string>)[name];
        expect(refusal(env).message).toContain(`${name} is required`);
    });

    it.each([
        ['SECRETS_DATA_KEYS', `k1:${SENTINEL}`],
        ['SECRETS_ACTIVE_KEY_ID', SENTINEL],
    ])('refuses %s in aws mode, naming it and not echoing it', (name, value) => {
        const error = refusal(aws({ [name]: value }));
        expect(error.message).toContain(name);
        expect(error.message).not.toContain(SENTINEL);
    });

    it.each([
        ['SECRETS_AWS_REGION', 'eu-west-1'],
        ['SECRETS_AWS_PREFIX', SENTINEL],
        ['SECRETS_AWS_ENDPOINT', 'http://127.0.0.1:5000'],
        ['SECRETS_AWS_ACCESS_KEY_ID', SENTINEL],
        ['SECRETS_AWS_SECRET_ACCESS_KEY', SENTINEL],
        ['SECRETS_VAULT_ADDR', SENTINEL],
    ])('refuses %s in database mode, naming it and not echoing it', (name, value) => {
        const error = refusal({ ...database(), [name]: value });
        expect(error.message).toContain(name);
        expect(error.message).not.toContain(SENTINEL);
    });

    it('ignores a provider variable that is set but empty, as a rendered chart leaves it', () => {
        expect(loadSecretBackend({ ...database(), SECRETS_AWS_REGION: '', SECRETS_AWS_PREFIX: '  ' }).kind).toBe(
            'database'
        );
    });

    it.each([
        ['only the access key id', { SECRETS_AWS_ACCESS_KEY_ID: SENTINEL }],
        ['only the secret access key', { SECRETS_AWS_SECRET_ACCESS_KEY: SENTINEL }],
    ])('refuses %s of the static pair, without echoing it', (_label, extra) => {
        const error = refusal(aws(extra));
        expect(error.message).toContain('SECRETS_AWS_ACCESS_KEY_ID and SECRETS_AWS_SECRET_ACCESS_KEY');
        expect(error.message).not.toContain(SENTINEL);
    });

    it.each([
        ['a leading slash', '/factory'],
        ['a trailing slash', 'factory/'],
        ['an empty segment', 'factory//stage'],
        ['a space', `factory ${SENTINEL}`],
        ['a too long prefix', 'a'.repeat(201)],
    ])('refuses %s in the prefix without echoing it', (_label, prefix) => {
        const error = refusal(aws({ SECRETS_AWS_PREFIX: prefix }));
        expect(error.message).toContain('SECRETS_AWS_PREFIX');
        expect(error.message).not.toContain(SENTINEL);
    });

    it.each([
        ['not a url', SENTINEL],
        ['a non-http scheme', 'ftp://example.test'],
    ])('refuses an endpoint that is %s without echoing it', (_label, endpoint) => {
        const error = refusal(aws({ SECRETS_AWS_ENDPOINT: endpoint }));
        expect(error.message).toContain('SECRETS_AWS_ENDPOINT');
        expect(error.message).not.toContain(SENTINEL);
    });

    it('refuses a region that is not a region name', () => {
        const error = refusal(aws({ SECRETS_AWS_REGION: `Bad Region ${SENTINEL}` }));
        expect(error.message).toContain('SECRETS_AWS_REGION');
        expect(error.message).not.toContain(SENTINEL);
    });

    it('refuses aws mode with no credential source at all', () => {
        const env = aws({ AWS_WEB_IDENTITY_TOKEN_FILE: '', AWS_ROLE_ARN: '' });
        expect(refusal(env).message).toContain('SECRETS_AWS_ACCESS_KEY_ID');
        expect(refusal(env).message).toContain('IRSA');
    });

    it('accepts EKS Pod Identity as the credential source', () => {
        const env = aws({
            AWS_WEB_IDENTITY_TOKEN_FILE: '',
            AWS_ROLE_ARN: '',
            AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
            AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/var/run/pod-token',
        });
        expect(loadSecretBackend(env).kind).toBe('aws');
    });

    it('refuses vault until its adapter ships, naming the variable', () => {
        const error = refusal({ ...database(), SECRETS_BACKEND: 'vault' });
        expect(error).toBeInstanceOf(SecretKeyConfigError);
        expect(error.message).toContain('SECRETS_BACKEND=vault');
    });
});

describe('rotationKeys', () => {
    it('returns the data keys in database mode', () => {
        expect(rotationKeys(database()).activeKeyId).toBe('k1');
    });

    it('refuses an external mode, which has no data keys to rotate', () => {
        const error = (() => {
            try {
                rotationKeys(aws());
            } catch (e) {
                return e as Error;
            }
            throw new Error('expected a refusal');
        })();
        expect(error.message).toContain('SECRETS_BACKEND=database');
    });

    it('is what the rotation command loads its keys through', () => {
        const source = readFileSync(new URL('../src/secrets/rotate-cli.ts', import.meta.url), 'utf8');
        expect(source).toContain('rotationKeys(process.env)');
        expect(source).not.toContain('loadSecretKeys(');
    });
});
