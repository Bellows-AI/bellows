import type { AttachmentRow, AttachmentRows } from '../src/attachments/attachment-rows.js';
import { IdempotencyKeyReusedError } from '../src/db/jobs/job-store-idempotency.js';

/** Byte builders for the attachment tests: each makes the smallest file the sniffer recognizes. */

const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16be = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s: string) => [...Buffer.from(s, 'latin1')];

export const pngBytes = (width = 4, height = 4): Uint8Array =>
    Uint8Array.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...u32be(13),
        ...ascii('IHDR'),
        ...u32be(width),
        ...u32be(height),
        8,
        6,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    ]);

export const jpegBytes = (width = 4, height = 4): Uint8Array =>
    Uint8Array.from([
        0xff,
        0xd8,
        0xff,
        0xe0,
        ...u16be(4),
        0,
        0,
        0xff,
        0xc0,
        ...u16be(11),
        8,
        ...u16be(height),
        ...u16be(width),
        1,
        1,
        0x11,
        0,
        0xff,
        0xd9,
    ]);

/** A lossless-extended (VP8X) WebP whose canvas is `width` x `height`. */
export const webpBytes = (width = 4, height = 4): Uint8Array =>
    Uint8Array.from([
        ...ascii('RIFF'),
        ...u32le(22),
        ...ascii('WEBP'),
        ...ascii('VP8X'),
        ...u32le(10),
        0,
        0,
        0,
        0,
        ...u32le(width - 1).slice(0, 3),
        ...u32le(height - 1).slice(0, 3),
    ]);

export const pdfBytes = (): Uint8Array => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

/** A ZIP of empty stored entries: local headers, a central directory naming them, an end record. */
export function zipBytes(names: readonly string[]): Uint8Array {
    const locals: number[] = [];
    const central: number[] = [];
    for (const name of names) {
        const offset = locals.length;
        const nameBytes = ascii(name);
        locals.push(
            ...u32le(0x04034b50),
            ...u16le(20),
            ...u16le(0),
            ...u16le(0),
            ...u16le(0),
            ...u16le(0),
            ...u32le(0),
            ...u32le(0),
            ...u32le(0),
            ...u16le(nameBytes.length),
            ...u16le(0),
            ...nameBytes
        );
        central.push(
            ...u32le(0x02014b50),
            ...u16le(20),
            ...u16le(20),
            ...u16le(0),
            ...u16le(0),
            ...u16le(0),
            ...u16le(0),
            ...u32le(0),
            ...u32le(0),
            ...u32le(0),
            ...u16le(nameBytes.length),
            ...u16le(0),
            ...u16le(0),
            ...u16le(0),
            ...u16le(0),
            ...u32le(0),
            ...u32le(offset),
            ...nameBytes
        );
    }
    const end = [
        ...u32le(0x06054b50),
        ...u16le(0),
        ...u16le(0),
        ...u16le(names.length),
        ...u16le(names.length),
        ...u32le(central.length),
        ...u32le(locals.length),
        ...u16le(0),
    ];
    return Uint8Array.from([...locals, ...central, ...end]);
}

export const docxBytes = (extra: readonly string[] = []): Uint8Array =>
    zipBytes(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', ...extra]);

export const textBytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');

/** The rows double with the real scoping rule: a draft is its uploader's, a bound file is the org's. */
export function memoryAttachmentRows(): AttachmentRows & { all: AttachmentRow[] } {
    const all: AttachmentRow[] = [];
    const keys = new Map<string, { id: string; fingerprint: string }>();
    const byId = (id: string) => all.find((r) => r.id === id);
    return {
        all,
        async insertPending(input) {
            if (input.idempotency) {
                const scope = `${input.uploaderId}/${input.idempotency.key}`;
                const held = keys.get(scope);
                if (held) {
                    if (held.fingerprint !== input.idempotency.fingerprint) throw new IdempotencyKeyReusedError();
                    return { row: { ...byId(held.id)! }, replayed: true };
                }
                keys.set(scope, { id: input.id, fingerprint: input.idempotency.fingerprint });
            }
            const row: AttachmentRow = {
                id: input.id,
                uploaderId: input.uploaderId,
                name: input.name,
                mediaType: input.mediaType,
                sizeBytes: input.sizeBytes,
                sha256: input.sha256,
                objectKey: input.objectKey,
                state: 'pending',
            };
            all.push(row);
            return { row: { ...row }, replayed: false };
        },
        async markReady(id) {
            const row = byId(id);
            if (!row || row.state !== 'pending') return null;
            row.state = 'ready';
            return { ...row };
        },
        async find(id, uploaderId) {
            const row = byId(id);
            if (!row) return null;
            if (row.state === 'bound') return { ...row };
            return row.state === 'ready' && row.uploaderId === uploaderId ? { ...row } : null;
        },
        async findBound(id) {
            const row = byId(id);
            return row?.state === 'bound' ? { ...row } : null;
        },
        async beginDelete(id, uploaderId) {
            const row = byId(id);
            if (!row || row.uploaderId !== uploaderId) return null;
            if (row.state === 'pending' || row.state === 'ready' || row.state === 'deleting') row.state = 'deleting';
            return row.state === 'deleting' || row.state === 'deleted' ? { ...row } : null;
        },
        async markDeleted(id) {
            const row = byId(id);
            if (row?.state === 'deleting') row.state = 'deleted';
        },
    };
}
