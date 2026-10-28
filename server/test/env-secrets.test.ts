import { describe, expect, it } from 'vitest';
import {
    decodeEnvSecret,
    EnvSecretError,
    type EncryptedEnvRow,
    encodeEnvSecret,
    envSecretIdentity,
    readSecretValues,
} from '../src/db/env-secrets.js';
import type { SecretStore, SecretVersion } from '../src/secrets/secret-store.js';

const VERSION = 'v1';

const rows = (n: number): EncryptedEnvRow[] =>
    Array.from({ length: n }, (_, i) => ({
        name: `SECRET_${i}`,
        ref: `ref-${i}`,
        version: VERSION,
        identity: envSecretIdentity('org-a', { kind: 'org' }, `SECRET_${i}`),
    }));

/** A store whose reads ignore the abort signal and answer after `delayMs`, like a slow database boundary. */
function slowStore(delayMs: number): { store: SecretStore; started: () => number } {
    let started = 0;
    const readActive = async () => {
        started++;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { ok: true as const, version: VERSION as SecretVersion, value: encodeEnvSecret('value') };
    };
    return { store: { readActive } as unknown as SecretStore, started: () => started };
}

describe('env secret codec', () => {
    it('round-trips a leading byte-order mark', () => {
        const value = '﻿token';
        expect(decodeEnvSecret(encodeEnvSecret(value))).toBe(value);
    });

    it('refuses bytes that are not UTF-8', () => {
        expect(() => decodeEnvSecret(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
    });
});

describe('readSecretValues', () => {
    it('rejects at the batch deadline even when the store ignores the signal', async () => {
        const { store } = slowStore(200);
        const startedAt = Date.now();
        const error = await readSecretValues(store, rows(2), { deadlineMs: 20, concurrency: 2 }).catch((e) => e);
        expect(error).toBeInstanceOf(EnvSecretError);
        expect((error as EnvSecretError).code).toBe('unavailable');
        expect(Date.now() - startedAt).toBeLessThan(150);
    });

    it('starts no further read once the deadline has passed', async () => {
        const { store, started } = slowStore(40);
        await readSecretValues(store, rows(6), { deadlineMs: 10, concurrency: 2 }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(started()).toBe(2);
    });

    it('returns every value in row order inside the deadline', async () => {
        const { store } = slowStore(1);
        await expect(readSecretValues(store, rows(3), { deadlineMs: 1000 })).resolves.toEqual([
            'value',
            'value',
            'value',
        ]);
    });
});
