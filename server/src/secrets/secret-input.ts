import { randomUUID } from 'node:crypto';
import {
    SECRET_PURPOSES,
    SECRET_SCOPE_TYPES,
    type SecretError,
    type SecretErrorCode,
    type SecretErrorReason,
    type SecretIdentity,
    type SecretRef,
} from './secret-store.js';

export const MAX_SECRET_BYTES = 32_768;
/** How long a completed operation's retry identity stays recognizable. */
const RETENTION_DAYS = 7;
const MS_PER_DAY = 86_400_000;
export const OPERATION_RETENTION_MS = RETENTION_DAYS * MS_PER_DAY;
const MAX_ID_LENGTH = 256;
const REF_PATTERN = /^sec_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function secretError(code: SecretErrorCode, reason: SecretErrorReason): SecretError {
    return { code, reason };
}

export function createSecretRef(): SecretRef {
    return `sec_${randomUUID()}` as SecretRef;
}

export function isSecretRef(value: unknown): value is SecretRef {
    return typeof value === 'string' && REF_PATTERN.test(value);
}

/** Opaque bytes, 0 through 32,768 inclusive; empty is valid, null and strings are not. */
export function validatePayload(payload: unknown): { ok: true; bytes: Uint8Array } | { ok: false; error: SecretError } {
    if (payload === null || payload === undefined) {
        return { ok: false, error: secretError('invalid-input', 'payload-null') };
    }
    if (!(payload instanceof Uint8Array)) {
        return { ok: false, error: secretError('invalid-input', 'payload-not-bytes') };
    }
    if (payload.byteLength > MAX_SECRET_BYTES) {
        return { ok: false, error: secretError('invalid-input', 'payload-too-large') };
    }
    return { ok: true, bytes: payload };
}

function isId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function validOwner(owner: unknown): boolean {
    if (!isObject(owner)) {
        return false;
    }
    if (owner.kind === 'organization') {
        return isId(owner.orgId);
    }
    return owner.kind === 'user' && isId(owner.userId) && (owner.orgId === null || isId(owner.orgId));
}

function validScope(scope: unknown): boolean {
    return (
        isObject(scope) &&
        typeof scope.type === 'string' &&
        (SECRET_SCOPE_TYPES as readonly string[]).includes(scope.type) &&
        isId(scope.id)
    );
}

function validOwningRecord(record: unknown): boolean {
    return isObject(record) && isId(record.type) && isId(record.id);
}

/** Null when the identity is well formed; never throws, whatever shape it is handed. */
export function validateIdentity(identity: unknown): SecretError | null {
    const valid =
        isObject(identity) &&
        validOwner(identity.owner) &&
        validScope(identity.scope) &&
        typeof identity.purpose === 'string' &&
        (SECRET_PURPOSES as readonly string[]).includes(identity.purpose) &&
        validOwningRecord(identity.owningRecord);
    return valid ? null : secretError('invalid-input', 'identity-invalid');
}

/** The canonical form of an identity: equal keys, equal identities. */
export function identityKey(identity: SecretIdentity): string {
    const { owner, scope, purpose, owningRecord } = identity;
    const ownerPart =
        owner.kind === 'organization' ? ['organization', owner.orgId, null] : ['user', owner.userId, owner.orgId];
    return JSON.stringify([ownerPart, scope.type, scope.id, purpose, owningRecord.type, owningRecord.id]);
}

export function sameIdentity(a: SecretIdentity, b: SecretIdentity): boolean {
    return identityKey(a) === identityKey(b);
}
