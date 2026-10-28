import { timingSafeEqual } from 'node:crypto';
import { decryptEnvelope, encryptEnvelope, envelopeKeyId } from './secret-envelope.js';
import type { DataKeys } from './secret-keys.js';
import type { PayloadAad, PayloadColumns, PayloadStore, StoredPayload } from './secret-payloads.js';

/**
 * The database payload store: the payload is an AES-256-GCM envelope in the version row itself, so staging
 * the row is the provider write and deleting it the removal (`write` and `remove` have nothing to do).
 * `seal` and `open` are also what rotation re-encrypts with (`postgres-secret-maintenance.ts`).
 */

/** Constant-time equality of two byte strings of any length. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
}

export class DatabasePayloads implements PayloadStore {
    readonly storage = 'database';
    readonly twoPhase = false;

    constructor(private readonly keys: DataKeys) {}

    get activeKeyId(): string {
        return this.keys.activeKeyId;
    }

    /** Encrypts under the active key; null when the active key is not in the ring. */
    seal(aad: PayloadAad, payload: Uint8Array): { keyId: string; envelope: Buffer } | null {
        const keyId = this.keys.activeKeyId;
        const key = this.keys.dataKeys.get(keyId);
        return key ? { keyId, envelope: encryptEnvelope(keyId, key, payload, aad) } : null;
    }

    /** The plaintext of a stored envelope, or null when anything about it does not check out. */
    open(row: Pick<PayloadColumns, 'keyId' | 'envelope'>, aad: PayloadAad): Uint8Array | null {
        if (row.keyId === null || row.envelope === null || envelopeKeyId(row.envelope) !== row.keyId) {
            return null;
        }
        const out = decryptEnvelope(this.keys.dataKeys, row.envelope, aad);
        return out.ok ? out.plaintext : null;
    }

    prepare(aad: PayloadAad, _versionId: string, payload: Uint8Array): PayloadColumns | null {
        const sealed = this.seal(aad, payload);
        return sealed
            ? { storage: 'database', ...sealed, providerRef: null, providerVersion: null, payloadMac: null }
            : null;
    }

    holds(row: StoredPayload, aad: PayloadAad, payload: Uint8Array): boolean {
        const plaintext = this.open(row, aad);
        return plaintext !== null && sameBytes(plaintext, payload);
    }

    async write(): Promise<'written'> {
        return 'written';
    }

    async read(row: StoredPayload, aad: PayloadAad): Promise<Uint8Array | null> {
        return this.open(row, aad);
    }

    async remove(): Promise<void> {}
}
