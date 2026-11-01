import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArtifactBackend } from '../src/artifacts/backend.js';
import { createFilesystemStore, STALE_TEMP_MS, startTempSweep, sweepStaleTemps } from '../src/artifacts/fs-store.js';
import type { ArtifactsConfig } from '../src/config-artifacts.js';

const HOUR = 3_600_000;
const tempName = (key: string) => `${key}.${randomUUID()}.tmp`;
const root = () => mkdtemp(join(tmpdir(), 'fs-store-sweep-'));
const ago = async (path: string, ms: number) => {
    const when = new Date(Date.now() - ms);
    await utimes(path, when, when);
};
const exists = (path: string) =>
    stat(path).then(
        () => true,
        () => false
    );
const OPTIONS = { olderThanMs: STALE_TEMP_MS, deadlineMs: 60_000 };

async function tempFilesUnder(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (entry.isFile() && entry.name.endsWith('.tmp')) found.push(join(entry.parentPath, entry.name));
    }
    return found;
}

afterEach(() => vi.useRealTimers());

describe('sweepStaleTemps', () => {
    it('removes a stale temp file at any depth and keeps a young one', async () => {
        const dir = await root();
        await mkdir(join(dir, 'a', 'b'), { recursive: true });
        const stale = join(dir, 'a', 'b', tempName('k'));
        const young = join(dir, 'a', tempName('young'));
        await writeFile(stale, 'x');
        await writeFile(young, 'x');
        await ago(stale, 2 * HOUR);
        const result = await sweepStaleTemps(dir, OPTIONS);
        expect(result.removed).toBe(1);
        expect(await exists(stale)).toBe(false);
        expect(await exists(young)).toBe(true);
    });

    it('never touches an object, even one whose key ends in .tmp', async () => {
        const dir = await root();
        await mkdir(join(dir, 'x'), { recursive: true });
        const plain = join(dir, 'x', 'y');
        const dotted = join(dir, 'x', 'z.tmp');
        await writeFile(plain, 'plain');
        await writeFile(dotted, 'dotted');
        await ago(plain, 5 * HOUR);
        await ago(dotted, 5 * HOUR);
        const result = await sweepStaleTemps(dir, OPTIONS);
        expect(result.removed).toBe(0);
        expect(await readFile(plain, 'utf8')).toBe('plain');
        expect(await readFile(dotted, 'utf8')).toBe('dotted');
    });

    it.skipIf(process.getuid?.() === 0)('skips what it cannot read and keeps going', async () => {
        const dir = await root();
        await mkdir(join(dir, 'a-locked'), { recursive: true });
        const stale = join(dir, tempName('z'));
        await writeFile(stale, 'x');
        await ago(stale, 2 * HOUR);
        await chmod(join(dir, 'a-locked'), 0o000);
        try {
            const result = await sweepStaleTemps(dir, OPTIONS);
            expect(result.skipped).toBeGreaterThanOrEqual(1);
            expect(await exists(stale)).toBe(false);
        } finally {
            await chmod(join(dir, 'a-locked'), 0o700);
        }
    });

    it('stops at its wall-clock deadline', async () => {
        const dir = await root();
        const paths = [join(dir, tempName('a')), join(dir, tempName('b'))];
        for (const path of paths) {
            await writeFile(path, 'x');
            await ago(path, 2 * HOUR);
        }
        let calls = 0;
        const now = () => (++calls <= 2 ? 0 : 1_000_000_000);
        const result = await sweepStaleTemps(dir, { ...OPTIONS, now });
        expect(result.stopped).toBe(true);
        expect(result.removed).toBeLessThanOrEqual(1);
    });

    it('does not follow a symlink out of the root', async () => {
        const dir = await root();
        const outside = await root();
        const stale = join(outside, tempName('o'));
        await writeFile(stale, 'x');
        await ago(stale, 2 * HOUR);
        const { symlink } = await import('node:fs/promises');
        await symlink(outside, join(dir, 'link'));
        await sweepStaleTemps(dir, OPTIONS);
        expect(await exists(stale)).toBe(true);
    });
});

describe('boot and periodic sweep', () => {
    it('prepare sweeps the filesystem root on boot', async () => {
        const dir = await root();
        const stale = join(dir, tempName('k'));
        await writeFile(stale, 'x');
        await ago(stale, 2 * HOUR);
        const line = await createArtifactBackend({
            backend: { kind: 'filesystem', root: dir },
        } as ArtifactsConfig).prepare();
        expect(await exists(stale)).toBe(false);
        expect(line).toContain('swept 1');
    });

    it('a young temp file kept at boot is removed by a later pass once it ages', async () => {
        vi.useFakeTimers();
        const dir = await root();
        const young = join(dir, tempName('k'));
        await writeFile(young, 'x');
        let clock = Date.now();
        const passes: Promise<unknown>[] = [];
        const sweep = () => sweepStaleTemps(dir, { ...OPTIONS, now: () => clock });
        expect((await sweep()).removed).toBe(0);
        const stop = startTempSweep(
            () => {
                const run = sweep();
                passes.push(run);
                return run;
            },
            { intervalMs: HOUR, log: () => {} }
        );
        try {
            clock += 2 * HOUR;
            await vi.advanceTimersByTimeAsync(HOUR);
            await Promise.all(passes);
            expect(await exists(young)).toBe(false);
        } finally {
            stop();
        }
    });

    it('never runs two passes at once and stops ticking after stop()', async () => {
        vi.useFakeTimers();
        let release: () => void = () => {};
        const sweep = vi.fn(
            () =>
                new Promise<{ removed: number; skipped: number; stopped: boolean }>((resolve) => {
                    release = () => resolve({ removed: 0, skipped: 0, stopped: false });
                })
        );
        const stop = startTempSweep(sweep, { intervalMs: 1000, log: () => {} });
        await vi.advanceTimersByTimeAsync(3500);
        expect(sweep).toHaveBeenCalledTimes(1);
        release();
        await vi.advanceTimersByTimeAsync(1000);
        expect(sweep).toHaveBeenCalledTimes(2);
        stop();
        release();
        await vi.advanceTimersByTimeAsync(5000);
        expect(sweep).toHaveBeenCalledTimes(2);
    });

    it('a sweep that throws is logged and the next tick still runs', async () => {
        vi.useFakeTimers();
        const log = vi.fn();
        const sweep = vi
            .fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValue({ removed: 0, skipped: 0, stopped: false });
        const stop = startTempSweep(sweep, { intervalMs: 1000, log });
        await vi.advanceTimersByTimeAsync(2500);
        stop();
        expect(sweep).toHaveBeenCalledTimes(2);
        expect(log.mock.calls.flat().join(' ')).toContain('boom');
    });
});

// Regression pin: green on the code before the sweep existed. `put` already removes its own temp in `finally`.
describe('a put that fails leaves no temp file', () => {
    it('after an aborted signal', async () => {
        const dir = await root();
        const store = createFilesystemStore(dir);
        const controller = new AbortController();
        controller.abort();
        await expect(store.put('k/a', new Uint8Array([1]), { signal: controller.signal })).rejects.toThrow();
        expect(await tempFilesUnder(dir)).toEqual([]);
    });

    it('after losing an EEXIST race', async () => {
        const dir = await root();
        const store = createFilesystemStore(dir);
        expect(await store.put('k/a', new Uint8Array([1]))).toBe('created');
        expect(await store.put('k/a', new Uint8Array([2]))).toBe('exists');
        expect(await tempFilesUnder(dir)).toEqual([]);
    });

    it.skipIf(process.getuid?.() === 0)('into a read-only parent directory', async () => {
        const dir = await root();
        const store = createFilesystemStore(dir);
        await mkdir(join(dir, 'ro'));
        await chmod(join(dir, 'ro'), 0o500);
        try {
            await expect(store.put('ro/a', new Uint8Array([1]))).rejects.toThrow();
        } finally {
            await chmod(join(dir, 'ro'), 0o700);
        }
        expect(await tempFilesUnder(dir)).toEqual([]);
    });
});
