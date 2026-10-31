'use strict';
// Delivers a task's input files into a directory: each file of the claim's list is read from the control
// endpoint's `/input/<delivery>/<id>` route and lands at `<id><ext>`, behind a `manifest.json` written last.
//
// A display name is data, not a path: only its extension (when it is plain) reaches a file name, and the name
// itself lives in manifest.json alone. Files already present with the right sha256 are kept; the rest are
// fetched into `.staging-<seq>/`, checked against the claim's digest, and renamed into place only once every
// one of them is in hand, so a failed run leaves no partial file at a final path. The new manifest is renamed
// in last, and only after it is published does the script remove what it no longer lists (stale files and
// staging directories). The old manifest stays until then.
//
// One JSON verdict on the last line, exit 0:
//   {ok:true, files:N, fetched:M}
//   {ok:false, reason, kind:'attachment_unavailable'}   the board will not serve a file (404/410/422) or the bytes
//                 do not match the claim's digest: no retry fixes it;
//   {ok:false, reason, transient:true}                  a 5xx, a refusal, a timeout or a dropped connection: retry;
//   {ok:false, reason}                                  anything else (a bad environment, a full disk).
//
// Environment (set by the driver and the supervisor):
//   TARGET_DIR    — where the files go (a task's inputs directory, or a reviewer's: the script serves both);
//   MANIFEST      — JSON [{id,name,mediaType,size,sha256,originJobId}]: the claim's files, in order;
//   INPUT_DELIVERY — the delivery name on the control route (`task`, or a review row's id);
//   STAGING_SEQ   — the claim sequence, naming the staging directory;
//   RESTORE_URL / RESTORE_TOKEN — the control endpoint and its bearer (the supervisor adds them to a step with INPUT_FEED=1);
//   FETCH_TIMEOUT_MS — optional: the bound of one file's read.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KIND_UNAVAILABLE = 'attachment_unavailable';
const MANIFEST_NAME = 'manifest.json';
const STAGING_PREFIX = '.staging-';
const DEFAULT_TIMEOUT_MS = 60_000;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;
const UNAVAILABLE_STATUSES = new Set([HTTP_NOT_FOUND, HTTP_GONE, HTTP_UNPROCESSABLE]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;

class Unavailable extends Error {}
class Transient extends Error {}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readIfFile = (file) => {
    try {
        return fs.readFileSync(file);
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EISDIR') return null;
        throw e;
    }
};
/** Whether `file` holds exactly the bytes of `entry`. */
const holds = (file, entry) => {
    const bytes = readIfFile(file);
    return bytes !== null && bytes.length === entry.size && sha256(bytes) === entry.sha256;
};

const pathOf = (entry) => {
    const ext = path.extname(String(entry.name));
    return entry.id + (EXTENSION.test(ext) ? ext : '');
};

const listOf = (raw) => {
    const list = JSON.parse(raw || '');
    if (!Array.isArray(list)) throw new Error('MANIFEST is not a list');
    for (const entry of list) {
        if (!entry || !UUID.test(entry.id) || !SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.size)) {
            throw new Error('MANIFEST holds an entry that is not a file of the claim');
        }
    }
    return list;
};

/** One file's bytes from the control endpoint, checked against the claim's digest. */
const readFile = async (entry, source) => {
    let response;
    let bytes;
    try {
        response = await fetch(`${source.url}/input/${encodeURIComponent(source.delivery)}/${entry.id}`, {
            headers: { authorization: `Bearer ${source.token}` },
            signal: AbortSignal.timeout(source.timeoutMs),
        });
        if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
    } catch (e) {
        throw new Transient(`the control endpoint could not be read for ${entry.id}: ${e.message}`);
    }
    if (UNAVAILABLE_STATUSES.has(response.status)) {
        throw new Unavailable(`the board does not serve ${entry.id} (${response.status})`);
    }
    if (!response.ok) throw new Transient(`the control endpoint answered ${response.status} for ${entry.id}`);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
        throw new Unavailable(`the bytes of ${entry.id} do not match the claim's sha256`);
    }
    return bytes;
};

/** Removes everything in `dir` that is not in `keep`: stale files and staging directories. */
const sweep = (dir, keep) => {
    for (const name of fs.readdirSync(dir)) {
        if (!keep.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
};

async function main() {
    const target = process.env.TARGET_DIR;
    if (!target) throw new Error('TARGET_DIR is not set');
    const list = listOf(process.env.MANIFEST);
    const source = {
        url: process.env.RESTORE_URL,
        token: process.env.RESTORE_TOKEN,
        delivery: process.env.INPUT_DELIVERY || 'task',
        timeoutMs: Number(process.env.FETCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    };
    const staging = path.join(target, STAGING_PREFIX + (process.env.STAGING_SEQ || '0'));
    fs.mkdirSync(staging, { recursive: true });

    const missing = list.filter((entry) => !holds(path.join(target, pathOf(entry)), entry));
    for (const entry of missing) {
        const staged = path.join(staging, pathOf(entry));
        if (holds(staged, entry)) continue;
        const tmp = staged + '.part';
        fs.writeFileSync(tmp, await readFile(entry, source));
        fs.renameSync(tmp, staged);
    }
    for (const entry of missing) fs.renameSync(path.join(staging, pathOf(entry)), path.join(target, pathOf(entry)));

    const manifest = { files: list.map((entry) => ({ ...entry, path: pathOf(entry) })) };
    const pending = path.join(target, MANIFEST_NAME + '.tmp');
    fs.writeFileSync(pending, JSON.stringify(manifest, null, 2) + '\n');
    fs.renameSync(pending, path.join(target, MANIFEST_NAME));
    sweep(target, new Set([MANIFEST_NAME, ...manifest.files.map((file) => file.path)]));
    return { ok: true, files: list.length, fetched: missing.length };
}

const say = (verdict) => process.stdout.write(JSON.stringify(verdict) + '\n');

const failure = (e) => {
    const reason = String((e && e.message) || e);
    if (e instanceof Unavailable) return { ok: false, reason, kind: KIND_UNAVAILABLE };
    return e instanceof Transient ? { ok: false, reason, transient: true } : { ok: false, reason };
};

void main().then(say, (e) => say(failure(e)));
