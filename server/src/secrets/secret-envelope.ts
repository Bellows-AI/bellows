import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The versioned AES-256-GCM envelope a secret payload takes in PostgreSQL (docs/secrets.md). Pure: no I/O.
 *
 *   0x01 | keyIdLen u8 | keyId | nonce (12, random per encryption) | ciphertext | tag (16)
 *
 * The additional authenticated data binds the header (so the key id cannot be swapped), the canonical
 * identity, the reference and the logical version: an envelope copied to another row never opens. Decryption
 * always checks the tag and answers `{ ok: false }` for every failure, never plaintext and never a reason.
 */

const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_KEY_ID_BYTES = 255;
const AAD_LABEL = 'factory-ai/secret/v1\0';

export interface EnvelopeContext {
    identityKey: string;
    ref: string;
    logicalVersion: string;
}

function additionalData(header: Buffer, ctx: EnvelopeContext): Buffer {
    return Buffer.concat([
        Buffer.from(AAD_LABEL),
        header,
        Buffer.from(`\0${ctx.identityKey}\0${ctx.ref}\0${ctx.logicalVersion}`),
    ]);
}

export function encryptEnvelope(keyId: string, key: Buffer, plaintext: Uint8Array, ctx: EnvelopeContext): Buffer {
    const id = Buffer.from(keyId, 'utf8');
    if (key.length !== KEY_BYTES || id.length === 0 || id.length > MAX_KEY_ID_BYTES) {
        throw new Error('secret envelope: invalid key');
    }
    const header = Buffer.concat([Buffer.from([FORMAT_VERSION, id.length]), id]);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(additionalData(header, ctx));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, nonce, body, cipher.getAuthTag()]);
}

/** The key id in the header, or null when the bytes are not a well-formed header. Not authenticated. */
export function envelopeKeyId(envelope: Uint8Array): string | null {
    const buf = Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);
    if (buf.length < 2 || buf[0] !== FORMAT_VERSION) {
        return null;
    }
    const idLength = buf[1] ?? 0;
    if (idLength === 0 || buf.length < 2 + idLength + NONCE_BYTES + TAG_BYTES) {
        return null;
    }
    return buf.subarray(2, 2 + idLength).toString('utf8');
}

export type DecryptResult = { ok: true; plaintext: Uint8Array } | { ok: false };

export function decryptEnvelope(
    keys: ReadonlyMap<string, Buffer>,
    envelope: Uint8Array,
    ctx: EnvelopeContext
): DecryptResult {
    const keyId = envelopeKeyId(envelope);
    const key = keyId === null ? undefined : keys.get(keyId);
    if (keyId === null || key === undefined || key.length !== KEY_BYTES) {
        return { ok: false };
    }
    const buf = Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);
    const headerLength = 2 + Buffer.byteLength(keyId, 'utf8');
    try {
        const header = buf.subarray(0, headerLength);
        const nonce = buf.subarray(headerLength, headerLength + NONCE_BYTES);
        const body = buf.subarray(headerLength + NONCE_BYTES, buf.length - TAG_BYTES);
        const tag = buf.subarray(buf.length - TAG_BYTES);
        const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
        decipher.setAAD(additionalData(header, ctx));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
        return { ok: true, plaintext: Uint8Array.from(plaintext) };
    } catch {
        return { ok: false };
    }
}
