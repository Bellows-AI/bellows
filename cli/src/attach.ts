/**
 * `--attach <path>`: the local checks that run before any request, and the sequential keyed upload
 * of each file. The accepted extensions and the limits are copied from core/src/attachments.ts
 * (this package imports nothing); `server/test/attachments.cli-copy.test.ts` pins the copy.
 */

import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { BoardClient } from './board.js';
import {
    ATTACHMENT_NAME_HEADER,
    CONTENT_TYPE_HEADER,
    IDEMPOTENCY_KEY_HEADER,
    OCTET_STREAM_CONTENT_TYPE,
} from './http.js';
import { UsageError } from './input.js';
import { BoardError } from './transport.js';
import type { Transport } from './transport.js';

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const FILE_MIB = 20;
const REQUEST_MIB = 50;

export const ATTACH_OPTION = { attach: { type: 'string', multiple: true } } as const;

export const MAX_FILES_PER_REQUEST = 10;
export const MAX_FILE_BYTES = FILE_MIB * BYTES_PER_MIB;
export const MAX_REQUEST_BYTES = REQUEST_MIB * BYTES_PER_MIB;
/** The extensions the board accepts; it decides the type from the bytes, this only spares a round trip. */
export const ATTACHMENT_EXTENSIONS: readonly string[] = [
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.pdf',
    '.docx',
    '.txt',
    '.md',
    '.csv',
];

/** The slowest link one attempt is sized for: a maximum-size file must finish inside its deadline. */
const MIN_UPLOAD_KIB_PER_S = 256;
const MIN_UPLOAD_BYTES_PER_S = MIN_UPLOAD_KIB_PER_S * BYTES_PER_KIB;
const MS_PER_SECOND = 1000;

/** The longest `--idempotency-key` that still leaves room for the `.a<N>` suffix under the board's 128-character bound. */
const KEY_MAX = 128;
const KEY_SUFFIX_ROOM = 6;

/** What one attempt may spend moving `bytes`, on top of the transport's base deadline. */
export function uploadAllowanceMs(bytes: number): number {
    return Math.ceil((bytes / MIN_UPLOAD_BYTES_PER_S) * MS_PER_SECOND);
}

export interface AttachFile {
    path: string;
    name: string;
    size: number;
}

/** Why a path cannot be read: absence and a permission problem are told apart, never both "missing". */
async function checkOne(path: string): Promise<AttachFile> {
    let info: Stats;
    try {
        info = await stat(path);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') throw new UsageError(`--attach ${path}: no such file`);
        throw new UsageError(`--attach ${path}: cannot be read (${code ?? String(error)})`);
    }
    if (!info.isFile()) throw new UsageError(`--attach ${path}: not a regular file`);
    try {
        await (await open(path, 'r')).close();
    } catch (error) {
        throw new UsageError(`--attach ${path}: not readable (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    const extension = extname(path).toLowerCase();
    if (!ATTACHMENT_EXTENSIONS.includes(extension)) {
        throw new UsageError(`--attach ${path}: ${extension || 'a file without an extension'} is not an accepted type`);
    }
    if (info.size > MAX_FILE_BYTES) {
        throw new UsageError(`--attach ${path}: ${info.size} bytes; the limit is ${MAX_FILE_BYTES} per file`);
    }
    return { path, name: basename(path), size: info.size };
}

/** Every path checked, in order, before the first request; the first problem refuses the whole command. */
export async function checkAttachments(paths: readonly string[], key: string | undefined): Promise<AttachFile[]> {
    if (paths.length > MAX_FILES_PER_REQUEST) {
        throw new UsageError(`at most ${MAX_FILES_PER_REQUEST} --attach files per request, got ${paths.length}`);
    }
    if (key !== undefined && key.length > KEY_MAX - KEY_SUFFIX_ROOM) {
        throw new UsageError(`--idempotency-key is limited to ${KEY_MAX - KEY_SUFFIX_ROOM} characters with --attach`);
    }
    const files: AttachFile[] = [];
    for (const path of paths) files.push(await checkOne(path));
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_REQUEST_BYTES) {
        throw new UsageError(`--attach files total ${total} bytes; the limit is ${MAX_REQUEST_BYTES} per request`);
    }
    return files;
}

/**
 * Uploads each file in order and returns the ids. Each upload is keyed: `<key>.a<N>` under the
 * caller's key (a rerun replays them), a fresh random key otherwise (a transport retry replays).
 * A failure leaves the earlier uploads as drafts for the board's sweep; nothing is deleted here.
 */
export async function uploadAttachments(
    board: BoardClient,
    files: readonly AttachFile[],
    key: string | undefined,
    progress: (line: string) => void
): Promise<string[]> {
    const ids: string[] = [];
    for (const [index, file] of files.entries()) {
        progress(`uploading ${file.name} (${index + 1}/${files.length})\n`);
        const bytes = await readFile(file.path);
        try {
            const uploaded = await board.uploadAttachment({
                name: file.name,
                bytes,
                idempotencyKey: key === undefined ? randomUUID() : `${key}.a${index + 1}`,
            });
            ids.push(uploaded.id);
        } catch (error) {
            if (!(error instanceof BoardError)) throw error;
            throw new BoardError(`${file.name}: ${error.message}`, error.status, error.code);
        }
    }
    return ids;
}

/** The upload route over the board client's transport: a raw body, its name percent-encoded, always keyed. */
export function attachRoutes(
    request: Transport['request'],
    authHeaders: () => Record<string, string>
): Pick<BoardClient, 'uploadAttachment'> {
    return {
        async uploadAttachment({ name, bytes, idempotencyKey }) {
            const target = () => ({ path: '/api/attachments', holdMs: 0, transferMs: uploadAllowanceMs(bytes.length) });
            const headers = {
                ...authHeaders(),
                [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
                [CONTENT_TYPE_HEADER]: OCTET_STREAM_CONTENT_TYPE,
                [ATTACHMENT_NAME_HEADER]: encodeURIComponent(name),
            };
            return (await request(target, { method: 'POST', headers, body: bytes })) as { id: string };
        },
    };
}

/** The ids of the `--attach` files, or undefined when there are none: checked, then uploaded in turn. */
export async function attachedIds(
    paths: readonly string[],
    key: string | undefined,
    board: BoardClient,
    progress: (line: string) => void
): Promise<string[] | undefined> {
    if (paths.length === 0) return undefined;
    return uploadAttachments(board, await checkAttachments(paths, key), key, progress);
}
