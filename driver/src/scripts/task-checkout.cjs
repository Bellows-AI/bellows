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
// STARTING claims, tree absent: a partial clone (`--filter=blob:none --no-checkout`), then the
// branch is created from origin/<branch> when the thread already pushed one (a fresh volume must
// not cost its commits), else at origin/<base>. A path that holds something this sync did not
// create is REFUSED, never deleted: whatever uncommitted work sits there belongs to an agent
// session. A remote with NO commits (a scaffolding task) has no origin/<default>: the tree starts
// empty on an unborn task branch, and an existing tree is not rebased.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const review = Boolean(process.env.REVIEW_REF);
const reviewRef = process.env.REVIEW_REF;
const repo = review ? process.env.REPO : process.env.CHECKOUT;
const wt = review ? process.env.WORKTREE : process.env.CHECKOUT;
const remote = process.env.REMOTE;
const branch = process.env.BRANCH;
const restore = process.env.RESTORE === '1';
const baseBranch = process.env.BASE_BRANCH || '';
const GIT_ERROR_MAX_LENGTH = 200;
const SYNC_ERROR_MAX_LENGTH = 300;
const FACTORY_STATE_EXCLUDE = '/.factory/';

const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const inw = (...a) => execFileSync('git', a, { cwd: wt, encoding: 'utf8' }).trim();
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
const REBASE_DIRS = ['rebase-merge', 'rebase-apply'];
const rebaseDir = (name) => {
    const resolved = inw('rev-parse', '--git-path', name);
    return path.isAbsolute(resolved) ? resolved : path.resolve(wt, resolved);
};
/** Whether a rebase is stopped in the tree — conflicted, or resolved but not yet continued. */
const rebaseInProgress = () => REBASE_DIRS.some((name) => fs.existsSync(rebaseDir(name)));
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
// needs a committer identity the runner image does not carry: the publisher's fallback, written
// into the tree's own config only when git can form none.
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
// The kinds a deterministic refusal names (driver/src/publish.ts, SYNC_FAILURE_KINDS — a .cjs cannot
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
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
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
    fs.rmSync(wt, { recursive: true, force: true });
    git('worktree', 'prune');
    try {
        try {
            git('worktree', 'add', wt, branch);
        } catch {
            git('worktree', 'add', '-b', branch, wt, reviewRef);
        }
    } catch (e) {
        refuse('the review snapshot ' + reviewRef + ' could not be checked out: ' + detail(e, GIT_ERROR_MAX_LENGTH));
    }
};

/** A REVIEW claim: a linked worktree of the task's checkout, at its snapshot. */
const syncReview = () => {
    if (exists(wt + '/.git') && inw('rev-parse', '--is-inside-work-tree') === 'true') {
        assertReviewTreeIsOurs();
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

/** Fetches into the present checkout, or clones it (partial, no checkout) when the path is free. */
const fetchOrClone = (present) => {
    if (present) {
        git(...withCredentials('fetch', 'origin', '--prune'));
        return;
    }
    if (exists(wt)) {
        refuse(
            'the checkout path exists and holds something this sync did not create; remove it by hand if it is truly stale: ' +
                wt
        );
    }
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
            wt
        ),
        { cwd: path.dirname(wt), encoding: 'utf8' }
    );
};

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
            inw('checkout', branch);
        } catch {
            inw('checkout', '-b', branch, hasRemoteRef(branch) ? 'origin/' + branch : 'origin/' + base);
        }
    }
    try {
        inw('rebase', '--autostash', 'origin/' + base);
    } catch (e) {
        // A conflicted rebase stays in place for the agent; any other failure is a refusal.
        if (unmergedPaths().length) return handOver();
        refuse('the task checkout could not be rebased onto origin/' + base + ': ' + detail(e, GIT_ERROR_MAX_LENGTH));
    }
    // The rebase succeeded; the reapplied autostash left markers (and is kept for recovery).
    if (unmergedPaths().length) return handOver();
    synced();
};

/** A STARTING claim: clone when absent, fetch when present, then put the tree on the task branch. */
const syncStarting = () => {
    const present = exists(wt + '/.git');
    assertCredentialedOrigin(present);
    fetchOrClone(present);
    excludeFactoryState();
    const def = defaultBranch();
    const base = baseBranch || def;
    const hasBase = hasRemoteRef(base);
    if (baseBranch && !hasBase) {
        refuse(
            'the base branch origin/' +
                base +
                ' does not exist on the remote; create it, or point the batch target at a branch that does',
            KIND_MISSING_BASE_BRANCH
        );
    }
    if (!present) {
        if (hasRemoteRef(branch)) inw('checkout', '-b', branch, 'origin/' + branch);
        else if (hasBase) inw('checkout', '-b', branch, 'origin/' + base);
        else startUnborn();
        return synced();
    }
    return rebaseExisting(base, hasBase);
};

try {
    if (review) syncReview();
    else if (restore) syncRestore();
    else syncStarting();
} catch (e) {
    fail('checkout sync failed: ' + detail(e, SYNC_ERROR_MAX_LENGTH));
}
