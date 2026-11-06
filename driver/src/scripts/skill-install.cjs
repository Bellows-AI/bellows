'use strict';
// Installs a claim's pinned org and workspace skills into a directory the agent CLIs read as a skills directory
// (`<TARGET_DIR>/<name>/SKILL.md`): each version of the pin is read from the control endpoint's
// `/input/skills/<versionId>` route as a ustar tar, checked against the pin's sha256, unpacked by a reader that
// accepts only regular files and directories under the skill's own directory, and renamed into place.
//
// A bundle is data, not paths: an entry that is absolute, climbs out with `..`, is a link or a device, or collides
// with another entry is refused, and nothing is written outside `<TARGET_DIR>/.staging-<seq>/<name>/`. A skill is
// built whole in staging and renamed into place only once every one of them is in hand, so a failed or killed run
// leaves no partial skill at a final name; the next delivery removes every staging directory first.
//
// The script owns what it installed: `.factory-skills.json` ({owned:{name:sha256}}), written last and atomically.
//   - a name whose recorded sha256 equals the pin's and whose directory holds SKILL.md is kept, not fetched again;
//   - a name the manifest owns that the pin no longer lists is removed, so an empty pin prunes everything the script
//     installed; a manifest that is absent (ENOENT) owns nothing, but one that cannot be read or is not valid in every
//     entry (a skill name and a sha256) is a transient failure, left untouched, with nothing pruned or installed;
//     every read goes through `probe`, which reports absence only for ENOENT/ENOTDIR and throws on anything else;
//   - a directory the manifest does not own is kept, unless the pin names it: delivery overwrites a same-name directory.
//
// One JSON verdict on the last line, exit 0:
//   {ok:true, skills:N, fetched:M, pruned:K}
//   {ok:false, reason, kind:'skill_unavailable'}   only definitive answers: the board's 410 or 422, bytes that do not
//                 match the pin, or a bundle that is not a safe tar of a skill: no retry fixes it;
//   {ok:false, reason, transient:true}             every other failure (a 5xx, a timeout, a malformed pin, any
//                 filesystem error): inconclusive, the step is interrupted and retried, never failed.
//
// Environment (set by the driver and the supervisor):
//   TARGET_DIR     — the skills directory;
//   PIN            — JSON [{name, source, versionId, sha256}]: the claim's pin;
//   INPUT_DELIVERY — the delivery name on the control route (`skills`);
//   STAGING_SEQ    — the claim sequence, naming the staging directory;
//   RESTORE_URL / RESTORE_TOKEN — the control endpoint and its bearer (the supervisor adds them to a step with INPUT_FEED=1);
//   FETCH_TIMEOUT_MS — optional: the bound of one bundle's read.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KIND_UNAVAILABLE = 'skill_unavailable';
const MANIFEST_NAME = '.factory-skills.json';
const STAGING_PREFIX = '.staging-';
const SKILL_MD = 'SKILL.md';
const DEFAULT_TIMEOUT_MS = 60_000;
const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;
const UNAVAILABLE_STATUSES = new Set([HTTP_GONE, HTTP_UNPROCESSABLE]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SOURCES = new Set(['org', 'workspace']);

// Limits copied from core/src/skills.ts (this package imports nothing): 64 files, 5 MiB of files; the tar adds a
// header block per entry and the end marker.
const MAX_FILES = 64;
const BLOCK = 512;
const ENTRIES_PER_FILE = 4;
const MAX_ENTRIES = MAX_FILES * ENTRIES_PER_FILE;
const MIB = 1_048_576;
const MAX_SKILL_MIB = 5;
const HEADERS_PER_ENTRY = 2;
const MAX_TAR_BYTES = MAX_SKILL_MIB * MIB + MAX_ENTRIES * HEADERS_PER_ENTRY * BLOCK + HEADERS_PER_ENTRY * BLOCK;
const DIR_MODE = 0o755;
const FILE_MODE = 0o644;

const TAR = { name: 0, size: 124, checksum: 148, type: 156, magic: 257, prefix: 345 };
const NAME_BYTES = 100;
const PREFIX_BYTES = 155;
const SIZE_BYTES = 12;
const CHECKSUM_BYTES = 8;
const OCTAL = 8;

class Unavailable extends Error {}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const pinOf = (raw) => {
    const list = JSON.parse(raw || '');
    if (!Array.isArray(list)) throw new Error('PIN is not a list');
    const names = new Set();
    for (const entry of list) {
        if (
            !entry ||
            !SKILL_NAME.test(entry.name) ||
            !SOURCES.has(entry.source) ||
            !UUID.test(entry.versionId) ||
            !SHA256.test(entry.sha256) ||
            names.has(entry.name)
        ) {
            throw new Error('PIN holds an entry that is not a pinned skill version');
        }
        names.add(entry.name);
    }
    return list;
};

/** One bundle's bytes from the control endpoint, checked against the pin's digest. */
const readBundle = async (entry, source) => {
    let response;
    let bytes;
    try {
        response = await fetch(`${source.url}/input/${encodeURIComponent(source.delivery)}/${entry.versionId}`, {
            headers: { authorization: `Bearer ${source.token}` },
            signal: AbortSignal.timeout(source.timeoutMs),
        });
        if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
    } catch (e) {
        throw new Error(`the control endpoint could not be read for ${entry.name}: ${e.message}`);
    }
    if (UNAVAILABLE_STATUSES.has(response.status)) {
        throw new Unavailable(`the board does not serve skill ${entry.name} (${response.status})`);
    }
    if (!response.ok) throw new Error(`the control endpoint answered ${response.status} for skill ${entry.name}`);
    if (bytes.length > MAX_TAR_BYTES)
        throw new Unavailable(`the bundle of skill ${entry.name} is larger than a skill may be`);
    if (sha256(bytes) !== entry.sha256) {
        throw new Unavailable(`the bytes of skill ${entry.name} do not match the pin's sha256`);
    }
    return bytes;
};

const text = (block, at, length) => {
    const field = block.subarray(at, at + length);
    const end = field.indexOf(0);
    return field.toString('utf8', 0, end === -1 ? length : end);
};

/** A header's octal field, or null when it holds anything else. */
const octal = (block, at, length) => {
    const raw = text(block, at, length).trim();
    return /^[0-7]+$/.test(raw) ? parseInt(raw, OCTAL) : null;
};

/** The relative path of an entry, refused when it could name anything outside the skill's own directory. */
const safePath = (raw, bundle) => {
    const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const parts = trimmed.split('/');
    if (
        trimmed === '' ||
        trimmed.includes('\0') ||
        trimmed.includes('\\') ||
        trimmed.startsWith('/') ||
        parts.some((part) => part === '' || part === '.' || part === '..')
    ) {
        throw new Unavailable(`the bundle of skill ${bundle} holds a path that is not a safe relative path`);
    }
    return trimmed;
};

const SPACE = 0x20;
const MAGIC_BYTES = 5;

/** The sum of a header's bytes with its checksum field read as spaces, as ustar defines it. */
const checksumOf = (header) => {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= TAR.checksum && i < TAR.checksum + CHECKSUM_BYTES ? SPACE : header[i];
    return sum;
};

/** One header as `{path, dir, size}`; only a regular file or a directory with a sound checksum, magic and size. */
const parseHeader = (header, bundle) => {
    if (octal(header, TAR.checksum, CHECKSUM_BYTES) !== checksumOf(header)) {
        throw new Unavailable(`the bundle of skill ${bundle} has a header with a bad checksum`);
    }
    if (text(header, TAR.magic, MAGIC_BYTES) !== 'ustar') {
        throw new Unavailable(`the bundle of skill ${bundle} is not a ustar tar`);
    }
    const type = String.fromCharCode(header[TAR.type]);
    const dir = type === '5';
    if (type !== '0' && type !== '\0' && !dir) {
        throw new Unavailable(`the bundle of skill ${bundle} holds an entry that is not a regular file or a directory`);
    }
    const prefix = text(header, TAR.prefix, PREFIX_BYTES);
    const name = text(header, TAR.name, NAME_BYTES);
    const size = octal(header, TAR.size, SIZE_BYTES);
    if (size === null || (dir && size !== 0))
        throw new Unavailable(`the bundle of skill ${bundle} has a bad entry size`);
    return { path: safePath(prefix === '' ? name : `${prefix}/${name}`, bundle), dir, size };
};

/**
 * The entries of a ustar tar, in archive order: `{path, dir, bytes}`. Only regular files and directories are
 * read; a link, a device, a pax or GNU extension header, a bad checksum, a truncated entry or a missing end
 * marker is the bundle's own fault, so it is `Unavailable`.
 */
const untar = (tar, bundle) => {
    const entries = [];
    let at = 0;
    for (;;) {
        if (at + BLOCK > tar.length) throw new Unavailable(`the bundle of skill ${bundle} has no end marker`);
        const header = tar.subarray(at, at + BLOCK);
        if (header.every((byte) => byte === 0)) return entries;
        if (entries.length >= MAX_ENTRIES) throw new Unavailable(`the bundle of skill ${bundle} has too many entries`);
        const { path: entryPath, dir, size } = parseHeader(header, bundle);
        const start = at + BLOCK;
        if (start + size > tar.length) throw new Unavailable(`the bundle of skill ${bundle} is truncated`);
        entries.push({ path: entryPath, dir, bytes: tar.subarray(start, start + size) });
        at = start + Math.ceil(size / BLOCK) * BLOCK;
    }
};

/** The entries as a skill: SKILL.md at its root, no path both a file and a directory, no path twice, at most MAX_FILES files. */
const checkSkill = (entries, bundle) => {
    const files = new Set();
    const dirs = new Set();
    for (const entry of entries) {
        const parts = entry.path.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
        if (entry.dir) dirs.add(entry.path);
        else if (files.has(entry.path))
            throw new Unavailable(`the bundle of skill ${bundle} names ${entry.path} twice`);
        else files.add(entry.path);
    }
    for (const file of files) {
        if (dirs.has(file))
            throw new Unavailable(`the bundle of skill ${bundle} has ${file} as a file and a directory`);
    }
    if (files.size > MAX_FILES) throw new Unavailable(`the bundle of skill ${bundle} has more than ${MAX_FILES} files`);
    if (!files.has(SKILL_MD)) throw new Unavailable(`the bundle of skill ${bundle} has no ${SKILL_MD} at its root`);
    return dirs;
};

/** Writes one skill's entries under `dir`: directories 0755, files 0644, whatever the tar or the umask says. */
const write = (dir, entries, dirs) => {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
    for (const sub of [...dirs].sort()) {
        fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: DIR_MODE });
        fs.chmodSync(path.join(dir, sub), DIR_MODE);
    }
    for (const entry of entries) {
        if (entry.dir) continue;
        const file = path.join(dir, entry.path);
        fs.writeFileSync(file, entry.bytes, { flag: 'wx', mode: FILE_MODE });
        fs.chmodSync(file, FILE_MODE);
    }
};

/** Whether a read failed because the path is confirmed absent: the only failure that is an answer. */
const absent = (e) => Boolean(e) && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

const ABSENT = Object.freeze({ kind: 'absent' });

/**
 * THE filesystem read of this script: `{kind:'absent'}` for a confirmed absence (ENOENT/ENOTDIR) and otherwise what
 * is there: `{kind:'file', text?}`, `{kind:'dir', names}` or `{kind:'other'}`. Any other failure (EACCES, EIO, ...)
 * is a read that confirmed nothing: it throws, the run is transient, and nothing is deleted or overwritten on it.
 * No other function reads the filesystem; `skills-reads` pins that.
 */
const probe = (target, { text = false } = {}) => {
    try {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) return { kind: 'dir', names: fs.readdirSync(target) };
        if (stat.isFile()) return text ? { kind: 'file', text: fs.readFileSync(target, 'utf8') } : { kind: 'file' };
        return { kind: 'other' };
    } catch (e) {
        if (absent(e)) return ABSENT;
        throw e;
    }
};

/**
 * The manifest's owned map ({name: sha256}), validated whole before anything acts on it: a plain object whose every
 * key is a skill name and every value a lowercase sha256. Only a confirmed absence owns nothing. Anything else that is
 * not a valid manifest THROWS (a transient failure) and the file is left as it is, because replacing it would forget
 * what this script owns for good, and acting on a half-valid one would delete what it does not own.
 */
const manifestOf = (target) => {
    const found = probe(path.join(target, MANIFEST_NAME), { text: true });
    if (found.kind === 'absent') return {};
    if (found.kind !== 'file') throw new Error(`${MANIFEST_NAME} is not a file`);
    let doc;
    try {
        doc = JSON.parse(found.text);
    } catch (e) {
        throw new Error(`${MANIFEST_NAME} is not JSON: ${e.message}`);
    }
    const owned = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.owned : undefined;
    if (!owned || typeof owned !== 'object' || Array.isArray(owned)) {
        throw new Error(`${MANIFEST_NAME} does not hold an owned map`);
    }
    for (const [name, digest] of Object.entries(owned)) {
        if (!SKILL_NAME.test(name) || typeof digest !== 'string' || !SHA256.test(digest)) {
            throw new Error(`${MANIFEST_NAME} owns an entry that is not a skill name with a sha256`);
        }
    }
    return owned;
};

/** Whether the skill's SKILL.md is in place: false only on a confirmed absence. */
const installed = (target, name) => probe(path.join(target, name, SKILL_MD)).kind === 'file';

/** The skills directory and the manifest's owned map, both confirmed: a directory that is absent owns nothing. */
const survey = (target) => {
    const dir = probe(target);
    if (dir.kind !== 'absent' && dir.kind !== 'dir') throw new Error('TARGET_DIR is not a directory');
    return { dir, owned: dir.kind === 'dir' ? manifestOf(target) : {} };
};

async function main() {
    const target = process.env.TARGET_DIR;
    if (!target) throw new Error('TARGET_DIR is not set');
    const pin = pinOf(process.env.PIN);
    const source = {
        url: process.env.RESTORE_URL,
        token: process.env.RESTORE_TOKEN,
        delivery: process.env.INPUT_DELIVERY || 'skills',
        timeoutMs: Number(process.env.FETCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    };
    // Every read that decides anything comes first: nothing is created, removed or fetched until the directory and
    // the manifest are both confirmed.
    const { dir, owned } = survey(target);
    // Nothing is pinned and the skills directory is confirmed absent: nothing was ever installed, nothing to prune.
    if (pin.length === 0 && dir.kind === 'absent') return { ok: true, skills: 0, fetched: 0, pruned: 0 };
    fs.mkdirSync(target, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(target, DIR_MODE);
    // A staging directory is only ever an uncommitted install: whatever a killed run left is discarded.
    for (const name of dir.kind === 'dir' ? dir.names.filter((n) => n.startsWith(STAGING_PREFIX)) : []) {
        fs.rmSync(path.join(target, name), { recursive: true, force: true });
    }
    const staging = path.join(target, STAGING_PREFIX + (process.env.STAGING_SEQ || '0'));

    const missing = pin.filter((entry) => !(owned[entry.name] === entry.sha256 && installed(target, entry.name)));
    // Every bundle is read, checked and staged before any final name changes.
    for (const entry of missing) {
        const entries = untar(await readBundle(entry, source), entry.name);
        write(path.join(staging, entry.name), entries, checkSkill(entries, entry.name));
    }
    for (const entry of missing) {
        fs.rmSync(path.join(target, entry.name), { recursive: true, force: true });
        fs.renameSync(path.join(staging, entry.name), path.join(target, entry.name));
    }

    // Only names of the validated manifest are ever pruned.
    const names = new Set(pin.map((entry) => entry.name));
    const stale = Object.keys(owned).filter((name) => !names.has(name));
    for (const name of stale) fs.rmSync(path.join(target, name), { recursive: true, force: true });

    const pending = path.join(target, MANIFEST_NAME + '.tmp');
    fs.writeFileSync(pending, JSON.stringify({ owned: Object.fromEntries(pin.map((e) => [e.name, e.sha256])) }) + '\n');
    fs.chmodSync(pending, FILE_MODE);
    fs.renameSync(pending, path.join(target, MANIFEST_NAME));
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: true, skills: pin.length, fetched: missing.length, pruned: stale.length };
}

const say = (verdict) => process.stdout.write(JSON.stringify(verdict) + '\n');

const failure = (e) => {
    const reason = String((e && e.message) || e);
    return e instanceof Unavailable
        ? { ok: false, reason, kind: KIND_UNAVAILABLE }
        : { ok: false, reason, transient: true };
};

void main().then(say, (e) => say(failure(e)));
