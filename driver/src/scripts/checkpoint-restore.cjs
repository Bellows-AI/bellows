// The task tree, rebuilt from the thread's checkpoint on a replacement volume (issue #775): the
// counterpart of checkpoint.cjs. The checkpoint stream is one JSON header line, then the git bundle
// of the whole tree's commit (against what the remote already had), then the OpenCode snapshot. The
// driver serves the stream's chunks over the control channel; this script reads each one (its sha256
// checked against the board's pointer), then:
//   1. partial-clones the remote like the startup sync (under the claim's credential helper);
//   2. fetches every commit the BUNDLE itself says it needs and the clone lacks — a prerequisite the
//      remote no longer has (a force-push, a deleted branch) is `checkpoint_unrestorable`;
//   3. unbundles, puts the task branch on the checkpoint's parent and `read-tree -u --reset`s the
//      checkpoint's tree into the working tree, then resets the index to the parent. The restored tree
//      keeps every uncommitted change UNSTAGED (the staging area is not part of a checkpoint).
// The tree is built whole in a sibling directory and moved into place by one rename, so a kill leaves
// a directory the next claim removes, never a half-made checkout. A checkout that already exists is
// the restore's own earlier success: nothing is fetched and nothing is touched.
// One execFileSync per git call: no value can become a command. One JSON verdict on the last line:
//   {ok:true, reason:null, restored:boolean}
//   {ok:false, reason, kind?:'checkpoint_unrestorable'}   `kind` only for a refusal no retry fixes.
//
// Environment (set by the driver and the supervisor):
//   CHECKOUT      — the task's own tree (`/task/<repo segment>`), to be created;
//   REMOTE        — where it is cloned from;
//   BRANCH        — the task branch;
//   CHUNKS        — JSON [{offset,length,sha256}]: the checkpoint stream, from the board's pointer;
//   RESTORE_URL / RESTORE_TOKEN — the control endpoint serving the chunks, and its bearer (the supervisor adds them);
//   CRED_HELPER   — optional: the git credential-helper program (the token itself is in the environment).
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KIND_UNRESTORABLE = 'checkpoint_unrestorable';
const GIT_ERROR_MAX_LENGTH = 300;
const FACTORY_STATE_EXCLUDE = '/.factory/';
const BLOCK_BYTES = 1_048_576;
const HEADER_MAX_BYTES = 268_435_456; // the header lists every remote ref
const BUNDLE_HEAD_MAX_BYTES = 268_435_456;
const FETCH_BATCH = 100;
const CHUNK_TRIES = 4;
const CHUNK_BACKOFF_MS = 500;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const GIT_MAX_BUFFER = 268_435_456;
// What git says of a commit the remote will not serve any more.
const GONE_FROM_REMOTE =
    /not our ref|couldn't find remote ref|unadvertised object|no such remote ref|not found|does not appear to be|invalid object/i;

const checkout = process.env.CHECKOUT;
const remote = process.env.REMOTE;
const branch = process.env.BRANCH;
const url = process.env.RESTORE_URL;
const token = process.env.RESTORE_TOKEN;
const credHelper = process.env.CRED_HELPER;

class Unrestorable extends Error {}
const unrestorable = (message) => new Unrestorable(message);

const detail = (e) => String((e && e.stderr) || (e && e.message) || e).slice(0, GIT_ERROR_MAX_LENGTH);
const exists = (p) => {
    try {
        fs.statSync(p);
        return true;
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
        throw e;
    }
};

const withCredentials = (args) =>
    credHelper ? ['-c', 'credential.helper=' + credHelper, '-c', 'http.followRedirects=initial', ...args] : args;
// `offline`: a read that must never lazily fetch a partial clone's missing object (it asks whether one is there).
const git = (cwd, args, input, offline = false) =>
    execFileSync('git', withCredentials(args), {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(offline ? { GIT_NO_LAZY_FETCH: '1' } : {}) },
        maxBuffer: GIT_MAX_BUFFER,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(input === undefined ? {} : { input }),
    }).trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One try at a chunk: its bytes checked against the board's digest; 404/410 mean the board dropped it. */
const readChunk = async (chunk) => {
    const response = await fetch(`${url}/checkpoint/restore?offset=${chunk.offset}`, {
        headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === HTTP_NOT_FOUND || response.status === HTTP_GONE) {
        throw unrestorable('the board no longer has the checkpoint bytes at offset ' + chunk.offset);
    }
    if (!response.ok) throw new Error('the control endpoint answered ' + response.status);
    const body = await response.json();
    const bytes = Buffer.from(String(body.bytes), 'base64');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== chunk.length || digest !== chunk.sha256 || body.sha256 !== chunk.sha256) {
        throw new Error('the checkpoint chunk at offset ' + chunk.offset + ' does not match its sha256');
    }
    return bytes;
};

/** One chunk of the stream, retried with a growing pause; a dropped chunk is final. */
const fetchChunk = async (chunk) => {
    let last = null;
    for (let tries = 1; tries <= CHUNK_TRIES; tries += 1) {
        try {
            return await readChunk(chunk);
        } catch (e) {
            if (e instanceof Unrestorable) throw e;
            last = e;
            if (tries < CHUNK_TRIES) await sleep(CHUNK_BACKOFF_MS * tries);
        }
    }
    throw last;
};

/** The whole stream into `file`, chunk by chunk and in order. */
const download = async (file, chunks) => {
    const fd = fs.openSync(file, 'w');
    try {
        let next = 0;
        for (const chunk of chunks) {
            if (chunk.offset !== next) throw new Error('the checkpoint pointer has a gap at offset ' + next);
            fs.writeSync(fd, await fetchChunk(chunk));
            next += chunk.length;
        }
    } finally {
        fs.closeSync(fd);
    }
};

/** The bytes of `file` from `start` up to (not including) the first `delimiter`, read block by block. */
const readUntil = (file, start, delimiter, max) => {
    const fd = fs.openSync(file, 'r');
    try {
        const parts = [];
        let position = start;
        let total = 0;
        let tail = Buffer.alloc(0);
        for (;;) {
            const buffer = Buffer.allocUnsafe(BLOCK_BYTES);
            const read = fs.readSync(fd, buffer, 0, BLOCK_BYTES, position);
            if (read === 0) return Buffer.concat(parts);
            const block = buffer.subarray(0, read);
            // The delimiter may straddle two blocks: search the previous block's last bytes too.
            const found = Buffer.concat([tail, block]).indexOf(delimiter);
            if (found !== -1) return Buffer.concat([...parts, block]).subarray(0, total + found - tail.length);
            parts.push(block);
            tail = block.subarray(Math.max(0, read - (delimiter.length - 1)));
            position += read;
            total += read;
            if (total > max) throw unrestorable('the checkpoint header is not the one this driver wrote');
        }
    } finally {
        fs.closeSync(fd);
    }
};

/** Copies `length` bytes of `from` (starting at `start`) into `to`. */
const copyRange = (from, start, length, to) => {
    const input = fs.openSync(from, 'r');
    const output = fs.openSync(to, 'w');
    try {
        let done = 0;
        while (done < length) {
            const buffer = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, length - done));
            const read = fs.readSync(input, buffer, 0, buffer.length, start + done);
            if (read === 0) throw unrestorable('the checkpoint stream ends before its bundle does');
            fs.writeSync(output, buffer, 0, read);
            done += read;
        }
    } finally {
        fs.closeSync(input);
        fs.closeSync(output);
    }
};

/** The commits the bundle says it needs: the `-<sha> <comment>` lines of its own header. */
const prerequisitesOf = (bundle) => {
    const head = readUntil(bundle, 0, '\n\n', BUNDLE_HEAD_MAX_BYTES).toString('utf8');
    const lines = head.split('\n');
    if (!/^# v[23] git bundle$/.test(lines[0] ?? '')) throw unrestorable('the checkpoint bundle is not a git bundle');
    return [
        ...new Set(
            lines
                .filter((line) => line.startsWith('-'))
                .map((line) => line.slice(1).split(' ')[0])
                .filter(Boolean)
        ),
    ];
};

/** The commits of `shas` the repository lacks. */
const missingOf = (repo, shas) => {
    if (shas.length === 0) return [];
    const out = git(repo, ['cat-file', '--batch-check'], shas.map((sha) => `${sha}^{commit}\n`).join(''), true);
    return out
        .split('\n')
        .filter((line) => line.endsWith(' missing'))
        .map((line) => line.split(' ')[0].replace(/\^\{commit\}$/, ''));
};

const assertCredentialedOrigin = () => {
    if (credHelper && !remote.startsWith('https://')) {
        throw new Error(
            'the credentialed clone and fetch refuse origin ' + remote + ': only an https origin may use it'
        );
    }
};

const ensureAllPresent = (repo, shas) => {
    let missing = missingOf(repo, shas);
    for (let i = 0; i < missing.length; i += FETCH_BATCH) {
        try {
            git(repo, ['fetch', 'origin', ...missing.slice(i, i + FETCH_BATCH)]);
        } catch (e) {
            // A remote that no longer serves the commit is a verdict; a transport failure is the lease's to retry.
            if (GONE_FROM_REMOTE.test(detail(e))) {
                throw unrestorable('a commit the checkpoint is built on is no longer on the remote: ' + detail(e));
            }
            throw e;
        }
    }
    missing = missingOf(repo, shas);
    if (missing.length > 0) {
        throw unrestorable('a commit the checkpoint is built on is no longer on the remote: ' + missing[0]);
    }
};

/** Git-ignores the `.factory/` state namespace, as the startup sync does: the checkpoint never carries it. */
const excludeFactoryState = (repo) => {
    let exclude = git(repo, ['rev-parse', '--git-path', 'info/exclude']);
    if (!path.isAbsolute(exclude)) exclude = path.resolve(repo, exclude);
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, FACTORY_STATE_EXCLUDE + '\n');
};

const rebuild = (repo, header, bundle) => {
    ensureAllPresent(repo, prerequisitesOf(bundle));
    git(repo, ['bundle', 'unbundle', bundle], undefined, true);
    if (missingOf(repo, [header.tip]).length > 0) throw unrestorable('the checkpoint bundle does not carry its tip');
    if (header.parent && missingOf(repo, [header.parent]).length > 0) {
        throw unrestorable('the checkpoint bundle does not carry the commit the tree sat on');
    }
    excludeFactoryState(repo);
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/' + branch]);
    if (header.parent) git(repo, ['update-ref', 'refs/heads/' + branch, header.parent]);
    git(repo, ['read-tree', '-u', '--reset', header.tip]);
    // The index returns to the branch's commit: every uncommitted change stays in the working tree, unstaged.
    if (header.parent) git(repo, ['reset', '--quiet']);
    else git(repo, ['read-tree', '--empty']);
    if (missingOf(repo, [`refs/remotes/origin/${branch}`]).length === 0) {
        git(repo, ['config', 'branch.' + branch + '.remote', 'origin']);
        git(repo, ['config', 'branch.' + branch + '.merge', 'refs/heads/' + branch]);
    }
};

const main = async () => {
    if (exists(path.join(checkout, '.git'))) return { ok: true, reason: null, restored: false };
    assertCredentialedOrigin();
    if (exists(checkout))
        throw new Error('the checkout path exists and holds something the restore did not create: ' + checkout);
    const work = path.join(path.dirname(checkout), '.' + path.basename(checkout) + '.restore');
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    try {
        const chunks = JSON.parse(process.env.CHUNKS || '[]');
        const stream = path.join(work, 'stream');
        await download(stream, chunks);
        const line = readUntil(stream, 0, '\n', HEADER_MAX_BYTES);
        const header = JSON.parse(line.toString('utf8'));
        if (header.truncated) throw unrestorable('the checkpoint was cut at its size cap and carries no tree');
        if (!/^[0-9a-f]{40,64}$/.test(String(header.tip))) throw unrestorable('the checkpoint header names no tip');
        const bundle = path.join(work, 'bundle');
        copyRange(stream, line.length + 1, header.bundleBytes, bundle);
        const tree = path.join(work, 'tree');
        git(work, [
            'clone',
            '--filter=blob:none',
            '--no-checkout',
            '--config',
            'core.sharedRepository=group',
            '--origin',
            'origin',
            '--',
            remote,
            tree,
        ]);
        rebuild(tree, header, bundle);
        fs.rmSync(bundle, { force: true });
        fs.rmSync(stream, { force: true });
        fs.renameSync(tree, checkout);
        return { ok: true, reason: null, restored: true };
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
};

const say = (verdict) => process.stdout.write(JSON.stringify(verdict) + '\n');
void main().then(say, (e) =>
    say(
        e instanceof Unrestorable
            ? { ok: false, reason: e.message, kind: KIND_UNRESTORABLE }
            : { ok: false, reason: detail(e) }
    )
);
