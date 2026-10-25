// The startup sync of the task's own checkout (issue #775): make `/task/<repo>` — an independent
// clone on the task volume, no shared base clone and no linked worktree — reflect the remote
// default, so every run starts from the code, and the declared gates, that main actually has. One
// execFileSync per git call: no value can become a command. One JSON verdict on stdout:
// {ok:true,reason:null,fingerprint} or {ok:false,reason}.
//
// Environment (set by the driver; paths, a URL, a branch name, and — when the claim carries a token —
// the credential-helper CODE; never a credential value):
//   CHECKOUT    — the task's own tree;
//   REMOTE      — where it is cloned from (`<cloneBase>/<owner>/<name>.git`);
//   BRANCH      — the branch the tree runs on (`factory/<thread root id>`);
//   BASE_BRANCH — optional, STARTING claims only: the branch the task bases on (a batch task's
//                 target branch). The branch is created off, and rebased onto, origin/<base>
//                 instead of origin/<default>. A base the fetched remote lacks is a named refusal,
//                 never the empty-remote path.
//   RESTORE     — set to `1` for a claim that CONTINUES a session (a follow-up): the task is
//                 mid-flight, and git operations that touch the remote belong to the task's
//                 beginning and end, never its middle. No fetch, no rebase: the existing tree is
//                 left byte-for-byte as the run before it left it. A missing tree is a named
//                 failure (there is nothing to continue), never a fresh clone, and a tree standing
//                 on another branch or a detached HEAD is a named refusal. No credential helper is
//                 needed, because nothing here talks to the remote.
//   CRED_HELPER — optional, STARTING claims only: the git credential-helper program the clone and
//                 the fetch run (`-c credential.helper=`), set only beside the GITHUB_TOKEN the
//                 board minted for this sync (docs/connections.md). The token itself arrives only via
//                 the environment, which git hands the helper it spawns. Absent: the clone and the
//                 fetch run plain, which is what a public repo wants. When set, they run under two
//                 credential-safety rules, because this helper is CONTEXT-FREE — it answers the
//                 token to whatever host or transport asks: the remote must be an https URL, and
//                 the fetch carries `-c http.followRedirects=initial`, which permits same-host
//                 redirects only, never a hop to another host or scheme.
//
// REVIEW mode, set by REVIEW_REF (issue #549): a named reviewer's claim. The review has no session
// and no earlier tree, so its worktree is a linked worktree of the task's checkout:
//   REPO        — the task's checkout, where the review's worktree is created FROM;
//   WORKTREE    — the review's own tree; BRANCH its branch, created AT REVIEW_REF on the first
//                 attempt and kept as it is after — still with no fetch and no rebase, because
//                 nothing a reviewer needs is on the remote.
//
// STARTING claims, tree present: rebased onto the new default with --autostash, so a follow-up
// works whether or not the previous run left uncommitted edits; the edits are stashed for the
// rebase and reapplied on the new base. Git exits 0 even when the reapplied STASH conflicts (the
// rebase itself succeeded), so the script re-checks for unmerged entries. A conflict is HANDED
// OVER, never refused (issue #661): the conflicted rebase (or the markers, the stash retained for
// recovery) is left in the tree and the verdict is `{ok:true, conflicts:[paths]}`, so the driver
// starts the run with the conflicting paths in its turn context and the agent resolves them. A
// tree a previous attempt left conflicted — a rebase in progress, or unmerged entries — is handed
// over as it is, without a second rebase; a RESTORE claim reports the same.
//
// STARTING claims, tree absent: a partial clone (`--filter=blob:none --no-checkout`) into a build
// directory beside the path, then the branch is created from origin/<branch> when the thread already
// pushed one (a fresh volume must not cost its commits), else at origin/<base>, and the finished tree
// is renamed into place: a kill leaves a build directory the next claim removes, never a half-made
// tree. A git dir with a commit and no index is such a half-made tree of an older sync: removed and
// built again when it holds nothing else, refused when it holds files. Every git command that can
// lazily fetch a partial clone's blobs (clone, fetch, checkout, rebase) runs under the credential
// helper. A path that holds something this sync did not create is REFUSED, never deleted: whatever uncommitted work sits there belongs to an agent
// session. A remote with NO commits (a scaffolding task) has no origin/<default>: the tree starts
// empty on an unborn task branch, and an existing tree is not rebased.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const review = Boolean(process.env.REVIEW_REF);
const reviewRef = process.env.REVIEW_REF;
// `let`: a fresh tree is built beside its final path (`createTree`), and these point at the build while it is.
let repo = review ? process.env.REPO : process.env.CHECKOUT;
let wt = review ? process.env.WORKTREE : process.env.CHECKOUT;
const remote = process.env.REMOTE;
const branch = process.env.BRANCH;
const restore = process.env.RESTORE === '1';
const baseBranch = process.env.BASE_BRANCH || '';
const GIT_ERROR_MAX_LENGTH = 200;
const SYNC_ERROR_MAX_LENGTH = 300;
const FACTORY_STATE_EXCLUDE = '/.factory/';

const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const inw = (...a) => execFileSync('git', a, { cwd: wt, encoding: 'utf8' }).trim();
// A command that can lazily fetch missing blobs of a partial clone (checkout, rebase, and the stash it
// reapplies) talks to the remote like the clone and the fetch do, so it runs under the same helper.
const inwFetching = (...a) => inw(...withCredentials(...a));
const detail = (e, max) => String((e && e.stderr) || (e && e.message) || e).slice(0, max);
// ENOENT/ENOTDIR is absence; any other errno is a failure to read, never "not there".
const exists = (p) => {
    try {
        fs.statSync(p);
        return true;
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
        throw e;
    }
};
// The tree fingerprint (spelled identically in git-probe.cjs, which the driver re-runs after a
// failed gate): HEAD plus a hash of the uncommitted state — the porcelain status, the tracked
// diff and the untracked files' contents, `.factory/` excluded. Equal fingerprints mean the round
// between them changed nothing. Null when any read fails: an unknown is never a guess.
const FINGERPRINT_PATHSPEC = ['--', ':/', ':(top,exclude).factory'];
const FINGERPRINT_MAX_BUFFER = 268_435_456; // 256 MiB: a large diff must not read as unknown
// Hashes the uncommitted state of one work tree into `hash`. A submodule's own diff is included
// (`--submodule=diff`), or a dirty submodule edited again would read identical. An untracked
// entry is read here, not by `hash-object`, which throws on a dangling symlink or a nested repo:
// a symlink hashes its target, a nested repo recurses (it may have no commit yet), anything that
// is not a regular file hashes its type alone.
const hashTree = (cwd, hash, nested) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const read = (args) => execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: FINGERPRINT_MAX_BUFFER });
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
const fingerprintOf = (cwd) => {
    try {
        const hash = require('node:crypto').createHash('sha256');
        hashTree(cwd, hash, false);
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
        return head + ':' + hash.digest('hex');
    } catch {
        return null;
    }
};

const CONFLICTING_PATHS_MAX = 50;
/** The tree's unmerged paths, capped; empty when it has none. */
const unmergedPaths = () =>
    inw('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean).slice(0, CONFLICTING_PATHS_MAX);
/**
 * Whether a path is there: false ONLY on ENOENT/ENOTDIR. Any other error (EACCES, EIO, ...) means
 * the path could not be read, which is no evidence of absence — it throws, never answers "absent".
 */
function present(p) {
    try {
        fs.statSync(p);
        return true;
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
        throw new Error('unreadable ' + p + ': ' + (e.code || e.message));
    }
}
const REBASE_DIRS = ['rebase-merge', 'rebase-apply'];
const rebaseDir = (name) => {
    const resolved = inw('rev-parse', '--git-path', name);
    return path.isAbsolute(resolved) ? resolved : path.resolve(wt, resolved);
};
/** Whether a rebase is stopped in the tree — conflicted, or resolved but not yet continued. */
const rebaseInProgress = () => REBASE_DIRS.some((name) => present(rebaseDir(name)));
/** The branch a stopped rebase is rebasing, or '' when its state names none. */
const rebasedBranch = () => {
    for (const name of REBASE_DIRS) {
        try {
            return fs
                .readFileSync(path.join(rebaseDir(name), 'head-name'), 'utf8')
                .trim()
                .replace('refs/heads/', '');
        } catch {}
    }
    return '';
};
// A conflicted rebase is finished by the agent's bare `git rebase --continue`, which commits and so
// needs a committer identity: the images bake the publisher's fallback (/etc/gitconfig); it is written
// into the tree's own config only when git can form none, as in a sync run under another image.
const ensureIdentity = () => {
    try {
        execFileSync('git', ['var', 'GIT_COMMITTER_IDENT'], { cwd: wt, stdio: 'ignore' });
        return;
    } catch {}
    inw('config', '--local', 'user.name', 'factory-ai');
    inw('config', '--local', 'user.email', 'factory-ai@users.noreply.github.com');
};
const synced = (conflicts) =>
    console.log(
        JSON.stringify({
            ok: true,
            reason: null,
            fingerprint: fingerprintOf(wt),
            ...(conflicts && conflicts.length ? { conflicts } : {}),
        })
    );
/** Answers ok with the conflict left in the tree for the agent. */
const handOver = () => {
    ensureIdentity();
    synced(unmergedPaths());
};
// The kinds a deterministic refusal names (driver/src/publish/publish.ts, SYNC_FAILURE_KINDS — a .cjs cannot
// import it, so the literals are pinned by scripts-task-checkout.test.ts): no retry fixes any of them.
const KIND_BRANCH_UNRESTORABLE = 'branch_unrestorable';
const KIND_MISSING_BASE_BRANCH = 'missing_base_branch';
const fail = (r, kind) => {
    if (!restore) {
        try {
            inw('rebase', '--abort');
        } catch {}
    }
    console.log(JSON.stringify(kind ? { ok: false, reason: r, kind } : { ok: false, reason: r }));
};
const refuse = (r, kind) => {
    fail(r, kind);
    process.exit(0);
};

/** Where a tree is built before it is moved to `final`: a dot-name beside it, which no repo directory can be. */
const buildDirOf = (final) => path.join(path.dirname(final), '.' + path.basename(final) + '.sync');
const discardTree = (dir) => fs.rmSync(dir, { recursive: true, force: true });
// The build in progress, removed if the script leaves before it is moved into place.
let building = null;
process.on('exit', () => {
    if (building) discardTree(building);
});

/**
 * Whether the tree has a commit but no index: what a creation killed between the clone and the end of
 * its checkout leaves. Every file would read as staged-deleted, and a publish's `git add -A` would
 * commit the repository away. A tree on an unborn branch has no index legitimately.
 */
const missingIndex = () => {
    try {
        inw('rev-parse', '--verify', '--quiet', 'HEAD');
    } catch {
        return false;
    }
    let index = inw('rev-parse', '--git-path', 'index');
    if (!path.isAbsolute(index)) index = path.resolve(wt, index);
    return !present(index);
};

/** The clone or the fetch, under the claim's credential helper when it carries a token. */
const withCredentials = (...args) =>
    process.env.CRED_HELPER
        ? ['-c', 'credential.helper=' + process.env.CRED_HELPER, '-c', 'http.followRedirects=initial', ...args]
        : args;

/**
 * Git-ignores the `.factory/` state namespace (helper verdicts, review digests) in this clone:
 * `info/exclude` is where git reads it, found with `rev-parse --git-path`, never a `.git/info`
 * join. Without it the publisher's `git add -A` committed the probe's state file into task PRs.
 */
const excludeFactoryState = () => {
    let excludePath = git('rev-parse', '--git-path', 'info/exclude');
    if (!path.isAbsolute(excludePath)) excludePath = path.resolve(repo, excludePath);
    const existing = present(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    if (existing.split('\n').includes(FACTORY_STATE_EXCLUDE)) return;
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(
        excludePath,
        (existing === '' || existing.endsWith('\n') ? '' : '\n') + FACTORY_STATE_EXCLUDE + '\n'
    );
};

/** Whether the fetched remote has the named ref (`origin/<name>`); false for a repository with no commits. */
const hasRemoteRef = (name) => {
    try {
        git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + name);
        return true;
    } catch {
        return false;
    }
};

/**
 * The tree of a repository with no commits: HEAD is pointed at the unborn task branch, nothing
 * checked out, so the first commit starts the branch.
 */
const startUnborn = () => inw('symbolic-ref', 'HEAD', 'refs/heads/' + branch);

/** Refuses an existing review worktree that is not a worktree of the task checkout, or stands on another branch. */
const assertReviewTreeIsOurs = () => {
    let common = inw('rev-parse', '--git-common-dir');
    if (!path.isAbsolute(common)) common = path.resolve(wt, common);
    const ours = fs.realpathSync(repo + '/.git');
    if (fs.realpathSync(common) !== ours) {
        refuse(
            'the review worktree path holds a git tree that is not a worktree of the task checkout: its git dir is ' +
                fs.realpathSync(common) +
                ', but it must belong to ' +
                ours +
                ' — remove it by hand if it is truly stale'
        );
    }
    const on = rebaseInProgress() ? rebasedBranch() : inw('branch', '--show-current');
    if (on !== branch) {
        refuse(
            'the review worktree stands on ' +
                (on ? 'branch ' + on : 'a detached HEAD') +
                ' instead of its branch ' +
                branch +
                ' — a resumed job must never run in the wrong checkout'
        );
    }
};

/** Links a fresh review worktree on its branch, created from the snapshot when the branch is new. */
const addReviewWorktree = () => {
    // Built beside its path and moved in, so a kill midway leaves a build directory the next claim
    // removes, never a worktree with a git dir and half a checkout.
    const build = buildDirOf(wt);
    discardTree(build);
    discardTree(wt);
    git('worktree', 'prune');
    building = build;
    try {
        try {
            git('worktree', 'add', build, branch);
        } catch {
            git('worktree', 'add', '-b', branch, build, reviewRef);
        }
        git('worktree', 'move', build, wt);
    } catch (e) {
        discardTree(build);
        git('worktree', 'prune');
        refuse('the review snapshot ' + reviewRef + ' could not be checked out: ' + detail(e, GIT_ERROR_MAX_LENGTH));
    }
    building = null;
};

/** A REVIEW claim: a linked worktree of the task's checkout, at its snapshot. */
const syncReview = () => {
    if (exists(wt + '/.git') && inw('rev-parse', '--is-inside-work-tree') === 'true') {
        assertReviewTreeIsOurs();
        // A worktree without its index is an interrupted creation, and nobody's work: built again.
        if (missingIndex()) {
            addReviewWorktree();
        }
        return synced();
    }
    if (exists(wt + '/.git')) {
        refuse(
            'the worktree path exists and holds a git tree this sync did not create; remove it by hand if it is truly stale: ' +
                wt
        );
    }
    addReviewWorktree();
    synced();
};

/** A RESTORE claim: the existing tree, kept exactly as the run before it left it. */
const syncRestore = () => {
    if (!exists(wt + '/.git')) {
        refuse(
            'the task checkout ' +
                wt +
                ' does not exist on the task volume — there is nothing to continue, and a follow-up is never ' +
                'restarted fresh off the remote default (re-queue the task to start it over)',
            KIND_BRANCH_UNRESTORABLE
        );
    }
    if (missingIndex()) {
        refuse(
            'the task checkout ' +
                wt +
                ' has no index: its creation was interrupted, so it cannot be continued (re-queue the task to start it over)',
            KIND_BRANCH_UNRESTORABLE
        );
    }
    // A stopped rebase detaches HEAD; the branch it is rebasing is the task's own.
    const on = rebaseInProgress() ? rebasedBranch() : inw('branch', '--show-current');
    if (on !== branch) {
        refuse(
            'the task checkout stands on ' +
                (on ? 'branch ' + on : 'a detached HEAD') +
                ' instead of the task branch ' +
                branch +
                ' — a resumed job must never run in the wrong checkout',
            KIND_BRANCH_UNRESTORABLE
        );
    }
    if (rebaseInProgress() || unmergedPaths().length) handOver();
    else synced();
};

/** The remote's default branch name, learned from the clone's HEAD (or the first branch of a once-empty remote). */
const defaultBranch = () => {
    try {
        return git('symbolic-ref', 'refs/remotes/origin/HEAD').replace('refs/remotes/origin/', '');
    } catch {
        try {
            git('remote', 'set-head', 'origin', '--auto');
            return git('symbolic-ref', 'refs/remotes/origin/HEAD').replace('refs/remotes/origin/', '');
        } catch {
            return 'main';
        }
    }
};

/** Refuses a credentialed fetch or clone over anything but an https origin. */
const assertCredentialedOrigin = (present) => {
    if (!process.env.CRED_HELPER) return;
    const origin = present ? git('remote', 'get-url', 'origin') : remote;
    if (!origin.startsWith('https://')) {
        refuse(
            'the credentialed clone and fetch refuse origin ' +
                origin +
                ': the credential helper answers the token to whatever asks, so only an https origin may ' +
                'use it'
        );
    }
};

/** Clones the remote (partial, no checkout) into `dest`, under the claim's credential helper. */
const cloneInto = (dest) =>
    execFileSync(
        'git',
        withCredentials(
            'clone',
            '--filter=blob:none',
            '--no-checkout',
            '--config',
            'core.sharedRepository=group',
            '--origin',
            'origin',
            '--',
            remote,
            dest
        ),
        { cwd: path.dirname(dest), encoding: 'utf8' }
    );

/** Puts an existing tree on its task branch and rebases it onto the base; a conflicted tree is handed over. */
const rebaseExisting = (base, hasBase) => {
    // An existing tree over an empty remote has no new base to rebase onto: it is left as it is.
    if (!hasBase) return synced();
    // A tree a previous attempt left conflicted is handed over as it is: a second rebase would
    // refuse to start over its markers.
    if (rebaseInProgress() || unmergedPaths().length) return handOver();
    const on = inw('branch', '--show-current');
    if (on !== branch) {
        try {
            inwFetching('checkout', branch);
        } catch {
            inwFetching('checkout', '-b', branch, hasRemoteRef(branch) ? 'origin/' + branch : 'origin/' + base);
        }
    }
    try {
        inwFetching('rebase', '--autostash', 'origin/' + base);
    } catch (e) {
        // A conflicted rebase stays in place for the agent; any other failure is a refusal.
        if (unmergedPaths().length) return handOver();
        refuse('the task checkout could not be rebased onto origin/' + base + ': ' + detail(e, GIT_ERROR_MAX_LENGTH));
    }
    // The rebase succeeded; the reapplied autostash left markers (and is kept for recovery).
    if (unmergedPaths().length) return handOver();
    synced();
};

/** The base the tree starts from: the claim's named branch, else the remote default; a named base the remote lacks is refused. */
const resolveBase = () => {
    const base = baseBranch || defaultBranch();
    const hasBase = hasRemoteRef(base);
    if (baseBranch && !hasBase) {
        refuse(
            'the base branch origin/' +
                base +
                ' does not exist on the remote; create it, or point the batch target at a branch that does',
            KIND_MISSING_BASE_BRANCH
        );
    }
    return { base, hasBase };
};

/**
 * A fresh tree, built whole beside its path and moved in by one rename: a kill at any step leaves a
 * build directory the next claim removes, never a git dir with half a checkout where the task's tree
 * belongs. A path that holds something this sync did not create is REFUSED, never deleted.
 */
const createTree = () => {
    const final = wt;
    if (exists(final)) {
        refuse(
            'the checkout path exists and holds something this sync did not create; remove it by hand if it is truly stale: ' +
                final
        );
    }
    const build = buildDirOf(final);
    discardTree(build);
    building = build;
    cloneInto(build);
    repo = build;
    wt = build;
    excludeFactoryState();
    const { base, hasBase } = resolveBase();
    if (hasRemoteRef(branch)) inwFetching('checkout', '-b', branch, 'origin/' + branch);
    else if (hasBase) inwFetching('checkout', '-b', branch, 'origin/' + base);
    else startUnborn();
    repo = final;
    wt = final;
    fs.renameSync(build, final);
    building = null;
    synced();
};

/**
 * An existing git dir with no index and nothing else in it is an interrupted creation of an older
 * sync: no work is in it, so it is removed and built again. One holding files is refused, never touched.
 */
const discardInterruptedTree = () => {
    if (!missingIndex()) return false;
    if (fs.readdirSync(wt).some((name) => name !== '.git')) {
        refuse(
            'the task checkout ' +
                wt +
                ' has no index and holds files: an interrupted checkout that may carry work; remove it by hand if it is truly stale'
        );
    }
    discardTree(wt);
    return true;
};

/** A STARTING claim: build the tree when absent, fetch and rebase it when present. */
const syncStarting = () => {
    const present = exists(wt + '/.git') && !discardInterruptedTree();
    assertCredentialedOrigin(present);
    if (!present) return createTree();
    git(...withCredentials('fetch', 'origin', '--prune'));
    excludeFactoryState();
    const { base, hasBase } = resolveBase();
    return rebaseExisting(base, hasBase);
};

try {
    if (review) syncReview();
    else if (restore) syncRestore();
    else syncStarting();
} catch (e) {
    fail('checkout sync failed: ' + detail(e, SYNC_ERROR_MAX_LENGTH));
}
