import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { link, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
    LIST_LIMIT,
    type ListOptions,
    type ObjectCallOptions,
    type ObjectStore,
    type PutResult,
} from './object-store.js';
import { startIntervalLoop } from '../interval-loop.js';

const NOT_FOUND = 'ENOENT';
const ALREADY_EXISTS = 'EEXIST';

/** Well above `UPLOAD_WRITE_BOUND_MS`, the longest bounded write, so a live write is never swept. */
export const STALE_TEMP_MS = 3_600_000;
const SWEEP_DEADLINE_MS = 60_000;
const SWEEP_INTERVAL_MS = 3_600_000;
const TEMP_NAME = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export interface TempSweepResult {
    removed: number;
    skipped: number;
    stopped: boolean;
}

/** A temp file is stale when its mtime is before `cutoff`; any error leaves it alone. */
async function removeIfStale(path: string, cutoff: number): Promise<'removed' | 'skipped' | 'kept'> {
    try {
        if ((await lstat(path)).mtimeMs >= cutoff) return 'kept';
        await rm(path, { force: true });
        return 'removed';
    } catch {
        return 'skipped';
    }
}

/**
 * Removes the `<key>.<uuid>.tmp` files a process death left between `writeFile` and `put`'s `finally`.
 * Never follows a symlink, never touches an object, never throws: an entry it cannot read is `skipped`.
 */
export async function sweepStaleTemps(
    root: string,
    {
        olderThanMs = STALE_TEMP_MS,
        deadlineMs = SWEEP_DEADLINE_MS,
        now = Date.now,
    }: { olderThanMs?: number; deadlineMs?: number; now?: () => number } = {}
): Promise<TempSweepResult> {
    const result: TempSweepResult = { removed: 0, skipped: 0, stopped: false };
    const start = now();
    const dirs = [resolve(root)];
    for (let dir = dirs.pop(); dir !== undefined && !result.stopped; dir = dirs.pop()) {
        dirs.push(
            ...(await sweepDir(dir, result, { cutoff: start - olderThanMs, expired: () => now() - start > deadlineMs }))
        );
    }
    return result;
}

/** Sweeps one directory's files into `result` and returns its subdirectories. */
async function sweepDir(
    dir: string,
    result: TempSweepResult,
    { cutoff, expired }: { cutoff: number; expired: () => boolean }
): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) result.skipped++;
    const subdirs: string[] = [];
    for (const entry of entries ?? []) {
        if (expired()) {
            result.stopped = true;
            break;
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory()) subdirs.push(path);
        else if (entry.isFile() && TEMP_NAME.test(entry.name)) {
            const outcome = await removeIfStale(path, cutoff);
            if (outcome !== 'kept') result[outcome]++;
        }
    }
    return subdirs;
}

/** Runs `sweep` every `intervalMs` on an unref'd timer, skipping a tick while a pass is in flight. */
export function startTempSweep(
    sweep: () => Promise<TempSweepResult>,
    { intervalMs = SWEEP_INTERVAL_MS, log }: { intervalMs?: number; log: (line: string) => void }
): () => Promise<void> {
    return startIntervalLoop(
        'artifacts',
        async () => {
            const r = await sweep();
            if (r.removed > 0) log(`swept ${r.removed} stale temp files`);
        },
        intervalMs,
        { onError: (e) => log(`temp sweep failed: ${e.message}`), immediate: false }
    );
}

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/**
 * The filesystem backend: single replica only, because the directory is the store. A write lands
 * in a private temp file and is `link`ed into place, which is atomic and fails with EEXIST when the
 * key is taken — the same create-only guarantee `If-None-Match: *` gives, and a reader never sees
 * a half-written object.
 */
export function createFilesystemStore(root: string): ObjectStore {
    const base = resolve(root);
    const pathOf = (key: string): string => {
        const path = resolve(join(base, key));
        // Keys are built from validated segments; this is the second wall, not the first.
        if (!path.startsWith(base + sep)) throw new Error('object key escapes the store root');
        return path;
    };
    return {
        async put(key, body, options?: ObjectCallOptions): Promise<PutResult> {
            const path = pathOf(key);
            await mkdir(dirname(path), { recursive: true });
            const temp = `${path}.${randomUUID()}.tmp`;
            try {
                await writeFile(temp, body, options?.signal ? { signal: options.signal } : {});
                options?.signal?.throwIfAborted();
                await link(temp, path);
                return 'created';
            } catch (error) {
                if (errnoOf(error) === ALREADY_EXISTS) return 'exists';
                throw error;
            } finally {
                await rm(temp, { force: true });
            }
        },
        async get(key, options) {
            options?.signal?.throwIfAborted();
            try {
                return new Uint8Array(await readFile(pathOf(key), options?.signal ? { signal: options.signal } : {}));
            } catch (error) {
                if (errnoOf(error) === NOT_FOUND) return null;
                throw error;
            }
        },
        async head(key) {
            try {
                return { size: (await stat(pathOf(key))).size };
            } catch (error) {
                if (errnoOf(error) === NOT_FOUND) return null;
                throw error;
            }
        },
        async delete(key) {
            await rm(pathOf(key), { force: true });
        },
        async list(prefix, options?: ListOptions) {
            options?.signal?.throwIfAborted();
            const dir = pathOf(prefix);
            let entries: Dirent[];
            try {
                entries = await readdir(dir, { recursive: true, withFileTypes: true });
            } catch (error) {
                if (errnoOf(error) === NOT_FOUND) return [];
                throw error;
            }
            options?.signal?.throwIfAborted();
            const after = options?.after;
            return entries
                .filter((entry) => entry.isFile())
                .map((entry) => relative(base, join(entry.parentPath, entry.name)).split(sep).join('/'))
                .filter((key) => after === undefined || key > after)
                .sort()
                .slice(0, options?.limit ?? LIST_LIMIT);
        },
    };
}
