import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The secret store's key material, read from the environment of the dashboard process only (docs/secrets.md).
 * Pure: no I/O. Every refusal names the variable (and the key id), never a value.
 */

const KEY_BYTES = 32;
const KEY_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The keys every backend needs: operation ids and the operation-record fingerprint. */
export interface OperationKeys {
    /** MACs operation ids. Separate from every data key. */
    readonly operationKey: Buffer;
    /** Keys the payload fingerprint of an operation record. Separate from every other key. */
    readonly fingerprintKey: Buffer;
}

/** The AES key ring of the database backend. */
export interface DataKeys {
    /** key id -> 32 bytes; decrypts any envelope whose header names one of them. */
    readonly dataKeys: ReadonlyMap<string, Buffer>;
    /** Encrypts new versions; always a member of `dataKeys`. */
    readonly activeKeyId: string;
}

export interface SecretKeys extends OperationKeys, DataKeys {}

export class SecretKeyConfigError extends Error {}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
        throw new SecretKeyConfigError(`${name} is required`);
    }
    return value.trim();
}

/** Canonical base64 of exactly 32 bytes; anything else is refused without echoing it. */
function decodeKey(encoded: string, label: string): Buffer {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) {
        throw new SecretKeyConfigError(`${label} must be base64`);
    }
    if (bytes.length !== KEY_BYTES) {
        throw new SecretKeyConfigError(`${label} must be ${KEY_BYTES} bytes`);
    }
    return bytes;
}

const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export function loadOperationKeys(env: Env): OperationKeys {
    const operationKey = decodeKey(required(env, 'SECRETS_OPERATION_KEY'), 'SECRETS_OPERATION_KEY');
    const fingerprintKey = decodeKey(required(env, 'SECRETS_FINGERPRINT_KEY'), 'SECRETS_FINGERPRINT_KEY');
    if (same(operationKey, fingerprintKey)) {
        throw new SecretKeyConfigError('SECRETS_FINGERPRINT_KEY must differ from SECRETS_OPERATION_KEY');
    }
    return { operationKey, fingerprintKey };
}

export function loadDataKeys(env: Env): DataKeys {
    const ring = new Map<string, Buffer>();
    for (const entry of required(env, 'SECRETS_DATA_KEYS').split(',')) {
        const at = entry.indexOf(':');
        const id = at < 0 ? '' : entry.slice(0, at).trim();
        if (!KEY_ID.test(id)) {
            throw new SecretKeyConfigError('SECRETS_DATA_KEYS entries must be <keyId>:<base64 key>');
        }
        if (ring.has(id)) {
            throw new SecretKeyConfigError(`SECRETS_DATA_KEYS repeats key id ${id}`);
        }
        ring.set(id, decodeKey(entry.slice(at + 1).trim(), `SECRETS_DATA_KEYS key ${id}`));
    }
    const activeKeyId = required(env, 'SECRETS_ACTIVE_KEY_ID');
    if (!ring.has(activeKeyId)) {
        throw new SecretKeyConfigError('SECRETS_ACTIVE_KEY_ID is not a key id in SECRETS_DATA_KEYS');
    }
    return { dataKeys: ring, activeKeyId };
}

/** Refuses a data key that equals one of the operation keys. */
function assertDistinct(data: DataKeys, operation: OperationKeys): void {
    for (const [id, key] of data.dataKeys) {
        if (same(key, operation.operationKey)) {
            throw new SecretKeyConfigError(`SECRETS_OPERATION_KEY must differ from data key ${id}`);
        }
        if (same(key, operation.fingerprintKey)) {
            throw new SecretKeyConfigError(`SECRETS_FINGERPRINT_KEY must differ from data key ${id}`);
        }
    }
}

export function loadSecretKeys(env: Env): SecretKeys {
    const data = loadDataKeys(env);
    const operation = loadOperationKeys(env);
    assertDistinct(data, operation);
    return { ...data, ...operation };
}

/** The MAC of an operation id's `<issuedAt>.<nonce>` part. */
export function operationMac(keys: Pick<OperationKeys, 'operationKey'>, data: string): string {
    return createHmac('sha256', keys.operationKey).update(data).digest('hex');
}

/** HMAC of what an operation asked for; never a bare hash of the payload. */
export function payloadFingerprint(
    keys: Pick<OperationKeys, 'fingerprintKey'>,
    request: { kind: string; ref: string; expectedVersion: string | null; payload: Uint8Array }
): string {
    return createHmac('sha256', keys.fingerprintKey)
        .update(`${request.kind}|${request.ref}|${request.expectedVersion ?? ''}|`)
        .update(request.payload)
        .digest('hex');
}
