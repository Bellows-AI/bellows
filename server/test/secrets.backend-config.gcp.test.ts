import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadSecretBackend } from '../src/secrets/secret-backend.js';
import { SecretKeyConfigError } from '../src/secrets/secret-keys.js';

/** The gcp backend's settings (docs/secrets.md): project required, ADC only, every other backend's variable refused. */
const key = () => randomBytes(32).toString('base64');
const operation = () => ({ SECRETS_OPERATION_KEY: key(), SECRETS_FINGERPRINT_KEY: key() });
const gcp = (extra: Record<string, string> = {}) => ({
    SECRETS_BACKEND: 'gcp',
    SECRETS_GCP_PROJECT: 'example-project-1',
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

describe('loadSecretBackend with SECRETS_BACKEND=gcp', () => {
    it('loads with a project alone and defaults the prefix and an EU location', () => {
        const loaded = loadSecretBackend(gcp());
        expect(loaded.kind).toBe('gcp');
        if (loaded.kind !== 'gcp') throw new Error('unreachable');
        expect(loaded.gcp).toEqual({
            project: 'example-project-1',
            prefix: 'bellows-',
            location: 'europe-west3',
            kmsKey: null,
        });
        expect(loaded.keys.operationKey).toHaveLength(32);
    });

    it('takes a prefix, a location and a KMS key', () => {
        const kms = 'projects/example-project-1/locations/europe-west3/keyRings/ring/cryptoKeys/key';
        const loaded = loadSecretBackend(
            gcp({ SECRETS_GCP_PREFIX: 'acme_', SECRETS_GCP_LOCATION: 'europe-west1', SECRETS_GCP_KMS_KEY: kms })
        );
        if (loaded.kind !== 'gcp') throw new Error('unreachable');
        expect(loaded.gcp).toEqual({
            project: 'example-project-1',
            prefix: 'acme_',
            location: 'europe-west1',
            kmsKey: kms,
        });
    });

    it('treats a blank variable, as a rendered chart leaves it, as unset', () => {
        const loaded = loadSecretBackend(
            gcp({ SECRETS_GCP_PREFIX: ' ', SECRETS_GCP_LOCATION: '', SECRETS_GCP_KMS_KEY: '' })
        );
        if (loaded.kind !== 'gcp') throw new Error('unreachable');
        expect(loaded.gcp.prefix).toBe('bellows-');
        expect(loaded.gcp.kmsKey).toBeNull();
    });

    it('fails at boot naming the missing project', () => {
        const { SECRETS_GCP_PROJECT: _omitted, ...without } = gcp();
        const error = refusal(without);
        expect(error).toBeInstanceOf(SecretKeyConfigError);
        expect(error.message).toContain('SECRETS_GCP_PROJECT is required');
    });

    it.each([
        ['SECRETS_GCP_PROJECT', 'Bad Project'],
        ['SECRETS_GCP_PREFIX', 'with/slash'],
        ['SECRETS_GCP_PREFIX', '1digit-first'],
        ['SECRETS_GCP_PREFIX', `a${'b'.repeat(128)}`],
        ['SECRETS_GCP_LOCATION', 'Europe West'],
        ['SECRETS_GCP_KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1'],
        ['SECRETS_GCP_KMS_KEY', 'not-a-key'],
    ])('refuses a malformed %s without echoing it', (name, value) => {
        const error = refusal(gcp({ [name]: value }));
        expect(error.message).toContain(name);
        expect(error.message).not.toContain(value);
    });

    it('refuses the database data keys', () => {
        expect(refusal(gcp({ SECRETS_DATA_KEYS: `k1:${key()}` })).message).toBe(
            'SECRETS_DATA_KEYS is only valid with SECRETS_BACKEND=database'
        );
        expect(refusal(gcp({ SECRETS_ACTIVE_KEY_ID: 'k1' })).message).toBe(
            'SECRETS_ACTIVE_KEY_ID is only valid with SECRETS_BACKEND=database'
        );
    });

    it('refuses a variable of another backend', () => {
        expect(refusal(gcp({ SECRETS_AWS_REGION: 'eu-west-1' })).message).toContain('SECRETS_BACKEND=aws');
        expect(refusal(gcp({ SECRETS_VAULT_ADDR: 'http://vault' })).message).toContain('SECRETS_BACKEND=vault');
    });

    it.each(['database', 'aws', 'vault'])('refuses a SECRETS_GCP_ variable under %s', (backend) => {
        const error = refusal({ ...operation(), SECRETS_BACKEND: backend, SECRETS_GCP_PROJECT: 'example-project-1' });
        expect(error.message).toBe('SECRETS_GCP_PROJECT is only valid with SECRETS_BACKEND=gcp');
    });
});
