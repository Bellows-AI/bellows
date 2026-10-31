import { type AttachmentKind, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from '@factory-ai/core';

/**
 * Decides what an uploaded file is from its bytes alone. The declared name only picks among the
 * three plain-text subtypes, which have no signature; a declared media type, when a client sends
 * one, must agree with what the bytes are. Hand-rolled and bounded: signatures, a ZIP central
 * directory read (no inflate) and a UTF-8 decode — nothing here executes or expands the file.
 */

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type SniffResult =
    | { ok: true; mediaType: string; kind: AttachmentKind }
    | { ok: false; reason: 'unsupported' | 'mismatch' | 'malformed' | 'image-too-large' };

export interface SniffHints {
    name?: string;
    mediaType?: string;
}

const unsupported = { ok: false, reason: 'unsupported' } as const;
const malformed = { ok: false, reason: 'malformed' } as const;
const tooLarge = { ok: false, reason: 'image-too-large' } as const;

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
    bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b);
/** The bytes of a string whose characters are all below 256 (latin-1). */
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const viewOf = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u24le = (v: DataView, at: number): number => v.getUint16(at, true) | (v.getUint8(at + 2) << 16);

type Dimensions = { width: number; height: number } | null;

/** Runs a header read; a read past the end of the bytes is a truncated header, answered as null. */
function bounded(read: () => Dimensions): Dimensions {
    try {
        return read();
    } catch (error) {
        if (error instanceof RangeError) return null;
        throw error;
    }
}

/** Checks the header-declared size of an image: unreadable is `malformed`, oversized is `image-too-large`. */
function imageResult(mediaType: string, size: Dimensions): SniffResult {
    if (!size || size.width < 1 || size.height < 1) return malformed;
    if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE) return tooLarge;
    if (size.width * size.height > MAX_IMAGE_PIXELS) return tooLarge;
    return { ok: true, mediaType, kind: 'image' };
}

const PNG = ascii('\x89PNG\r\n\x1a\n');
const PNG_AT = { ihdr: 12, width: 16, height: 20 } as const;

function pngSize(bytes: Uint8Array): Dimensions {
    if (!startsWith(bytes, ascii('IHDR'), PNG_AT.ihdr)) return null;
    return bounded(() => {
        const view = viewOf(bytes);
        return { width: view.getUint32(PNG_AT.width), height: view.getUint32(PNG_AT.height) };
    });
}

const JPEG = ascii('\xff\xd8\xff');
const JPEG_FRAME_MARKERS = new Set(ascii('\xc0\xc1\xc2\xc3\xc5\xc6\xc7\xc9\xca\xcb\xcd\xce\xcf'));
const JPEG_STANDALONE_MARKERS = new Set(ascii('\x01\xd8\xd9\xd0\xd1\xd2\xd3\xd4\xd5\xd6\xd7'));
const JPEG_FILL = 0xff;
const JPEG_AT = { first: 2, length: 2, height: 5, width: 7, marker: 1, segmentOverhead: 2 } as const;

/** The offset of the segment after the one at `at`, or null when the segment's own length is impossible. */
function nextJpegSegment(view: DataView, at: number, marker: number): number | null {
    if (marker === JPEG_FILL) return at + 1;
    if (JPEG_STANDALONE_MARKERS.has(marker)) return at + JPEG_AT.segmentOverhead;
    const length = view.getUint16(at + JPEG_AT.length);
    return length < JPEG_AT.segmentOverhead ? null : at + JPEG_AT.segmentOverhead + length;
}

function jpegSize(bytes: Uint8Array): Dimensions {
    return bounded(() => {
        const view = viewOf(bytes);
        let at: number | null = JPEG_AT.first;
        while (at !== null) {
            if (view.getUint8(at) !== JPEG_FILL) return null;
            const marker = view.getUint8(at + JPEG_AT.marker);
            if (JPEG_FRAME_MARKERS.has(marker)) {
                return { height: view.getUint16(at + JPEG_AT.height), width: view.getUint16(at + JPEG_AT.width) };
            }
            at = nextJpegSegment(view, at, marker);
        }
        return null;
    });
}

const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');
const WEBP_AT = {
    form: 8,
    chunk: 12,
    extWidth: 24,
    extHeight: 27,
    lossySync: 23,
    lossyWidth: 26,
    lossyHeight: 28,
    losslessSignature: 20,
    losslessBits: 21,
} as const;
const WEBP_LOSSY_SYNC = ascii('\x9d\x01\x2a');
const WEBP_LOSSLESS_SIGNATURE = 0x2f;
const LOSSY_DIMENSION_MASK = 0x3fff;
const LOSSLESS_BITS = 14;
const LOSSLESS_MASK = (1 << LOSSLESS_BITS) - 1;
const CHUNK_NAME_BYTES = 4;

function webpSize(bytes: Uint8Array): Dimensions {
    const chunk = String.fromCharCode(...bytes.slice(WEBP_AT.chunk, WEBP_AT.chunk + CHUNK_NAME_BYTES));
    return bounded(() => {
        const view = viewOf(bytes);
        if (chunk === 'VP8X') {
            return { width: u24le(view, WEBP_AT.extWidth) + 1, height: u24le(view, WEBP_AT.extHeight) + 1 };
        }
        if (chunk === 'VP8 ' && startsWith(bytes, WEBP_LOSSY_SYNC, WEBP_AT.lossySync)) {
            return {
                width: view.getUint16(WEBP_AT.lossyWidth, true) & LOSSY_DIMENSION_MASK,
                height: view.getUint16(WEBP_AT.lossyHeight, true) & LOSSY_DIMENSION_MASK,
            };
        }
        if (chunk === 'VP8L' && view.getUint8(WEBP_AT.losslessSignature) === WEBP_LOSSLESS_SIGNATURE) {
            const bits = view.getUint32(WEBP_AT.losslessBits, true);
            return { width: (bits & LOSSLESS_MASK) + 1, height: ((bits >>> LOSSLESS_BITS) & LOSSLESS_MASK) + 1 };
        }
        return null;
    });
}

const ZIP_LOCAL = ascii('PK\x03\x04');
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_BYTES = 22;
const ZIP_COMMENT_MAX = 0xffff;
const ZIP_END_AT = { entries: 10, size: 12, offset: 16 } as const;
const ZIP_CENTRAL_AT = { nameLength: 28, extraLength: 30, commentLength: 32, fixed: 46 } as const;
const DOCX_REQUIRED = ['[Content_Types].xml', 'word/document.xml'];

/** Where the end-of-central-directory record starts, searched back from the tail; -1 when there is none. */
function zipEndAt(view: DataView, length: number): number {
    const floor = Math.max(0, length - ZIP_END_BYTES - ZIP_COMMENT_MAX);
    for (let at = length - ZIP_END_BYTES; at >= floor; at -= 1) {
        if (view.getUint32(at, true) === ZIP_END_SIGNATURE) return at;
    }
    return -1;
}

/** The entry names of a ZIP, from its central directory alone; null when the directory does not parse. */
function zipEntryNames(bytes: Uint8Array): string[] | null {
    if (bytes.length < ZIP_END_BYTES) return null;
    const view = viewOf(bytes);
    const end = zipEndAt(view, bytes.length);
    if (end === -1) return null;
    const entries = view.getUint16(end + ZIP_END_AT.entries, true);
    let at = view.getUint32(end + ZIP_END_AT.offset, true);
    if (at + view.getUint32(end + ZIP_END_AT.size, true) > end) return null;
    const names: string[] = [];
    try {
        for (let i = 0; i < entries; i += 1) {
            if (view.getUint32(at, true) !== ZIP_CENTRAL_SIGNATURE) return null;
            const nameLength = view.getUint16(at + ZIP_CENTRAL_AT.nameLength, true);
            const extraLength = view.getUint16(at + ZIP_CENTRAL_AT.extraLength, true);
            const commentLength = view.getUint16(at + ZIP_CENTRAL_AT.commentLength, true);
            const nameAt = at + ZIP_CENTRAL_AT.fixed;
            if (nameAt + nameLength > bytes.length) return null;
            names.push(Buffer.from(bytes.subarray(nameAt, nameAt + nameLength)).toString('utf8'));
            at = nameAt + nameLength + extraLength + commentLength;
        }
    } catch (error) {
        if (error instanceof RangeError) return null;
        throw error;
    }
    return names;
}

function docxResult(bytes: Uint8Array): SniffResult {
    const names = zipEntryNames(bytes);
    if (!names) return unsupported;
    if (!DOCX_REQUIRED.every((required) => names.includes(required))) return unsupported;
    if (names.some((name) => name.toLowerCase().endsWith('vbaproject.bin'))) return unsupported;
    return { ok: true, mediaType: DOCX_TYPE, kind: 'document' };
}

/** Markup that is valid UTF-8 and would execute or render if served: the one text shape refused by content. */
const MARKUP = /^(<\?xml|<!doctype|<svg|<html|<head|<body|<script)/iu;
const MARKUP_WINDOW = 512;
/** Whitespace and markup comments before the first tag: a browser skips them, so the check does too. */
const LEADING_COMMENTS = /^(?:\s|<!--[\s\S]*?-->)*/u;
/** C0 controls other than tab, line feed, form feed and carriage return: a text file has none, a binary does. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f]/u;

const TEXT_BY_EXTENSION: readonly (readonly [string, string])[] = [
    ['.md', 'text/markdown'],
    ['.csv', 'text/csv'],
];

function textResult(bytes: Uint8Array, name: string | undefined): SniffResult {
    if (bytes.includes(0)) return unsupported;
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return unsupported;
    }
    if (CONTROL.test(text)) return unsupported;
    if (
        MARKUP.test(
            text
                .slice(0, MARKUP_WINDOW)
                .replace(/^\uFEFF/u, '')
                .replace(LEADING_COMMENTS, '')
        )
    )
        return unsupported;
    const lower = (name ?? '').toLowerCase();
    const mediaType = TEXT_BY_EXTENSION.find(([ext]) => lower.endsWith(ext))?.[1] ?? 'text/plain';
    return { ok: true, mediaType, kind: 'text' };
}

function sniffBytes(bytes: Uint8Array, name: string | undefined): SniffResult {
    if (bytes.length === 0) return malformed;
    if (startsWith(bytes, PNG)) return imageResult('image/png', pngSize(bytes));
    if (startsWith(bytes, JPEG)) return imageResult('image/jpeg', jpegSize(bytes));
    if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, WEBP_AT.form)) {
        return imageResult('image/webp', webpSize(bytes));
    }
    if (startsWith(bytes, ascii('%PDF-'))) return { ok: true, mediaType: 'application/pdf', kind: 'document' };
    if (startsWith(bytes, ZIP_LOCAL) || zipEntryNames(bytes)) return docxResult(bytes);
    return textResult(bytes, name);
}

export function sniffAttachment(bytes: Uint8Array, hints: SniffHints = {}): SniffResult {
    const result = sniffBytes(bytes, hints.name);
    if (result.ok && hints.mediaType !== undefined && hints.mediaType !== result.mediaType) {
        return { ok: false, reason: 'mismatch' };
    }
    return result;
}
