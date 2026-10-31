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
//   {ok:false, reason, kind:'attachment_unavailable'}   only the board's definitive answers: 410, 422, or bytes it served
//                 that do not match the claim's sha256/size: no retry fixes it;
//   {ok:false, reason, transient:true}                  every other failure (a 404 or other status, a timeout, a dropped
//                 connection, any filesystem error): inconclusive, the step is interrupted and retried, never failed.
//
// Environment (set by the driver and the supervisor):
//   TARGET_DIR    — where the files go (a task's inputs directory, or a reviewer's: the script serves both);
//   MANIFEST      — JSON [{id,name,mediaType,size,sha256,originJobId}]: the claim's files, in order;
//   INPUT_DELIVERY — the delivery name on the control route (`task`, or a review row's id);
//   STAGING_SEQ   — the claim sequence, naming the staging directory;
//   RESTORE_URL / RESTORE_TOKEN — the control endpoint and its bearer (the supervisor adds them to a step with INPUT_FEED=1);
//   FETCH_TIMEOUT_MS — optional: the bound of one file's read;
//   EXTRACT_SCRIPT — optional: scripts/attachment-extract.cjs, run once over the published directory (text beside
//                 PDF and Word files, `unreadable` entries). Its own failure is transient like any other.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const KIND_UNAVAILABLE = 'attachment_unavailable';
const MANIFEST_NAME = 'manifest.json';
const STAGING_PREFIX = '.staging-';
const DEFAULT_TIMEOUT_MS = 60_000;
const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;
const UNAVAILABLE_STATUSES = new Set([HTTP_GONE, HTTP_UNPROCESSABLE]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;

class Unavailable extends Error {}

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
        throw new Error(`the control endpoint could not be read for ${entry.id}: ${e.message}`);
    }
    if (UNAVAILABLE_STATUSES.has(response.status)) {
        throw new Unavailable(`the board does not serve ${entry.id} (${response.status})`);
    }
    if (!response.ok) throw new Error(`the control endpoint answered ${response.status} for ${entry.id}`);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
        throw new Unavailable(`the bytes of ${entry.id} do not match the claim's sha256`);
    }
    return bytes;
};

/** What this script leaves the target directory at: the next delivery reopens only a directory it sealed itself. */
const SEALED_MODE = 0o555;
const OPEN_MODE = 0o755;
/** Every temp file is written writable and made read-only only before its rename, so an interrupted write is retried over. */
const READ_ONLY_MODE = 0o444;

const EXTRACT_TIMEOUT_MS = 300_000;
const EXTRACT_ENV_DROPPED = ['RESTORE_URL', 'RESTORE_TOKEN', 'MANIFEST', 'EXTRACT_SCRIPT'];

/** Runs the extract script over `target` in a child that never sees the control endpoint's bearer. */
const extract = (target) => {
    const code = process.env.EXTRACT_SCRIPT;
    if (!code) return;
    const env = { ...process.env, TARGET_DIR: target };
    for (const name of EXTRACT_ENV_DROPPED) delete env[name];
    const run = spawnSync(process.execPath, ['--no-warnings', '-e', code], {
        env,
        encoding: 'utf8',
        timeout: EXTRACT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
    });
    const last = String(run.stdout || '')
        .trim()
        .split('\n')
        .pop();
    let verdict = null;
    try {
        verdict = JSON.parse(last);
    } catch {}
    if (run.error || !verdict || !verdict.ok) {
        throw new Error(
            `the attachment text extraction failed: ${(run.error && run.error.message) || (verdict && verdict.reason) || run.stderr}`
        );
    }
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
    // The directory is left read-only (0555) and the files 0444: the agent's and the reviewer's uids read them and
    // never change them. A redelivery reopens it for this step's own uid first.
    if (fs.existsSync(target) && (fs.statSync(target).mode & 0o777) === SEALED_MODE) fs.chmodSync(target, OPEN_MODE);
    fs.mkdirSync(staging, { recursive: true });

    const missing = list.filter((entry) => !holds(path.join(target, pathOf(entry)), entry));
    for (const entry of missing) {
        const staged = path.join(staging, pathOf(entry));
        if (holds(staged, entry)) continue;
        const tmp = staged + '.part';
        fs.rmSync(tmp, { force: true });
        fs.writeFileSync(tmp, await readFile(entry, source));
        fs.chmodSync(tmp, READ_ONLY_MODE);
        fs.renameSync(tmp, staged);
    }
    for (const entry of missing) fs.renameSync(path.join(staging, pathOf(entry)), path.join(target, pathOf(entry)));

    const manifest = { files: list.map((entry) => ({ ...entry, path: pathOf(entry) })) };
    const pending = path.join(target, MANIFEST_NAME + '.tmp');
    fs.rmSync(pending, { force: true });
    fs.writeFileSync(pending, JSON.stringify(manifest, null, 2) + '\n');
    fs.chmodSync(pending, READ_ONLY_MODE);
    fs.renameSync(pending, path.join(target, MANIFEST_NAME));
    sweep(target, new Set([MANIFEST_NAME, ...manifest.files.map((file) => file.path)]));
    extract(target);
    fs.chmodSync(target, SEALED_MODE);
    return { ok: true, files: list.length, fetched: missing.length };
}

const say = (verdict) => process.stdout.write(JSON.stringify(verdict) + '\n');

const failure = (e) => {
    const reason = String((e && e.message) || e);
    return e instanceof Unavailable
        ? { ok: false, reason, kind: KIND_UNAVAILABLE }
        : { ok: false, reason, transient: true };
};

void main().then(say, (e) => say(failure(e)));
