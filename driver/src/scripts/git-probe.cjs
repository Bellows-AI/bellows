// @ts-check
// The publish probe: one read-only answer about a checkout, JSON on stdout, no shell — every
// git call is execFileSync, so no path or branch name can become a command. Printed values
// decide the publish flow; none of them are secrets.
//
// Environment (set by the driver; a path, never a credential):
//   REPO — the checkout directory to probe (the task worktree).
//   MUTATED_SINCE_MS — optional epoch milliseconds: the answer then carries `mutatedSince`, whether
//     any non-ignored file or directory outside `.factory/` has an mtime at or after it (the gate-run
//     record's mutation guard). A walk that cannot read a path answers true: unknown is mutated.
//
// "Unpushed" counts commits the REMOTE default branch does not have — never the upstream
// range of the current branch, which is fatal for a branch that was never pushed at all (no
// upstream) and would read a local-only branch full of work as fully landed. That exact
// miscount once reported a two-commit task branch as "nothing to publish".
const { execFileSync } = require('node:child_process');

const repo = process.env.REPO;
// Every git call of the probe. Under the supervisor (GIT_HARDEN_REAL and GIT_HARDEN_MODULE set) the call is hardened
// here, in this process, by the module the supervisor wrote: the same code the `git` shim runs, and per call it reads
// the checkout's config again, so a setting written mid-probe is pinned like any other. That drops the node start the
// shim costs each call (about 30 per probe). Refusals keep the shim's contract: the same stderr line, exit status
// 126, the real git never run. A module that cannot load runs the shim at its absolute path, never `git` by name; a
// shim that is also gone is a spawn failure, 126. Without the supervisor's env the call is plain `git`, as before.
const REFUSED_EXIT = 126;
/** @type {{ runCall: (args: string[], options: object) => any } | null | undefined} */
let hardenModule;
const loadedHarden = () => {
    if (hardenModule === undefined) {
        try {
            hardenModule = require(/** @type {string} */ (process.env.GIT_HARDEN_MODULE));
        } catch {
            hardenModule = null;
        }
    }
    return hardenModule;
};
/**
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileSyncOptions} options
 * @returns {any} the output: a Buffer or a string, as the options' `encoding` says
 */
const runGit = (args, options) => {
    const env = options.env ?? process.env;
    if (!env.GIT_HARDEN_REAL || !env.GIT_HARDEN_MODULE) return execFileSync('git', args, options);
    const hardener = loadedHarden();
    if (hardener) return hardener.runCall(args, options);
    const shim = require('node:path').join(require('node:path').dirname(env.GIT_HARDEN_MODULE), 'git');
    try {
        return execFileSync(shim, args, options);
    } catch (error) {
        const failure = /** @type {Error & { status?: number | null, signal?: string | null }} */ (error);
        if (failure.status != null || failure.signal) throw error;
        process.stderr.write(`git: ${failure.message}\n`);
        throw Object.assign(failure, { status: REFUSED_EXIT });
    }
};
// The tree fingerprint (spelled identically in git-worktree.cjs, whose startup sync prints the
// before-run one): HEAD plus a hash of the uncommitted state — the porcelain status, the tracked
// diff and the untracked files' contents, `.factory/` excluded. Equal fingerprints mean the round
// between them changed nothing. Null when any read fails: an unknown is never a guess.
const FINGERPRINT_PATHSPEC = ['--', ':/', ':(top,exclude).factory'];
const FINGERPRINT_MAX_BUFFER = 268_435_456; // 256 MiB: a large diff must not read as unknown
// Hashes the uncommitted state of one work tree into `hash`. A submodule's own diff is included
// (`--submodule=diff`), or a dirty submodule edited again would read identical. An untracked
// entry is read here, not by `hash-object`, which throws on a dangling symlink or a nested repo:
// a symlink hashes its target, a nested repo recurses (it may have no commit yet), anything that
// is not a regular file hashes its type alone.
/**
 * @param {string} cwd
 * @param {import('node:crypto').Hash} hash
 * @param {boolean} nested
 * @returns {void}
 */
const hashTree = (cwd, hash, nested) => {
    const fs = require('node:fs');
    const path = require('node:path');
    /** @param {string[]} args */
    const read = (args) => runGit(args, { cwd, encoding: 'buffer', maxBuffer: FINGERPRINT_MAX_BUFFER });
    const hasCommit = () => {
        try {
            read(['rev-parse', '--verify', '--quiet', 'HEAD']);
            return true;
        } catch {
            return false;
        }
    };
    hash.update(read(['status', '--porcelain', ...FINGERPRINT_PATHSPEC]));
    if (!nested || hasCommit()) {
        hash.update(read(['diff', 'HEAD', '--binary', '--submodule=diff', ...FINGERPRINT_PATHSPEC]));
    }
    const untracked = read(['ls-files', '-z', '--others', '--exclude-standard', ...FINGERPRINT_PATHSPEC]);
    for (const name of untracked.toString('utf8').split('\0').filter(Boolean)) {
        const full = path.join(cwd, name);
        const stat = fs.lstatSync(full);
        hash.update(name + '\0');
        if (stat.isSymbolicLink()) hash.update('l' + fs.readlinkSync(full));
        else if (stat.isDirectory()) hashTree(full, hash, true);
        else if (stat.isFile()) hash.update(fs.readFileSync(full));
        else hash.update('o');
    }
};
/** @param {string} cwd */
const fingerprintOf = (cwd) => {
    try {
        const hash = require('node:crypto').createHash('sha256');
        hashTree(cwd, hash, false);
        const head = runGit(['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
        return head + ':' + hash.digest('hex');
    } catch {
        return null;
    }
};
// The content key: the tree a gate run saw, as file contents alone — the git tree id of
// the work tree as `git add -A` would stage it, `.factory/` excluded, plus each nested repository's
// own key (a submodule, an untracked repo). HEAD is not part of it, so a publish committing the same
// bytes keeps it. Built in a throwaway index and object directory (the repo's objects read through
// an alternate), so the checkout's index and .git are never written. Null wherever a staged blob
// could hide a change a gate sees (`hidesChanges`), and on any failed read. Git-ignored files are
// not in it, as they are not in the fingerprint: they are the environment, not the work.
const CONTENT_ATTRS = ['text', 'eol', 'ident', 'working-tree-encoding'];
const AUTOCRLF_OFF = new Set(['', 'false', 'no', 'off', '0']);
// `check-attr -z` answers in triples: path, attribute, value.
const ATTR_FIELDS = 3;
// The staging settings that write beside the index (a shared index) or ask a daemon, off for the copy.
const ISOLATED = ['-c', 'core.splitIndex=false', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
// Whether staging this checkout could store the same blob for bytes, a mode or a file type a gate
// would see differently: line-ending or encoding conversion, a clean filter driver a path names, a checkout
// that does not record modes or symlinks or folds case, an index entry git is told not to look at
// (assume-unchanged, skip-worktree), or a split index whose shared half a stage would write.
/**
 * @param {(args: string[], extra?: object) => Buffer} read
 * @param {(args: string[]) => string} text
 * @returns {boolean}
 */
const hidesChanges = (read, text) => {
    /**
     * @param {string} key
     * @param {string} [type]
     */
    const config = (key, type) => {
        try {
            return text(['config', ...(type ? ['--type', type] : []), '--get', key]).toLowerCase();
        } catch {
            return '';
        }
    };
    if (!AUTOCRLF_OFF.has(config('core.autocrlf'))) return true;
    if (config('core.filemode', 'bool') === 'false' || config('core.symlinks', 'bool') === 'false') return true;
    // A case-only rename keeps the index's old spelling where git folds case.
    if (config('core.ignorecase', 'bool') === 'true') return true;
    if (text(['rev-parse', '--shared-index-path'])) return true;
    const tags = read(['ls-files', '-z', '-v', '--cached']).toString('utf8').split('\0');
    if (tags.some((entry) => entry && (entry[0] === 'S' || /^[a-z]/.test(entry)))) return true;
    const listed = read(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    const attrs = read(['check-attr', '--stdin', '-z', ...CONTENT_ATTRS], { input: listed })
        .toString('utf8')
        .split('\0');
    for (let i = ATTR_FIELDS - 1; i < attrs.length; i += ATTR_FIELDS) {
        if (attrs[i] && attrs[i] !== 'unspecified' && attrs[i] !== 'unset') return true;
    }
    // A filter driver rewrites only the paths whose `filter` attribute names it, so one configured
    // host-wide (git-lfs) leaves the rest alone. Matched by name, `unset` and `unspecified` included:
    // a driver may be called that.
    let drivers = '';
    try {
        drivers = read(['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$']).toString('utf8');
    } catch {}
    const named = new Set(
        drivers
            .split('\n')
            .filter(Boolean)
            .map((key) => key.slice('filter.'.length, key.lastIndexOf('.')))
    );
    if (named.size === 0) return false;
    const filters = read(['check-attr', '--stdin', '-z', 'filter'], { input: listed }).toString('utf8').split('\0');
    for (let i = ATTR_FIELDS - 1; i < filters.length; i += ATTR_FIELDS) {
        if (named.has(filters[i])) return true;
    }
    return false;
};
/**
 * @param {string} cwd
 * @param {import('node:crypto').Hash} hash
 * @returns {string}
 */
const contentTreeOf = (cwd, hash) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    /**
     * @param {string[]} args
     * @param {object} [extra]
     * @returns {Buffer}
     */
    const read = (args, extra = {}) =>
        runGit(args, { cwd, encoding: 'buffer', maxBuffer: FINGERPRINT_MAX_BUFFER, ...extra });
    /** @param {string[]} args */
    const text = (args) => read(args).toString('utf8').trim();
    if (hidesChanges(read, text)) throw new Error('a staged blob could hide a change');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'content-key-'));
    try {
        const index = path.join(tmp, 'index');
        try {
            fs.copyFileSync(path.resolve(cwd, text(['rev-parse', '--git-path', 'index'])), index);
        } catch (e) {
            if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
        }
        const objects = path.join(tmp, 'objects');
        fs.mkdirSync(objects);
        const env = {
            ...process.env,
            GIT_INDEX_FILE: index,
            GIT_OBJECT_DIRECTORY: objects,
            GIT_ALTERNATE_OBJECT_DIRECTORIES: path.resolve(cwd, text(['rev-parse', '--git-path', 'objects'])),
        };
        // An untracked nested repository would be staged as a gitlink (or refused with no commit):
        // it is left out here and keyed by its own content below.
        const nested = read([
            'ls-files',
            '-z',
            '--others',
            '--exclude-standard',
            '--directory',
            ...FINGERPRINT_PATHSPEC,
        ])
            .toString('utf8')
            .split('\0')
            .filter((name) => name.endsWith('/') && fs.existsSync(path.join(cwd, name, '.git')))
            .map((name) => name.slice(0, -1));
        const skip = nested.map((name) => ':(top,exclude,literal)' + name);
        // `.factory/` leaves the index after the add: an exclude pathspec naming an ignored path is
        // refused by `git add` as a path to add.
        read([...ISOLATED, 'add', '-A', '--', ':/', ...skip], { env });
        read([...ISOLATED, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ':(top).factory'], { env });
        const tree = read(['write-tree'], { env }).toString('utf8').trim();
        const gitlinks = read(['ls-files', '-z', '--stage'], { env })
            .toString('utf8')
            .split('\0')
            .filter((entry) => entry.startsWith('160000 '))
            .map((entry) => entry.slice(entry.indexOf('\t') + 1));
        for (const name of [...gitlinks, ...nested].sort()) {
            hash.update(name + '\0');
            const dir = path.join(cwd, name);
            // An uninitialized submodule has no work tree: its gitlink in the tree is all there is.
            if (fs.existsSync(path.join(dir, '.git'))) hash.update(contentTreeOf(dir, hash));
        }
        return tree;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
};
/** @param {string} cwd */
const contentKeyOf = (cwd) => {
    try {
        const hash = require('node:crypto').createHash('sha256');
        const tree = contentTreeOf(cwd, hash);
        return tree + ':' + hash.digest('hex');
    } catch {
        return null;
    }
};
// Whether a file or a directory holding one of the tree's paths was touched at or after `sinceMs`:
// the fingerprint cannot see a file changed and put back, the mtime can. A path that is gone is
// skipped — its directory's mtime records the removal; any other read failure is true. A nested
// repository (a submodule, an untracked repo) is walked the same way, recursively.
/**
 * @param {string} cwd
 * @param {number} sinceMs
 * @returns {boolean}
 */
const mutatedSince = (cwd, sinceMs) => {
    try {
        const fs = require('node:fs');
        const path = require('node:path');
        const listed = runGit(
            ['ls-files', '-z', '--cached', '--others', '--exclude-standard', ...FINGERPRINT_PATHSPEC],
            {
                cwd,
                encoding: 'buffer',
                maxBuffer: FINGERPRINT_MAX_BUFFER,
            }
        )
            .toString('utf8')
            .split('\0')
            .filter(Boolean);
        const nested = new Set(listed);
        const paths = new Set(listed);
        paths.add('.');
        for (const name of listed) {
            for (let dir = path.dirname(name); dir !== '.'; dir = path.dirname(dir)) paths.add(dir);
        }
        for (const name of paths) {
            try {
                const stat = fs.lstatSync(path.join(cwd, name));
                if (stat.mtimeMs >= sinceMs) return true;
                // A listed directory is a submodule or a nested repository: the files inside it ship
                // with the tree, and touching one moves neither this directory nor the fingerprint.
                if (nested.has(name) && stat.isDirectory() && mutatedSince(path.join(cwd, name), sinceMs)) {
                    return true;
                }
            } catch (e) {
                if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') return true;
            }
        }
        return false;
    } catch {
        return true;
    }
};
const CONFLICTING_PATHS_MAX = 50;
/**
 * @type {{ cloned: boolean, branch: string, defaultBranch: string, dirty: boolean, unpushed: number,
 *   hasIdentity: boolean, fingerprint: string | null, content: string | null, mutatedSince?: boolean,
 *   noChange: boolean, conflicts: string[], rebasing: boolean }}
 */
const out = {
    cloned: false,
    branch: '',
    defaultBranch: 'main',
    dirty: false,
    unpushed: 0,
    hasIdentity: false,
    fingerprint: null,
    content: null,
    noChange: false,
    conflicts: [],
    rebasing: false,
};
try {
    /** @param {string[]} a */
    const git = (...a) => runGit(a, { cwd: repo, encoding: 'utf8' }).trim();
    git('rev-parse', '--is-inside-work-tree');
    out.cloned = true;
    out.branch = git('branch', '--show-current');
    // A claim that names its base (BASE_BRANCH, a batch task's target) compares against it instead.
    try {
        out.defaultBranch =
            process.env.BASE_BRANCH ||
            git('symbolic-ref', 'refs/remotes/origin/HEAD').replace('refs/remotes/origin/', '');
    } catch {}
    // The `.factory/` state namespace is never publishable work — publish.ts's GIT_STAGE_STEPS
    // exclude it, so a tree dirty only there must read clean or the commit would find nothing.
    out.dirty = git('status', '--porcelain', '--', ':/', ':(top,exclude).factory').length > 0;
    try {
        out.unpushed = Number(git('rev-list', '--count', 'origin/' + out.defaultBranch + '..HEAD')) || 0;
    } catch {
        out.unpushed = 0;
    }
    out.fingerprint = fingerprintOf(/** @type {string} */ (repo));
    out.content = contentKeyOf(/** @type {string} */ (repo));
    const sinceMs = Number(process.env.MUTATED_SINCE_MS);
    if (process.env.MUTATED_SINCE_MS && Number.isFinite(sinceMs))
        out.mutatedSince = mutatedSince(/** @type {string} */ (repo), sinceMs);
    // No change: nothing uncommitted AND no diff of HEAD against the base (exit 0 of --quiet). A
    // missing base ref, a failed status or any other error leaves it false: unknown is never a skip.
    try {
        git('diff', '--quiet', 'origin/' + out.defaultBranch + '...HEAD');
        out.noChange = !out.dirty;
    } catch {}
    // A tree the agent left conflicted, or a rebase it left stopped, is not publishable work.
    out.conflicts = git('diff', '--name-only', '--diff-filter=U')
        .split('\n')
        .filter(Boolean)
        .slice(0, CONFLICTING_PATHS_MAX);
    out.rebasing = ['rebase-merge', 'rebase-apply'].some((name) => {
        const resolved = git('rev-parse', '--git-path', name);
        return require('node:fs').existsSync(require('node:path').resolve(/** @type {string} */ (repo), resolved));
    });
    out.hasIdentity = (() => {
        try {
            return git('config', 'user.email').length > 0;
        } catch {
            return false;
        }
    })();
} catch {}
console.log(JSON.stringify(out));
