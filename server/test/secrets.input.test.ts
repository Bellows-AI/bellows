import { describe, expect, it } from 'vitest';
import {
    MAX_SECRET_BYTES,
    OPERATION_RETENTION_MS,
    createSecretRef,
    identityKey,
    isSecretRef,
    sameIdentity,
    secretError,
    validateIdentity,
    validatePayload,
} from '../src/secrets/secret-input.js';
import type { SecretIdentity } from '../src/secrets/secret-store.js';

const base: SecretIdentity = {
    owner: { kind: 'organization', orgId: 'org-1' },
    scope: { type: 'workspace', id: 'ws-1' },
    purpose: 'environment-secret',
    owningRecord: { type: 'env_var', id: 'row-1' },
};

describe('validatePayload', () => {
    it('accepts 0 through 32768 bytes inclusive', () => {
        expect(validatePayload(new Uint8Array(0)).ok).toBe(true);
        expect(validatePayload(new Uint8Array(MAX_SECRET_BYTES)).ok).toBe(true);
        expect(MAX_SECRET_BYTES).toBe(32_768);
    });

    it('rejects 32769 bytes, null, undefined, strings and arrays', () => {
        expect(validatePayload(new Uint8Array(MAX_SECRET_BYTES + 1))).toEqual({
            ok: false,
            error: secretError('invalid-input', 'payload-too-large'),
        });
        for (const bad of [null, undefined]) {
            expect(validatePayload(bad)).toEqual({ ok: false, error: secretError('invalid-input', 'payload-null') });
        }
        for (const bad of ['text', [1, 2], {}, 5]) {
            expect(validatePayload(bad)).toEqual({
                ok: false,
                error: secretError('invalid-input', 'payload-not-bytes'),
            });
        }
    });
});

describe('identity', () => {
    it('keeps retention at seven days', () => {
        expect(OPERATION_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('validates a well-formed identity, including a personal one with no organization', () => {
        expect(validateIdentity(base)).toBeNull();
        expect(validateIdentity({ ...base, owner: { kind: 'user', userId: 'u', orgId: null } })).toBeNull();
        expect(validateIdentity({ ...base, owner: { kind: 'user', userId: 'u', orgId: 'o' } })).toBeNull();
    });

    it('rejects every malformed field', () => {
        const bad: unknown[] = [
            null,
            'x',
            [],
            {},
            { ...base, owner: null },
            { ...base, owner: 'x' },
            { ...base, owner: [] },
            { ...base, scope: null },
            { ...base, scope: 'x' },
            { ...base, scope: [] },
            { ...base, scope: { type: 7, id: 'x' } },
            { ...base, scope: { type: 'workspace', id: 7 } },
            { ...base, purpose: null },
            { ...base, purpose: 7 },
            { ...base, owningRecord: null },
            { ...base, owningRecord: 'x' },
            { ...base, owningRecord: [] },
            { ...base, owningRecord: { type: 'x', id: null } },
            { ...base, owner: { kind: 'user', userId: 'u', orgId: 7 } },
            { ...base, owner: { kind: 'user', userId: 'u', orgId: '' } },
            { ...base, owner: { kind: 'organization', orgId: '' } },
            { ...base, owner: { kind: 'organization' } },
            { ...base, owner: { kind: 'user', userId: 'u' } },
            { ...base, owner: { kind: 'user', userId: '', orgId: null } },
            { ...base, owner: { kind: 'robot', orgId: 'o' } },
            { ...base, scope: { type: 'galaxy', id: 'x' } },
            { ...base, scope: { type: 'workspace', id: '' } },
            { ...base, purpose: 'other' },
            { ...base, owningRecord: { type: '', id: 'x' } },
            { ...base, owningRecord: { type: 'x', id: 'a'.repeat(257) } },
        ];
        for (const identity of bad) {
            expect(validateIdentity(identity), JSON.stringify(identity)).toEqual(
                secretError('invalid-input', 'identity-invalid')
            );
        }
    });

    it('treats every field as part of the identity', () => {
        expect(sameIdentity(base, structuredClone(base))).toBe(true);
        const variants: SecretIdentity[] = [
            { ...base, owner: { kind: 'organization', orgId: 'org-2' } },
            { ...base, owner: { kind: 'user', userId: 'org-1', orgId: 'org-1' } },
            { ...base, owner: { kind: 'user', userId: 'org-1', orgId: null } },
            { ...base, scope: { ...base.scope, type: 'repository' } },
            { ...base, scope: { ...base.scope, id: 'ws-2' } },
            { ...base, purpose: 'connection-grant' },
            { ...base, owningRecord: { ...base.owningRecord, type: 'other' } },
            { ...base, owningRecord: { ...base.owningRecord, id: 'row-2' } },
        ];
        for (const v of variants) {
            expect(sameIdentity(base, v), identityKey(v)).toBe(false);
        }
        const withOrg: SecretIdentity = { ...base, owner: { kind: 'user', userId: 'u', orgId: 'o' } };
        const noOrg: SecretIdentity = { ...base, owner: { kind: 'user', userId: 'u', orgId: null } };
        expect(sameIdentity(withOrg, noOrg)).toBe(false);
    });
});

describe('references', () => {
    it('creates opaque sec_<uuid> references and recognizes only those', () => {
        const ref = createSecretRef();
        expect(isSecretRef(ref)).toBe(true);
        expect(createSecretRef()).not.toBe(ref);
        for (const bad of ['', 'sec_', 'sec_123', '/aws/secret/path', 5, null]) {
            expect(isSecretRef(bad)).toBe(false);
        }
    });
});
