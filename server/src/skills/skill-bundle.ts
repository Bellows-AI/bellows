import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import {
    isReservedSkillName,
    MAX_SKILL_BYTES,
    MAX_SKILL_FILE_BYTES,
    MAX_SKILL_FILES,
    parseSkillRequirements,
    type SkillRequirements,
    SKILL_NAME,
    SKILL_NAME_LIMIT,
} from '@factory-ai/core';
import { parseRepoSkillFrontmatter } from '../github/skill-read.js';

/**
 * A skill bundle: the validated files of one skill (SKILL.md at the root plus supporting files)
 * and a deterministic ustar of them, so equal content has an equal sha256. Pure: no database, no
 * routes. Everything read from a zip is untrusted; declared sizes are never believed.
 */

export const SKILL_BUNDLE_REASONS = [
    'not_zip',
    'unsupported',
    'traversal',
    'absolute',
    'backslash',
    'nul',
    'symlink',
    'non_regular',
    'duplicate_path',
    'path_conflict',
    'path_too_long',
    'too_many_files',
    'too_large',
    'file_too_large',
    'no_skill_md',
    'bad_frontmatter',
    'bad_name',
    'name_mismatch',
    'reserved_name',
    'unknown_tool',
    'unknown_connection',
] as const;
export type SkillBundleReason = (typeof SKILL_BUNDLE_REASONS)[number];

export class SkillBundleError extends Error {
    readonly code = 'SKILL_BUNDLE_INVALID';
    constructor(
        readonly reason: SkillBundleReason,
        message: string
    ) {
        super(message);
        this.name = 'SkillBundleError';
    }
}

export interface BundleFile {
    path: string;
    bytes: Buffer;
}

export interface SkillBundle {
    /** Sorted by path. */
    files: BundleFile[];
    tar: Buffer;
    /** sha256 of `tar`, hex. */
    sha256: string;
    /** Total bytes of the files (not the tar). */
    size: number;
    description: string;
    /** What its SKILL.md `metadata:` declares; empty when it declares nothing. */
    requires: SkillRequirements;
}

const SKILL_MD = 'SKILL.md';
const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_BYTES = 22;
const ZIP16_MAX = 0xffff;
const MAX_COMMENT = ZIP16_MAX;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;
const ZIP64 = 0xffffffff;
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 1;
const BITS_PER_BYTE = 8;
const MODE_SHIFT = 16;
/** Field offsets: end of central directory, central directory header, local header. */
const EOCD = { count: 10, size: 12, start: 16 };
const CEN = {
    made: 4,
    flags: 8,
    method: 10,
    compressedSize: 20,
    size: 24,
    nameLength: 28,
    extraLength: 30,
    commentLength: 32,
    attributes: 38,
    offset: 42,
};
const LOCAL = { nameLength: 26, extraLength: 28 };
const OCTAL = 8;
const SIZE_DIGITS = 11;
const SUM_DIGITS = 6;
const TAR = {
    mode: 100,
    uid: 108,
    gid: 116,
    size: 124,
    mtime: 136,
    checksum: 148,
    checksumEnd: 156,
    type: 156,
    magic: 257,
    version: 263,
    prefix: 345,
};

export function bundleFromSkillMd(name: string, text: string): SkillBundle {
    return finish(name, [{ path: SKILL_MD, bytes: Buffer.from(text, 'utf8') }]);
}

export function bundleFromZip(name: string, bytes: Buffer): SkillBundle {
    return finish(name, readZip(bytes));
}

function refuse(reason: SkillBundleReason, message: string): never {
    throw new SkillBundleError(reason, message);
}

function finish(name: string, entries: BundleFile[]): SkillBundle {
    checkName(name);
    const files = entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    let size = 0;
    for (const file of files) {
        if (file.bytes.length > MAX_SKILL_FILE_BYTES)
            refuse('file_too_large', `${file.path} exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
        size += file.bytes.length;
    }
    if (size > MAX_SKILL_BYTES) refuse('too_large', `The skill exceeds ${MAX_SKILL_BYTES} bytes`);
    if (files.length > MAX_SKILL_FILES) refuse('too_many_files', `The skill has more than ${MAX_SKILL_FILES} files`);
    const skillMd = files.find((file) => file.path === SKILL_MD);
    if (!skillMd) refuse('no_skill_md', 'The skill has no SKILL.md at its root');
    const { description, requires } = readSkillMd(name, skillMd.bytes);
    const tar = writeTar(files);
    return { files, tar, sha256: createHash('sha256').update(tar).digest('hex'), size, description, requires };
}

function checkName(name: string): void {
    if (!SKILL_NAME.test(name) || name.length > SKILL_NAME_LIMIT) {
        refuse(
            'bad_name',
            `"${name}" is not a valid skill name (lowercase words joined by "-", up to ${SKILL_NAME_LIMIT} characters)`
        );
    }
    if (isReservedSkillName(name))
        refuse('reserved_name', `Skill names starting with "factory-" are reserved for built-in skills`);
}

/** The repo-skill reader's lenient parser: name and description, whatever other keys the tool supports. */
function readSkillMd(name: string, bytes: Buffer): { description: string; requires: SkillRequirements } {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return refuse('bad_frontmatter', 'SKILL.md is not valid UTF-8');
    }
    const parsed = parseRepoSkillFrontmatter(text);
    if (!parsed) refuse('bad_frontmatter', 'SKILL.md needs frontmatter with a name and a description');
    if (parsed.name !== name)
        refuse('name_mismatch', `SKILL.md name "${parsed.name}" must equal the skill name "${name}"`);
    const declared = parseSkillRequirements(text);
    if ('reason' in declared) {
        const what = declared.reason === 'unknown_tool' ? 'tool' : 'connection';
        refuse(declared.reason, `SKILL.md requires an unknown ${what} "${declared.value}"`);
    }
    return { description: parsed.description, requires: declared.requires };
}

interface CentralEntry {
    path: string;
    method: number;
    compressedSize: number;
    declaredSize: number;
    offset: number;
}

function readZip(zip: Buffer): BundleFile[] {
    const entries = readCentralDirectory(zip);
    const files: { path: string; entry: CentralEntry }[] = [];
    for (const entry of entries) {
        const named = withoutDotPrefix(entry.path);
        if (named.endsWith('/') || named === '') {
            if (named !== '') checkPath(named.slice(0, -1));
            continue;
        }
        files.push({ path: checkPath(named), entry });
    }
    if (files.length > MAX_SKILL_FILES) refuse('too_many_files', `The zip has more than ${MAX_SKILL_FILES} files`);
    const stripped = stripWrapper(files.map((file) => file.path));
    const seen = new Set<string>();
    for (const [index, file] of files.entries()) {
        const path = stripped[index] ?? file.path;
        if (seen.has(path)) refuse('duplicate_path', `${path} appears twice in the zip`);
        seen.add(path);
    }
    for (const path of seen) checkNoFileAncestor(path, seen);
    let total = 0;
    return files.map((file, index) => {
        const path = stripped[index] ?? file.path;
        const bytes = inflateEntry(zip, file.entry, path, MAX_SKILL_BYTES - total);
        total += bytes.length;
        return { path, bytes };
    });
}

/** Some producers write `./SKILL.md`; a leading "./" is the same path. */
function withoutDotPrefix(path: string): string {
    let rest = path;
    while (rest.startsWith('./')) rest = rest.slice(2);
    return rest;
}

/** A file cannot also be a directory: `scripts` next to `scripts/run.sh` has no tar that extracts. */
function checkNoFileAncestor(path: string, seen: ReadonlySet<string>): void {
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
        if (seen.has(path.slice(0, at))) refuse('path_conflict', `${path.slice(0, at)} is both a file and a directory`);
    }
}

function notZip(): never {
    return refuse('not_zip', 'The upload is not a readable zip archive');
}

function findEndOfCentralDirectory(zip: Buffer): number {
    const floor = Math.max(0, zip.length - EOCD_BYTES - MAX_COMMENT);
    for (let at = zip.length - EOCD_BYTES; at >= floor; at--) {
        if (zip.readUInt32LE(at) === EOCD_SIG) return at;
    }
    return notZip();
}

function readCentralDirectory(zip: Buffer): CentralEntry[] {
    const eocd = findEndOfCentralDirectory(zip);
    const count = zip.readUInt16LE(eocd + EOCD.count);
    const size = zip.readUInt32LE(eocd + EOCD.size);
    const start = zip.readUInt32LE(eocd + EOCD.start);
    if (count === ZIP16_MAX || size === ZIP64 || start === ZIP64)
        refuse('unsupported', 'Zip64 archives are not supported');
    if (count > MAX_SKILL_FILES * ENTRIES_PER_FILE || start + size > eocd) return notZip();
    const entries: CentralEntry[] = [];
    let at = start;
    for (let i = 0; i < count; i++) {
        const { entry, next } = readCentralEntry(zip, at, eocd);
        entries.push(entry);
        at = next;
    }
    return entries;
}

function readCentralEntry(zip: Buffer, at: number, limit: number): { entry: CentralEntry; next: number } {
    if (at + CENTRAL_BYTES > limit || zip.readUInt32LE(at) !== CENTRAL_SIG) return notZip();
    const nameEnd = at + CENTRAL_BYTES + zip.readUInt16LE(at + CEN.nameLength);
    if (nameEnd > limit) return notZip();
    const path = zip.toString('utf8', at + CENTRAL_BYTES, nameEnd);
    if (zip.readUInt16LE(at + CEN.flags) & FLAG_ENCRYPTED) refuse('unsupported', `${path} is encrypted`);
    checkFileType(
        path,
        zip.readUInt16LE(at + CEN.made) >>> BITS_PER_BYTE,
        zip.readUInt32LE(at + CEN.attributes) >>> MODE_SHIFT
    );
    const compressedSize = zip.readUInt32LE(at + CEN.compressedSize);
    const declaredSize = zip.readUInt32LE(at + CEN.size);
    const offset = zip.readUInt32LE(at + CEN.offset);
    if (compressedSize === ZIP64 || declaredSize === ZIP64 || offset === ZIP64)
        refuse('unsupported', 'Zip64 archives are not supported');
    const next = nameEnd + zip.readUInt16LE(at + CEN.extraLength) + zip.readUInt16LE(at + CEN.commentLength);
    return { entry: { path, method: zip.readUInt16LE(at + CEN.method), compressedSize, declaredSize, offset }, next };
}

/** Unix hosts carry the file type in the high attribute bits; only regular files and directories pass. */
function checkFileType(path: string, host: number, mode: number): void {
    if (host !== UNIX_HOST) return;
    const type = mode & S_IFMT;
    // Some producers (Python's ZipFile.writestr) set permission bits without a file type: a regular file.
    if (type === 0) return;
    if (type === S_IFLNK) refuse('symlink', `${path} is a symlink`);
    if (type !== S_IFREG && type !== S_IFDIR) refuse('non_regular', `${path} is not a regular file`);
}

/** One normalised relative path, or a refusal naming why. */
function checkPath(path: string): string {
    if (path.includes('\0')) refuse('nul', 'A path contains a NUL byte');
    if (path.includes('\\')) refuse('backslash', `${JSON.stringify(path)} contains a backslash`);
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) refuse('absolute', `${path} is an absolute path`);
    for (const segment of path.split('/')) {
        if (segment === '' || segment === '.' || segment === '..')
            refuse('traversal', `${path} is not a plain relative path`);
    }
    if (Buffer.byteLength(path) > MAX_PATH_BYTES)
        refuse('path_too_long', `${path} is longer than ${MAX_PATH_BYTES} bytes`);
    return path;
}

/** Drops one top-level folder, but only when every file lives under the same one. */
function stripWrapper(paths: readonly string[]): string[] {
    const first = paths[0]?.split('/')[0];
    if (first === undefined || !paths.every((path) => path.includes('/') && path.startsWith(`${first}/`)))
        return [...paths];
    return paths.map((path) => path.slice(first.length + 1));
}

function entryData(zip: Buffer, entry: CentralEntry, path: string): Buffer {
    const at = entry.offset;
    if (at + LOCAL_BYTES > zip.length || zip.readUInt32LE(at) !== LOCAL_SIG)
        refuse('not_zip', `${path} has a damaged header`);
    const dataStart =
        at + LOCAL_BYTES + zip.readUInt16LE(at + LOCAL.nameLength) + zip.readUInt16LE(at + LOCAL.extraLength);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > zip.length) refuse('not_zip', `${path} runs past the end of the archive`);
    return zip.subarray(dataStart, dataEnd);
}

/** Bounded by the per-file cap and what is left of the total; the declared size is only cross-checked. */
function inflateEntry(zip: Buffer, entry: CentralEntry, path: string, remaining: number): Buffer {
    const data = entryData(zip, entry, path);
    const perFile = Math.min(MAX_SKILL_FILE_BYTES, remaining);
    const tooBig = (): never =>
        perFile < MAX_SKILL_FILE_BYTES
            ? refuse('too_large', `The skill exceeds ${MAX_SKILL_BYTES} bytes`)
            : refuse('file_too_large', `${path} exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
    let out: Buffer;
    if (entry.method === METHOD_STORED) {
        if (data.length > perFile) return tooBig();
        out = Buffer.from(data);
    } else if (entry.method === METHOD_DEFLATE) {
        try {
            out = inflateRawSync(data, { maxOutputLength: Math.max(1, perFile) });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') return tooBig();
            return refuse('not_zip', `${path} could not be decompressed`);
        }
    } else {
        return refuse('unsupported', `${path} uses an unsupported compression method`);
    }
    if (out.length !== entry.declaredSize) refuse('not_zip', `${path} does not match its declared size`);
    return out;
}

const MAX_PATH_BYTES = 255;
const NAME_BYTES = 100;
const PREFIX_BYTES = 155;
const BLOCK = 512;
const SPACE = 0x20;
const ENTRIES_PER_FILE = 4;

/** ustar, sorted by the caller: mtime 0, uid/gid 0, mode 0644, no pax or extension headers. */
function writeTar(files: readonly BundleFile[]): Buffer {
    const parts: Buffer[] = [];
    for (const file of files) {
        parts.push(
            tarHeader(file.path, file.bytes.length),
            file.bytes,
            Buffer.alloc((BLOCK - (file.bytes.length % BLOCK)) % BLOCK)
        );
    }
    parts.push(Buffer.alloc(BLOCK * 2));
    return Buffer.concat(parts);
}

function tarHeader(path: string, size: number): Buffer {
    const { name, prefix } = splitPath(path);
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, NAME_BYTES, 'utf8');
    header.write('0000644\0', TAR.mode, 'ascii');
    header.write('0000000\0', TAR.uid, 'ascii');
    header.write('0000000\0', TAR.gid, 'ascii');
    header.write(`${size.toString(OCTAL).padStart(SIZE_DIGITS, '0')}\0`, TAR.size, 'ascii');
    header.write('00000000000\0', TAR.mtime, 'ascii');
    header.fill(SPACE, TAR.checksum, TAR.checksumEnd);
    header.write('0', TAR.type, 'ascii');
    header.write('ustar\0', TAR.magic, 'ascii');
    header.write('00', TAR.version, 'ascii');
    header.write(prefix, TAR.prefix, PREFIX_BYTES, 'utf8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(OCTAL).padStart(SUM_DIGITS, '0')}\0 `, TAR.checksum, 'ascii');
    return header;
}

function splitPath(path: string): { name: string; prefix: string } {
    if (Buffer.byteLength(path) <= NAME_BYTES) return { name: path, prefix: '' };
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
        const prefix = path.slice(0, at);
        const name = path.slice(at + 1);
        if (Buffer.byteLength(prefix) <= PREFIX_BYTES && Buffer.byteLength(name) <= NAME_BYTES) return { name, prefix };
    }
    return refuse('path_too_long', `${path} does not fit a tar header`);
}

/**
 * The files of a tar this module wrote (`SkillBundle.tar`), in archive order. The reader of the stored body, so it
 * trusts only what the writer emits: regular entries, ustar name/prefix, an octal size. A body that does not parse
 * (a short or overrunning entry) throws instead of listing fewer files.
 */
export function filesOfTar(tar: Uint8Array): BundleFile[] {
    const buffer = Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength);
    const files: BundleFile[] = [];
    let at = 0;
    while (at + BLOCK <= buffer.length) {
        const header = buffer.subarray(at, at + BLOCK);
        if (header.every((byte) => byte === 0)) return files;
        const text = (from: number, length: number) => {
            const field = header.subarray(from, from + length);
            const end = field.indexOf(0);
            return field.subarray(0, end === -1 ? length : end).toString('utf8');
        };
        const size = Number.parseInt(text(TAR.size, SIZE_DIGITS + 1), OCTAL);
        if (!Number.isInteger(size) || size < 0) throw new Error('tar entry has no size');
        const prefix = text(TAR.prefix, PREFIX_BYTES);
        const name = text(0, NAME_BYTES);
        const start = at + BLOCK;
        if (start + size > buffer.length) throw new Error('tar entry overruns the body');
        files.push({ path: prefix === '' ? name : `${prefix}/${name}`, bytes: buffer.subarray(start, start + size) });
        at = start + Math.ceil(size / BLOCK) * BLOCK;
    }
    throw new Error('tar has no end marker');
}
