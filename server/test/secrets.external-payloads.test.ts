import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type ObjectClient, type ObjectRead, createExternalPayloads } from '../src/secrets/external-payloads.js';
import type { PayloadAad, StoredPayload } from '../src/secrets/secret-payloads.js';

/** The shared external payload store over a scripted provider client: the MAC, the names, the refusals. */
const utf8 = (value: string) => new TextEncoder().encode(value);
const AAD: PayloadAad = { identityKey: 'org|ws|x', ref: 'sec_1', logicalVersion: 'ver_1' };
const VERSION_ID = '7f1f0c4e-0000-4000-8000-000000000001';

function fakeClient() {
    const objects = new Map<string, { versionId: string; payload: Uint8Array }>();
    const removed: string[] = [];
    let readOverride: ((name: string, versionId: string) => ObjectRead) | undefined;
    const client: ObjectClient = {
        storage: 'aws',
        nameOf: (ref, versionId) => `pfx/${ref}/${versionId}`,
        async put({ name, versionId, payload }) {
            if (objects.has(name)) return 'exists';
            objects.set(name, { versionId, payload });
            return 'written';
        },
        async get(name, versionId) {
            if (readOverride) return readOverride(name, versionId);
            const found = objects.get(name);
            return found ? { name, versionId: found.versionId, payload: found.payload } : 'absent';
        },
        async remove(name) {
            removed.push(name);
            objects.delete(name);
        },
    };
    return {
        client,
        objects,
        removed,
        overrideRead: (fn: (name: string, versionId: string) => ObjectRead) => {
            readOverride = fn;
        },
    };
}

function setup() {
    const fake = fakeClient();
    const fingerprintKey = randomBytes(32);
    const store = createExternalPayloads(fake.client, { fingerprintKey });
    const stage = (payload: Uint8Array, aad = AAD, versionId = VERSION_ID): StoredPayload => {
        const columns = store.prepare(aad, versionId, payload);
        if (!columns) throw new Error('prepare returned null');
        return { ...columns, id: versionId, ref: aad.ref, logicalVersion: aad.logicalVersion };
    };
    return { ...fake, store, stage, fingerprintKey };
}

describe('the external payload store', () => {
    it('stages a reference, the version id and a MAC, and no envelope or key id', () => {
        const { stage, store } = setup();
        const row = stage(utf8('hello'));
        expect(store.storage).toBe('aws');
        expect(store.twoPhase).toBe(true);
        expect(row).toMatchObject({
            storage: 'aws',
            keyId: null,
            envelope: null,
            providerRef: `pfx/sec_1/${VERSION_ID}`,
            providerVersion: VERSION_ID,
        });
        expect(row.payloadMac).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(row)).not.toContain('hello');
    });

    it('binds the MAC to the payload, the identity, the reference and the logical version', () => {
        const { stage } = setup();
        const base = stage(utf8('hello')).payloadMac;
        expect(stage(utf8('hellp')).payloadMac).not.toBe(base);
        expect(stage(utf8('hello'), { ...AAD, identityKey: 'org|ws|y' }).payloadMac).not.toBe(base);
        expect(stage(utf8('hello'), { ...AAD, logicalVersion: 'ver_2' }).payloadMac).not.toBe(base);
        expect(stage(utf8('hello'), { ...AAD, ref: 'sec_2' }).payloadMac).not.toBe(base);
    });

    it('holds only a row prepared for this very payload, without calling the provider', () => {
        const { stage, store, objects } = setup();
        const row = stage(utf8('hello'));
        expect(store.holds(row, AAD, utf8('hello'))).toBe(true);
        expect(store.holds(row, AAD, utf8('other'))).toBe(false);
        expect(store.holds({ ...row, providerRef: 'pfx/sec_1/elsewhere' }, AAD, utf8('hello'))).toBe(false);
        expect(store.holds({ ...row, payloadMac: '0'.repeat(64) }, AAD, utf8('hello'))).toBe(false);
        expect(objects.size).toBe(0);
    });

    it('writes once and answers exists for the second write', async () => {
        const { stage, store } = setup();
        const row = stage(utf8('hello'));
        expect(await store.write(row, utf8('hello'), 1000, undefined)).toBe('written');
        expect(await store.write(row, utf8('hello'), 1000, undefined)).toBe('exists');
    });

    it('reads back the payload when the MAC verifies', async () => {
        const { stage, store } = setup();
        const row = stage(utf8('hello'));
        await store.write(row, utf8('hello'), 1000, undefined);
        const read = await store.read(row, AAD, 1000, undefined);
        expect(read).toBeInstanceOf(Uint8Array);
        expect(new TextDecoder().decode(read as Uint8Array)).toBe('hello');
    });

    it('reads absent only when the provider confirmed there is no object', async () => {
        const { stage, store } = setup();
        expect(await store.read(stage(utf8('hello')), AAD, 1000, undefined)).toBe('absent');
    });

    it('reads null for a payload whose MAC does not verify', async () => {
        const { stage, store, objects } = setup();
        const row = stage(utf8('hello'));
        await store.write(row, utf8('hello'), 1000, undefined);
        objects.set(row.providerRef as string, { versionId: VERSION_ID, payload: utf8('HELLO') });
        expect(await store.read(row, AAD, 1000, undefined)).toBeNull();
    });

    it('reads null when the provider answers another name or version, and for a malformed answer', async () => {
        const { stage, store, overrideRead } = setup();
        const row = stage(utf8('hello'));
        overrideRead((name) => ({ name: `${name}-other`, versionId: VERSION_ID, payload: utf8('hello') }));
        expect(await store.read(row, AAD, 1000, undefined)).toBeNull();
        overrideRead((name) => ({ name, versionId: 'another-version', payload: utf8('hello') }));
        expect(await store.read(row, AAD, 1000, undefined)).toBeNull();
        overrideRead(() => 'malformed');
        expect(await store.read(row, AAD, 1000, undefined)).toBeNull();
    });

    it('reads null for a row with no reference, version or MAC, and never calls the provider for it', async () => {
        const { stage, store, overrideRead } = setup();
        overrideRead(() => {
            throw new Error('the provider must not be called');
        });
        const row = stage(utf8('hello'));
        for (const broken of [
            { ...row, providerRef: null },
            { ...row, providerVersion: null },
            { ...row, payloadMac: null },
            { ...row, providerRef: 'another-prefix/sec_1/x' },
        ]) {
            expect(await store.read(broken, AAD, 1000, undefined)).toBeNull();
        }
    });

    it('removes only the object this row names, and refuses a foreign reference', async () => {
        const { stage, store, removed } = setup();
        const row = stage(utf8('hello'));
        await store.remove(row, 1000, undefined);
        expect(removed).toEqual([`pfx/sec_1/${VERSION_ID}`]);
        await expect(store.remove({ ...row, providerRef: 'pfx/other/secret' }, 1000, undefined)).rejects.toMatchObject({
            verdict: 'definitive',
        });
        expect(removed).toHaveLength(1);
    });
});
