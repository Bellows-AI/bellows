'use strict';
// Derives plain text beside the PDF and Word attachments of a delivered inputs directory, so an agent whose CLI
// cannot read those formats still can. Images and text files are read natively by the CLI and are left alone.
//
// Reads `manifest.json` in TARGET_DIR (written by attachment-fetch.cjs) and rewrites it: a file with text gains
// `derived: {path, kind:'text'}` (`<id>.derived.txt` beside the original; `truncated: true` when a header, footer or note did not fit the cap); a file that could not be read as text gains
// `status:'unreadable', reason` (`encrypted`, `limit`, `timeout`, `malformed`, `unsupported`, `no_text`,
// `no_extractor`). The original is never touched and stays listed either way.
//
// Every conversion is bounded: PDF text by `pdftotext` under a timeout and an output byte cap, DOCX by a zlib-only
// reader (central directory -> word/document.xml) whose inflate has a `maxOutputLength`. Nothing in a document is
// executed: macro parts are never opened. A derived file is written writable, made 0444 before its rename, so an
// interrupted run is simply redone.
//
// One JSON verdict on the last line, exit 0: {ok:true, derived:N, unreadable:M} or {ok:false, reason}.
//
// Environment: TARGET_DIR (open, writable); EXTRACT_TIMEOUT_MS — optional: the bound of one `pdftotext`.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIB = 1_048_576;
const MAX_INPUT_MIB = 64;
const MAX_INPUT_BYTES = MAX_INPUT_MIB * MIB;
const TEXT_CAP_MIB = 4;
const TEXT_CAP_BYTES = TEXT_CAP_MIB * MIB;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CODE_POINT = 0x10ffff;
const READ_ONLY_MODE = 0o444;
const ENCRYPT_TAIL_BYTES = 8192;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const LOCAL_SIG = 0x04034b50;
const SIZE_FIELD_MAX = 0xffffffff;
const COUNT_FIELD_MAX = 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const FLAG_ENCRYPTED = 1;
const XML_CAP_FACTOR = 4;
const XML_CAP_BYTES = TEXT_CAP_BYTES * XML_CAP_FACTOR;
/** Fixed header sizes and field offsets of the zip structures this reader touches. */
const EOCD = { size: 22, count: 10, directoryAt: 16 };
const CENTRAL = { size: 46, flags: 8, method: 10, packed: 20, nameLen: 28, extraLen: 30, commentLen: 32, offset: 42 };
const LOCAL = { size: 30, nameLen: 26, extraLen: 28 };
// Never an original's name: a delivered file is `<id>` plus one extension, and `.derived.txt` is two.
const DERIVED_SUFFIX = '.derived.txt';
const DOCUMENT_PART = 'word/document.xml';
const TEXT_PART = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

class Unreadable extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
const malformed = () => new Unreadable('malformed');

/** The offset of the end-of-central-directory record, searched back over the longest comment a zip may carry. */
const findEnd = (zip) => {
    const last = zip.length - EOCD.size;
    for (let at = last; at >= Math.max(0, last - COUNT_FIELD_MAX); at--) {
        if (zip.readUInt32LE(at) === EOCD_SIG) return at;
    }
    throw malformed();
};

/** One part's bytes, inflated under `limit`; `null` when it does not fit (the caller decides what that means). */
const inflated = (zip, entry, limit) => {
    if (entry.flags & FLAG_ENCRYPTED) throw new Unreadable('encrypted');
    if (entry.packed === SIZE_FIELD_MAX) throw new Unreadable('unsupported');
    const { offset } = entry;
    if (offset + LOCAL.size > zip.length || zip.readUInt32LE(offset) !== LOCAL_SIG) throw malformed();
    const start =
        offset + LOCAL.size + zip.readUInt16LE(offset + LOCAL.nameLen) + zip.readUInt16LE(offset + LOCAL.extraLen);
    if (start + entry.packed > zip.length) throw malformed();
    const data = zip.subarray(start, start + entry.packed);
    if (entry.method === METHOD_STORED) return data.length > limit ? null : data;
    if (entry.method !== METHOD_DEFLATED) throw new Unreadable('unsupported');
    if (limit <= 0) return null;
    try {
        return zlib.inflateRawSync(data, { maxOutputLength: limit });
    } catch (e) {
        if (e && e.code === 'ERR_BUFFER_TOO_LARGE') return null;
        throw malformed();
    }
};

/** The text-bearing parts of a package, from its central directory: the body first, then headers, footers, notes. */
const textParts = (zip) => {
    if (zip.length < EOCD.size) throw malformed();
    const end = findEnd(zip);
    const count = zip.readUInt16LE(end + EOCD.count);
    let at = zip.readUInt32LE(end + EOCD.directoryAt);
    if (count === COUNT_FIELD_MAX || at === SIZE_FIELD_MAX) throw new Unreadable('unsupported');
    const parts = [];
    for (let i = 0; i < count; i++) {
        if (at + CENTRAL.size > zip.length || zip.readUInt32LE(at) !== CENTRAL_SIG) throw malformed();
        const nameLen = zip.readUInt16LE(at + CENTRAL.nameLen);
        const nameAt = at + CENTRAL.size;
        if (nameAt + nameLen > zip.length) throw malformed();
        const name = zip.toString('utf8', nameAt, nameAt + nameLen);
        if (TEXT_PART.test(name)) {
            parts.push({
                name,
                flags: zip.readUInt16LE(at + CENTRAL.flags),
                method: zip.readUInt16LE(at + CENTRAL.method),
                packed: zip.readUInt32LE(at + CENTRAL.packed),
                offset: zip.readUInt32LE(at + CENTRAL.offset),
            });
        }
        at = nameAt + nameLen + zip.readUInt16LE(at + CENTRAL.extraLen) + zip.readUInt16LE(at + CENTRAL.commentLen);
    }
    if (!parts.some((part) => part.name === DOCUMENT_PART)) throw malformed();
    const rank = (part) => (part.name === DOCUMENT_PART ? 0 : 1);
    return parts.sort((x, y) => rank(x) - rank(y) || (x.name < y.name ? -1 : 1));
};

/** Throws Unreadable('malformed') unless `xml` is one closed root element with no tag cut off. */
const requireWellFormed = (xml, name) => {
    const root = /^\s*(?:<\?[\s\S]*?\?>\s*)?<([\w:.-]+)/.exec(xml);
    const closed = root && xml.trimEnd().endsWith(`</${root[1]}>`);
    const cut = /<[^>]*</.test(xml);
    const bodyless = name === DOCUMENT_PART && !xml.includes('</w:body>');
    if (!closed || cut || bodyless) throw malformed();
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text) =>
    text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, hex, dec, named) => {
        if (named) return ENTITIES[named.toLowerCase()];
        const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
        return code > 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : '';
    });

/** The text runs of a WordprocessingML body: runs concatenated, a paragraph end or break a newline, a tab a tab. */
const textOfXml = (xml) => {
    let out = '';
    for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<\/w:p>/g)) {
        if (m[1] !== undefined) out += decode(m[1]);
        else out += m[0].startsWith('<w:tab') ? '\t' : '\n';
    }
    return out;
};

/**
 * The text of the body, then of every header, footer and note, under ONE output cap: a body that does not fit is
 * `limit`; a later part that does not is dropped and the result says it is cut (`truncated`).
 */
const fromDocx = (bytes) => {
    let budget = XML_CAP_BYTES;
    const texts = [];
    let truncated = false;
    for (const part of textParts(bytes)) {
        const xml = truncated ? null : inflated(bytes, part, budget);
        if (xml === null) {
            if (part.name === DOCUMENT_PART) throw new Unreadable('limit');
            truncated = true;
            continue;
        }
        budget -= xml.length;
        requireWellFormed(xml.toString('utf8'), part.name);
        texts.push(textOfXml(xml.toString('utf8')));
    }
    return { text: texts.join(''), truncated };
};

const ENCRYPTED_TRAILER = /\/Encrypt\s*(?:<<|\d+\s+\d+\s+R)/;
const fromPdf = (file, bytes, timeoutMs) => {
    if (ENCRYPTED_TRAILER.test(bytes.subarray(-ENCRYPT_TAIL_BYTES).toString('latin1')))
        throw new Unreadable('encrypted');
    const run = spawnSync('pdftotext', ['-nopgbrk', '-q', '-enc', 'UTF-8', file, '-'], {
        timeout: timeoutMs,
        maxBuffer: TEXT_CAP_BYTES,
        killSignal: 'SIGKILL',
    });
    if (run.error) {
        if (run.error.code === 'ENOENT') throw new Unreadable('no_extractor');
        if (run.error.code === 'ENOBUFS') throw new Unreadable('limit');
        if (run.error.code === 'ETIMEDOUT') throw new Unreadable('timeout');
        throw run.error;
    }
    if (run.status !== 0) {
        throw new Unreadable(/password|encrypt/i.test(String(run.stderr)) ? 'encrypted' : 'malformed');
    }
    return { text: run.stdout.toString('utf8'), truncated: false };
};

const derive = (entry, file, timeoutMs) => {
    const bytes = fs.readFileSync(file);
    if (entry.mediaType === DOCX) return fromDocx(bytes);
    return fromPdf(file, bytes, timeoutMs);
};

/** `bytes` at `file`: written writable, read-only before its rename. */
const publish = (file, text) => {
    const tmp = file + '.part';
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, text);
    fs.chmodSync(tmp, READ_ONLY_MODE);
    fs.renameSync(tmp, file);
};

/** `entry` with the outcome of its extraction: `derived`, `status`+`reason`, or untouched when it needs none. */
const settle = (entry, target, timeoutMs) => {
    const rest = { ...entry };
    for (const key of ['derived', 'status', 'reason']) delete rest[key];
    if (entry.mediaType !== PDF && entry.mediaType !== DOCX) return rest;
    try {
        if (entry.size > MAX_INPUT_BYTES) throw new Unreadable('limit');
        const { text, truncated } = derive(entry, path.join(target, entry.path), timeoutMs);
        if (text.trim() === '') throw new Unreadable('no_text');
        const out = `${entry.id}${DERIVED_SUFFIX}`;
        publish(path.join(target, out), text);
        return { ...rest, derived: { path: out, kind: 'text', ...(truncated ? { truncated } : {}) } };
    } catch (e) {
        if (!(e instanceof Unreadable)) throw e;
        return { ...rest, status: 'unreadable', reason: e.reason };
    }
};

const main = () => {
    const target = process.env.TARGET_DIR;
    if (!target) throw new Error('TARGET_DIR is not set');
    const timeoutMs = Number(process.env.EXTRACT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    const manifestPath = path.join(target, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files = manifest.files.map((entry) => settle(entry, target, timeoutMs));
    const derived = manifest.files.filter((entry) => entry.derived).length;
    const unreadable = manifest.files.filter((entry) => entry.status === 'unreadable').length;
    const pending = manifestPath + '.tmp';
    fs.rmSync(pending, { force: true });
    fs.writeFileSync(pending, JSON.stringify(manifest, null, 2) + '\n');
    fs.chmodSync(pending, READ_ONLY_MODE);
    fs.renameSync(pending, manifestPath);
    return { ok: true, derived, unreadable };
};

const say = (verdict) => process.stdout.write(JSON.stringify(verdict) + '\n');
try {
    say(main());
} catch (e) {
    say({ ok: false, reason: String((e && e.message) || e) });
}
