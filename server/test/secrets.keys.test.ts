import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadSecretKeys, operationMac, payloadFingerprint } from '../src/secrets/secret-keys.js';

const b64 = (n = 32) => randomBytes(n).toString('base64');

function goodEnv(): Record<string, string> {
    return {
        SECRETS_DATA_KEYS: `k1:${b64()},k2:${b64()}`,
        SECRETS_ACTIVE_KEY_ID: 'k2',
        SECRETS_OPERATION_KEY: b64(),
        SECRETS_FINGERPRINT_KEY: b64(),
    };
}

function refusal(env: Record<string, string | undefined>): Error {
    try {
        loadSecretKeys(env);
    } catch (error) {
        return error as Error;
    }
    throw new Error('expected loadSecretKeys to throw');
}

describe('loadSecretKeys', () => {
    it('loads a ring, the active id and both separate keys', () => {
        const keys = loadSecretKeys(goodEnv());
        expect([...keys.dataKeys.keys()]).toEqual(['k1', 'k2']);
        expect(keys.activeKeyId).toBe('k2');
        expect(keys.dataKeys.get('k1')?.length).toBe(32);
        expect(keys.operationKey.length).toBe(32);
        expect(keys.fingerprintKey.length).toBe(32);
    });

    it.each(['SECRETS_DATA_KEYS', 'SECRETS_ACTIVE_KEY_ID', 'SECRETS_OPERATION_KEY', 'SECRETS_FINGERPRINT_KEY'])(
        'refuses a missing or empty %s and names it',
        (name) => {
            for (const value of [undefined, '', '  ']) {
                const env: Record<string, string | undefined> = { ...goodEnv(), [name]: value };
                expect(refusal(env).message).toContain(name);
            }
        }
    );

    it.each([31, 33, 1, 64])('refuses a %i-byte key without echoing it', (size) => {
        const bad = b64(size);
        for (const name of ['SECRETS_OPERATION_KEY', 'SECRETS_FINGERPRINT_KEY']) {
            const error = refusal({ ...goodEnv(), [name]: bad });
            expect(error.message).toContain(name);
            expect(error.message).not.toContain(bad);
        }
        const dataError = refusal({ ...goodEnv(), SECRETS_DATA_KEYS: `k1:${bad}`, SECRETS_ACTIVE_KEY_ID: 'k1' });
        expect(dataError.message).toContain('SECRETS_DATA_KEYS');
        expect(dataError.message).toContain('k1');
        expect(dataError.message).not.toContain(bad);
    });

    it('refuses a key that is not canonical base64', () => {
        const raw = randomBytes(32);
        for (const bad of [
            raw.toString('hex'),
            `${raw.toString('base64')}!`,
            raw.toString('base64url'),
            'not base64 at all',
        ]) {
            const error = refusal({ ...goodEnv(), SECRETS_OPERATION_KEY: bad });
            expect(error.message).toContain('SECRETS_OPERATION_KEY');
            expect(error.message).not.toContain(bad);
        }
    });

    it('refuses a duplicate or malformed key id and an active id outside the ring', () => {
        const key = b64();
        expect(refusal({ ...goodEnv(), SECRETS_DATA_KEYS: `k1:${key},k1:${b64()}` }).message).toContain('k1');
        expect(
            refusal({ ...goodEnv(), SECRETS_DATA_KEYS: `K1:${key}`, SECRETS_ACTIVE_KEY_ID: 'K1' }).message
        ).toContain('SECRETS_DATA_KEYS');
        expect(refusal({ ...goodEnv(), SECRETS_DATA_KEYS: key, SECRETS_ACTIVE_KEY_ID: 'k1' }).message).toContain(
            'SECRETS_DATA_KEYS'
        );
        expect(refusal({ ...goodEnv(), SECRETS_ACTIVE_KEY_ID: 'k9' }).message).toContain('SECRETS_ACTIVE_KEY_ID');
    });

    it('refuses an operation key equal to the fingerprint key, or either equal to a data key', () => {
        const shared = b64();
        const env = goodEnv();
        expect(refusal({ ...env, SECRETS_OPERATION_KEY: shared, SECRETS_FINGERPRINT_KEY: shared }).message).toContain(
            'SECRETS_FINGERPRINT_KEY'
        );
        const asData = { ...env, SECRETS_DATA_KEYS: `k1:${shared}`, SECRETS_ACTIVE_KEY_ID: 'k1' };
        expect(refusal({ ...asData, SECRETS_OPERATION_KEY: shared }).message).toContain('SECRETS_OPERATION_KEY');
        expect(refusal({ ...asData, SECRETS_FINGERPRINT_KEY: shared }).message).toContain('SECRETS_FINGERPRINT_KEY');
    });

    it('derives the operation MAC and the payload fingerprint under their own keys', () => {
        const keys = loadSecretKeys(goodEnv());
        expect(operationMac(keys, '1.ab')).toMatch(/^[0-9a-f]{64}$/);
        expect(operationMac(keys, '1.ab')).toBe(operationMac(keys, '1.ab'));
        const payload = new TextEncoder().encode('p');
        const fp = payloadFingerprint(keys, { kind: 'replace', ref: 'sec_a', expectedVersion: 'ver_1', payload });
        expect(fp).not.toBe(
            payloadFingerprint(keys, { kind: 'replace', ref: 'sec_a', expectedVersion: 'ver_2', payload })
        );
        expect(fp).not.toBe(
            payloadFingerprint(keys, { kind: 'create', ref: 'sec_a', expectedVersion: 'ver_1', payload })
        );
        expect(fp).not.toBe(operationMac(keys, 'replace|sec_a|ver_1|p'));
    });
});
