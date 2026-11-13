import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chunkKey } from '../src/artifacts/keys.js';
import { attachmentKey } from '../src/attachments/attachment-store.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { BACKENDS } from './artifacts-backends.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (body: Uint8Array | null) => (body ? new TextDecoder().decode(body) : null);

const REF = {
    member: 'member-1',
    root: 'root-1',
    job: 'job-1',
    claimSeq: 1,
    executor: 'claude-code',
    session: 'session-1',
    stream: 'raw',
};
const MIB = 1024 * 1024;

/** Every backend answers to the same contract: the index in artifact-store.ts relies on all of it. */
describe.each(BACKENDS)('object store contract: $name', ({ make, prefix, skip }) => {
    const fresh = async () => {
        const store: ObjectStore = await make();
        // Unique per test, so a shared bucket never carries one test's objects into another.
        const key = (offset: number) => chunkKey(prefix, 'org-1', { ...REF, job: `job-${randomUUID()}` }, offset);
        return {
            store,
            key: key(0),
            keyAt: (job: string, offset: number) => chunkKey(prefix, 'org-1', { ...REF, job }, offset),
        };
    };

    it.skipIf(skip)('creates an object once and reads it back', async () => {
        const { store, key } = await fresh();
        expect(await store.put(key, bytes('hello'))).toBe('created');
        expect(text(await store.get(key))).toBe('hello');
        expect(await store.head(key)).toEqual({ size: 5 });
    });

    it.skipIf(skip)('answers exists to an identical retry and leaves the stored body alone', async () => {
        const { store, key } = await fresh();
        await store.put(key, bytes('first'));
        expect(await store.put(key, bytes('first'))).toBe('exists');
        expect(text(await store.get(key))).toBe('first');
    });

    it.skipIf(skip)('answers exists to a different body and never overwrites', async () => {
        const { store, key } = await fresh();
        await store.put(key, bytes('first'));
        expect(await store.put(key, bytes('second'))).toBe('exists');
        expect(text(await store.get(key))).toBe('first');
    });

    it.skipIf(skip)('answers null for an absent key', async () => {
        const { store, key } = await fresh();
        expect(await store.get(key)).toBeNull();
        expect(await store.head(key)).toBeNull();
    });

    it.skipIf(skip)('deletes idempotently, after which the key is writable again', async () => {
        const { store, key } = await fresh();
        await store.put(key, bytes('gone'));
        await store.delete(key);
        await store.delete(key);
        expect(await store.get(key)).toBeNull();
        expect(await store.put(key, bytes('again'))).toBe('created');
        expect(text(await store.get(key))).toBe('again');
    });

    it.skipIf(skip)('round-trips every byte value and a multi-megabyte body unchanged', async () => {
        const { store, key, keyAt } = await fresh();
        const all = Uint8Array.from({ length: 256 }, (_, i) => i);
        await store.put(key, all);
        expect(Array.from((await store.get(key))!)).toEqual(Array.from(all));

        const big = new Uint8Array(3 * MIB).map((_, i) => (i * 31) % 251);
        const bigKey = keyAt(`job-${randomUUID()}`, 123_456_789);
        await store.put(bigKey, big);
        const back = (await store.get(bigKey))!;
        expect(back.length).toBe(big.length);
        expect(Buffer.from(back).equals(Buffer.from(big))).toBe(true);
    });

    it.skipIf(skip)('lets exactly one of several concurrent writers create the key', async () => {
        const { store, key } = await fresh();
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) => store.put(key, bytes(`writer ${i}`))));
        expect(results.filter((r) => r === 'created')).toHaveLength(1);
        expect(results.filter((r) => r === 'exists')).toHaveLength(5);
    });

    it.skipIf(skip)('round-trips an object in the attachment namespace, apart from the artifact keys', async () => {
        const { store, key } = await fresh();
        const id = randomUUID();
        const attachment = attachmentKey(prefix, 'org-1', id);
        expect(attachment).not.toBe(key);
        expect(attachment.startsWith(`${prefix}_attachments/org-1/`)).toBe(true);
        expect(await store.put(attachment, bytes('draft'))).toBe('created');
        expect(await store.put(attachment, bytes('other'))).toBe('exists');
        expect(text(await store.get(attachment))).toBe('draft');
        expect(await store.head(attachment)).toEqual({ size: 5 });
        await store.delete(attachment);
        expect(await store.get(attachment)).toBeNull();
        await store.delete(attachment);
    });

    it.skipIf(skip)('lists the keys under a prefix up to a limit, and none of a neighbouring prefix', async () => {
        const { store } = await fresh();
        const org = `org-${randomUUID().slice(0, 8)}`;
        const mine = [
            chunkKey(prefix, org, { ...REF, job: 'job-a' }, 0),
            chunkKey(prefix, org, { ...REF, job: 'job-b' }, 1),
            attachmentKey(prefix, org, randomUUID()),
        ];
        const neighbour = chunkKey(prefix, `${org}0`, REF, 0);
        for (const key of [...mine, neighbour]) await store.put(key, bytes('x'));

        const listed = [
            ...(await store.list(`${prefix}${org}/`)),
            ...(await store.list(`${prefix}_attachments/${org}/`)),
        ];
        expect(listed.sort()).toEqual([...mine].sort());
        expect(await store.list(`${prefix}${org}/`, { limit: 1 })).toHaveLength(1);
        expect(await store.list(`${prefix}_skills/${org}/`)).toEqual([]);

        for (const key of listed) await store.delete(key);
        expect(await store.list(`${prefix}${org}/`)).toEqual([]);
        expect(await store.list(`${prefix}${org}0/`)).toEqual([neighbour]);
    });

    it.skipIf(skip)('pages a namespace in key order: each page resumes after the last key it saw', async () => {
        const { store } = await fresh();
        const org = `org-${randomUUID().slice(0, 8)}`;
        const keys = [0, 1, 2, 3, 4].map((offset) => chunkKey(prefix, org, REF, offset));
        for (const key of keys) await store.put(key, bytes('x'));

        const seen: string[] = [];
        let page = await store.list(`${prefix}${org}/`, { limit: 2 });
        while (page.length) {
            seen.push(...page);
            page = await store.list(`${prefix}${org}/`, { limit: 2, after: page.at(-1) });
        }
        expect(seen).toEqual(keys);

        for (const key of keys) await store.delete(key);
    });
});
