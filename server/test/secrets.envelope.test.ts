import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptEnvelope, encryptEnvelope, envelopeKeyId } from '../src/secrets/secret-envelope.js';

const KEY = randomBytes(32);
const CTX = {
    identityKey: '[["organization","org-1",null],"workspace","ws-1","environment-secret","env_var","row-1"]',
    ref: 'sec_a',
    logicalVersion: 'ver_1',
};
const ring = (id = 'k1', key = KEY) => new Map([[id, key]]);
const text = (s: string) => new TextEncoder().encode(s);

describe('the secret envelope', () => {
    it('round-trips a payload, an empty one included, and carries the key id', () => {
        for (const payload of [text('hello'), new Uint8Array(0), randomBytes(32_768)]) {
            const envelope = encryptEnvelope('k1', KEY, payload, CTX);
            expect(envelopeKeyId(envelope)).toBe('k1');
            const out = decryptEnvelope(ring(), envelope, CTX);
            expect(out.ok).toBe(true);
            expect(out.ok && Buffer.from(out.plaintext).equals(Buffer.from(payload))).toBe(true);
        }
    });

    it('draws a fresh nonce for every encryption', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 10_000; i += 1) {
            const envelope = encryptEnvelope('k1', KEY, text('same'), CTX);
            seen.add(envelope.subarray(2 + 2, 2 + 2 + 12).toString('hex'));
        }
        expect(seen.size).toBe(10_000);
    });

    it('produces different ciphertext for the same payload', () => {
        const a = encryptEnvelope('k1', KEY, text('same'), CTX);
        const b = encryptEnvelope('k1', KEY, text('same'), CTX);
        expect(a.equals(b)).toBe(false);
    });

    it.each([
        ['identity', { ...CTX, identityKey: `${CTX.identityKey}x` }],
        ['ref', { ...CTX, ref: 'sec_b' }],
        ['logical version', { ...CTX, logicalVersion: 'ver_2' }],
    ])('does not open under another %s', (_name, other) => {
        const envelope = encryptEnvelope('k1', KEY, text('secret'), CTX);
        expect(decryptEnvelope(ring(), envelope, other)).toEqual({ ok: false });
    });

    it('does not open when any byte is changed', () => {
        const envelope = encryptEnvelope('k1', KEY, text('secret'), CTX);
        for (let i = 0; i < envelope.length; i += 1) {
            const copy = Buffer.from(envelope);
            copy[i] = (copy[i] ?? 0) ^ 0x01;
            expect(decryptEnvelope(ring(), copy, CTX), `byte ${i}`).toEqual({ ok: false });
        }
    });

    it('does not open when truncated, extended or malformed', () => {
        const envelope = encryptEnvelope('k1', KEY, text('secret'), CTX);
        expect(decryptEnvelope(ring(), envelope.subarray(0, envelope.length - 1), CTX)).toEqual({ ok: false });
        expect(decryptEnvelope(ring(), Buffer.concat([envelope, Buffer.from([0])]), CTX)).toEqual({ ok: false });
        expect(decryptEnvelope(ring(), Buffer.alloc(0), CTX)).toEqual({ ok: false });
        expect(decryptEnvelope(ring(), Buffer.from([1]), CTX)).toEqual({ ok: false });
        expect(decryptEnvelope(ring(), Buffer.from([1, 200, 1, 2]), CTX)).toEqual({ ok: false });
        expect(envelopeKeyId(Buffer.from([1, 200, 1, 2]))).toBeNull();
    });

    it('does not open under an unknown key id or the same id with other bytes', () => {
        const envelope = encryptEnvelope('k1', KEY, text('secret'), CTX);
        expect(decryptEnvelope(ring('k2'), envelope, CTX)).toEqual({ ok: false });
        expect(decryptEnvelope(ring('k1', randomBytes(32)), envelope, CTX)).toEqual({ ok: false });
    });

    it('rejects a key that is not 32 bytes', () => {
        expect(() => encryptEnvelope('k1', randomBytes(31), text('x'), CTX)).toThrow();
        expect(decryptEnvelope(ring('k1', randomBytes(31)), encryptEnvelope('k1', KEY, text('x'), CTX), CTX)).toEqual({
            ok: false,
        });
    });
});
