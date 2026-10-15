import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { ObjectStore, PutResult } from './object-store.js';

const NOT_FOUND = 'ENOENT';
const ALREADY_EXISTS = 'EEXIST';

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
        async put(key, body): Promise<PutResult> {
            const path = pathOf(key);
            await mkdir(dirname(path), { recursive: true });
            const temp = `${path}.${randomUUID()}.tmp`;
            await writeFile(temp, body);
            try {
                await link(temp, path);
                return 'created';
            } catch (error) {
                if (errnoOf(error) === ALREADY_EXISTS) return 'exists';
                throw error;
            } finally {
                await rm(temp, { force: true });
            }
        },
        async get(key) {
            try {
                return new Uint8Array(await readFile(pathOf(key)));
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
    };
}
