// The attempt's checkpoint (issue #775): what a replacement volume needs to continue the task. Run
// by the task supervisor in its finalize stage, after the publish and before the report. It commits
// the WHOLE task tree — tracked edits, deletions, untracked files; ignored paths and `.factory/`
// stay out — through a throwaway index, bundles that commit against what the remote already has
// (`origin/<default>` and `origin/<task branch>`, whose shas it records), and snapshots the
// OpenCode session database. It never moves the real index, HEAD, a branch or the working tree: the
// only ref it makes, `refs/factory/checkpoint`, a bundle needs to name its tip, and it removes it.
// One execFileSync per git call: no value can become a command. One JSON verdict on the last line
// of stdout:
//   {ok:true, state:'none'}                                    no checkout: nothing to carry;
//   {ok:true, state:'complete'|'truncated', cause, header, parts}
//   {ok:false, reason}
// `parts` are the files to upload after the header line, in order, with their sizes; `truncated`
// (cause `checkpoint_cap`) leaves none: above the cap the bytes are not uploaded at all.
//
// Environment (set by the supervisor; paths and a branch name, never a credential):
//   CHECKOUT    — the task's own tree (`/task/<repo segment>`);
//   BRANCH      — the branch it runs on (`factory/<thread root id>`);
//   OUT_DIR     — where the parts are written; emptied first;
//   OPENCODE_DB — optional: the OpenCode session database to snapshot (absent file: no snapshot);
//   CAP_BYTES   — optional: the bytes above which nothing is uploaded (default 256 MiB).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CAP_BYTES = 268_435_456; // 256 MiB
const BUNDLE_MAX_BUFFER = 1_048_576;
const REASON_MAX_LENGTH = 300;
const TIP_REF = 'refs/factory/checkpoint';
const HEADER_VERSION = 1;
const IDENTITY = {
    GIT_AUTHOR_NAME: 'Factory checkpoint',
    GIT_AUTHOR_EMAIL: 'checkpoint@factory.invalid',
    GIT_COMMITTER_NAME: 'Factory checkpoint',
    GIT_COMMITTER_EMAIL: 'checkpoint@factory.invalid',
};

const checkout = process.env.CHECKOUT;
const branch = process.env.BRANCH;
const outDir = process.env.OUT_DIR;
const opencodeDb = process.env.OPENCODE_DB || '';
const cap = Number(process.env.CAP_BYTES || DEFAULT_CAP_BYTES);

const git = (args, env = {}) =>
    execFileSync('git', args, {
        cwd: checkout,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        maxBuffer: BUNDLE_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

// ENOENT/ENOTDIR is absence; any other errno is a failure to read, never "not there".
const size = (p) => {
    try {
        return fs.statSync(p).size;
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
        throw e;
    }
};

// A ref or object that may legitimately be missing: git exits 1 for "not there" with --quiet; any
// other status (a corrupt repository, a spawn failure) is a failure.
const optional = (args) => {
    try {
        return git(args) || null;
    } catch (e) {
        if (e.status === 1) return null;
        throw e;
    }
};

const sha = (ref) => optional(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);

/** The whole tree as one commit, built in a copy of the index so the real one is never written. */
const commitTree = () => {
    const realIndex = path.resolve(checkout, git(['rev-parse', '--git-path', 'index']));
    const index = path.join(outDir, 'index');
    // Seeded from the real index: the stat cache spares rehashing every file. Absent is a fresh repository.
    if (size(realIndex) !== null) fs.copyFileSync(realIndex, index);
    const env = { GIT_INDEX_FILE: index, ...IDENTITY };
    git(['add', '-A'], env);
    const tree = git(['write-tree'], env);
    const parent = sha('HEAD');
    const args = [
        '-c',
        'commit.gpgsign=false',
        'commit-tree',
        tree,
        ...(parent ? ['-p', parent] : []),
        '-m',
        'checkpoint',
    ];
    return { tip: git(args, env), parent };
};

const defaultBranch = () => {
    const ref = optional(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    return ref ? ref.replace('refs/remotes/origin/', '') : null;
};

const bundle = (tip, excluded, file) => {
    git(['update-ref', TIP_REF, tip]);
    try {
        git(['bundle', 'create', file, TIP_REF, ...excluded.map((s) => `^${s}`)]);
    } finally {
        git(['update-ref', '-d', TIP_REF]);
    }
};

/** The OpenCode database, copied through sqlite's own backup so a write-ahead log is folded in. */
const snapshot = async (file) => {
    if (!opencodeDb || size(opencodeDb) === null) return 0;
    const { DatabaseSync, backup } = require('node:sqlite');
    const db = new DatabaseSync(opencodeDb);
    try {
        await backup(db, file);
    } finally {
        db.close();
    }
    return size(file);
};

const main = async () => {
    if (size(path.join(checkout, '.git')) === null) return { ok: true, state: 'none' };
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const { tip, parent } = commitTree();
    const prerequisites = { default: null, branch: sha(`refs/remotes/origin/${branch}`) };
    const base = defaultBranch();
    if (base) prerequisites.default = sha(`refs/remotes/origin/${base}`);
    const header = {
        version: HEADER_VERSION,
        tip,
        parent,
        branch,
        defaultBranch: base,
        prerequisites,
        bundleBytes: 0,
        sqliteBytes: 0,
        truncated: false,
    };
    const bundleFile = path.join(outDir, 'bundle');
    const sqliteFile = path.join(outDir, 'opencode.db');
    bundle(tip, Object.values(prerequisites).filter(Boolean), bundleFile);
    header.bundleBytes = size(bundleFile);
    header.sqliteBytes = await snapshot(sqliteFile);
    fs.rmSync(path.join(outDir, 'index'), { force: true });
    if (header.bundleBytes + header.sqliteBytes > cap) {
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.mkdirSync(outDir, { recursive: true });
        return {
            ok: true,
            state: 'truncated',
            cause: 'checkpoint_cap',
            header: { ...header, bundleBytes: 0, sqliteBytes: 0, truncated: true },
            parts: [],
        };
    }
    const parts = [{ path: bundleFile, bytes: header.bundleBytes }];
    if (header.sqliteBytes > 0) parts.push({ path: sqliteFile, bytes: header.sqliteBytes });
    return { ok: true, state: 'complete', cause: null, header, parts };
};

const say = (verdict) => process.stdout.write(`${JSON.stringify(verdict)}\n`);
const refusal = (e) => ({
    ok: false,
    reason: String((e && e.stderr) || (e && e.message) || e).slice(0, REASON_MAX_LENGTH),
});
void main().then(say, (e) => say(refusal(e)));
