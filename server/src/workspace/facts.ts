import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';

/**
 * What a checkout looks like on disk: its branch, its newest commit, and its size.
 *
 * All three are filesystem reads on a route the SPA polls. Done naively that is a `git log` plus a
 * recursive directory walk per repo, per member, per tick — so nothing here is read on demand. The
 * route serves whatever is cached and schedules a refresh, and a cold entry reports null rather
 * than making the request wait for a walk.
 *
 * Null therefore means "not measured yet", never zero. A repository that is still cloning has no
 * size, and rendering `0 B` for it would be a claim rather than an absence.
 */

export interface CheckoutFacts {
    readonly branch: string | null;
    readonly lastCommit: { sha: string; at: string; headline: string } | null;
    readonly sizeBytes: number | null;
}

const UNKNOWN: CheckoutFacts = { branch: null, lastCommit: null, sizeBytes: null };

/**
 * Branch and last commit are one cheap `git log`, so they refresh often enough to look live after a
 * commit. The size is a full walk of the tree, which is the expensive one, so it refreshes rarely
 * and is allowed to be minutes out of date — nobody makes a decision on it.
 */
const HEAD_TTL_MS = 30_000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SIZE_TTL_MINUTES = 5;
const SIZE_TTL_MS = SIZE_TTL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * How long the size measurement is allowed to take before it is abandoned.
 *
 * A checkout with its dependencies installed is hundreds of thousands of files. `du` is fast, but a
 * cold page cache on a network volume is not, and an unbounded child process per checkout per five
 * minutes is a way to accumulate them.
 */
const SIZE_TIMEOUT_MS = 20_000;

/** `du -k` reports kibibytes; this converts to bytes for the payload. */
const BYTES_PER_KIB = 1024;

interface Entry {
    facts: CheckoutFacts;
    headAt: number;
    sizeAt: number;
    /** The last size reading found no directory — `sizeOf` re-measures as soon as one appears. */
    absent: boolean;
    /** Single-flight per key, so a burst of polls does not start a walk each. */
    pending: Promise<void> | null;
}

export interface FactsCache {
    /**
     * Never blocks and never throws. Schedules a refresh when what it has is stale. `root` is the
     * member's own tree: a checkout that really lies anywhere else reads as unmeasured.
     */
    get(dir: string, root: string): CheckoutFacts;

    /**
     * `get`'s size alone, for a directory that is not a checkout (a repo's package cache), under
     * the same rule: measured only where it really lies inside `root`, null otherwise.
     */
    sizeOf(dir: string, root: string): number | null;

    /**
     * Forgets one directory's facts, so a tree that is about to be deleted cannot lend them to
     * whatever is re-cloned into its path.
     *
     * For most of this cache's life there was no invalidate, and the header here said so: the route
     * only asked about a checkout once it was `ready`, a repository reached `ready` exactly once,
     * and so no entry could ever go stale. The manual purge (issue #92) is the one caller that
     * breaks that story — it deletes a tree whose measurements are sitting in this map, and a
     * re-selected repository reuses the same path. Without this, the new checkout would briefly
     * report its predecessor's size and commit.
     *
     * A refresh already in flight holds the old Entry object and writes its result there; deleting
     * the map entry orphans that object, so the write lands on nothing anyone reads.
     */
    invalidate(dir: string): void;
}

/**
 * Every read below runs on a tree a member's agent writes — its checkout, `.git/config` included —
 * from the board, which sees every org's tree. Two rules follow, and the scripts state both:
 *
 * - Nothing the checkout says may run code here. `git log` honours repo config that execs programs
 *   (`gpg.program` behind `log.showSignature`, and more); only plumbing that execs nothing runs —
 *   `rev-parse` and `cat-file` — and the commit object is parsed here instead of formatted by git.
 *   Even those lazily fetch a missing object in a promisor repo, and a fetch execs the transport
 *   the config names (`core.sshCommand`, `uploadpack`): no lazy fetch, no protocol, no ssh.
 * - Nothing the checkout says may point the read at another tree. `cd -P` lands on the directory a
 *   path REALLY names and `pwd -P` reports where that is, derived from the landed directory, so a
 *   symlink swapped in afterwards cannot change the answer; the reads then run relative to it.
 *   Inside `.git`, git would follow `commondir`, `objects/info/alternates` and symlinked refs to
 *   any path — those refuse the read, and `GIT_COMMON_DIR=.` pins the common dir to the landed one.
 *
 * Stated limit: git resolves refs and objects by path inside the landed `.git`, so an agent racing
 * a symlink into `refs/` between the check and the read could still point one read at a tree whose
 * absolute path it knows. Nothing it can name runs, and the window is one poll's few milliseconds.
 */
const CONTAINED_HEAD = `cd -P -- "$1" || exit 1
here=$(pwd -P)
case "$here" in "$2"/*) ;; *) exit 3 ;; esac
cd -P .git || exit 1
[ "$(pwd -P)" = "$here/.git" ] || exit 3
for f in commondir objects/info/alternates; do [ -e "$f" ] || [ -L "$f" ] && exit 3; done
[ -n "$(find HEAD packed-refs refs reftable -type l 2>/dev/null)" ] && exit 3
[ -n "$(find objects -type l 2>/dev/null)" ] && exit 3
export GIT_COMMON_DIR=. GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0
export GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL= GIT_SSH_COMMAND=false GIT_TERMINAL_PROMPT=0
branch=$(git --git-dir=. rev-parse --abbrev-ref HEAD 2>/dev/null)
sha=$(git --git-dir=. rev-parse --verify -q 'HEAD^{commit}') || { printf '%s\\n' "$branch"; exit 0; }
printf '%s\\n%s\\n' "$branch" "$sha"
exec git --git-dir=. cat-file commit "$sha"`;

/** As `readHead`, the size: `du .` in the landed directory, following nothing below it. */
const CONTAINED_DU = 'cd -P -- "$1" || exit 1; case "$(pwd -P)" in "$2"/*) exec du -sk . ;; esac; exit 3';

const SECONDS_PER_HOUR = 3600;
/** `YYYY-MM-DDTHH:MM:SS`: an ISO timestamp cut before its fraction and zone. */
const ISO_SECONDS_LENGTH = 19;
const TZ_FIELD = /^committer .* (\d+) ([+-])(\d\d)(\d\d)$/;
/** The head read is a few process spawns; a FIFO or a stalled volume must not pin its entry. */
const HEAD_TIMEOUT_MS = 10_000;

/** A commit object's header lines and message, split at the first blank line. */
function splitCommit(commit: string): { headers: string[]; body: string } {
    const at = commit.indexOf('\n\n');
    return at === -1
        ? { headers: commit.split('\n'), body: '' }
        : { headers: commit.slice(0, at).split('\n'), body: commit.slice(at + 2) };
}

/** `%cI`: the committer time in the committer's own offset, as `git log` printed it before. */
function committerIso(headers: string[]): string | null {
    const match = headers.map((line) => TZ_FIELD.exec(line)).find(Boolean);
    if (!match) return null;
    const [, epoch, sign, hours, minutes] = match;
    const offset = (sign === '-' ? -1 : 1) * (Number(hours) * SECONDS_PER_HOUR + Number(minutes) * SECONDS_PER_MINUTE);
    const date = new Date((Number(epoch) + offset) * MS_PER_SECOND);
    if (Number.isNaN(date.getTime())) return null;
    return `${date.toISOString().slice(0, ISO_SECONDS_LENGTH)}${sign}${hours}:${minutes}`;
}

/** `%s`: the message's first paragraph, its lines joined by a space. */
function subjectOf(body: string): string {
    return (
        body
            .split(/\n\s*\n/)[0]
            ?.split('\n')
            .map((line) => line.trim())
            .join(' ')
            .trim() ?? ''
    );
}

/**
 * Only what the scripts need from this process: an inherited `GIT_*` (a config count, a trace
 * file, an askpass) must not reach a read of a hostile tree.
 */
const containedEnv = () => ({ PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C' });
const KIB_PER_MIB = 1024;
const MAX_OUTPUT_BYTES = KIB_PER_MIB * BYTES_PER_KIB;

/**
 * One contained script, in its own process group, killed WHOLE at the deadline. `execFile`'s own
 * timeout signals the shell alone, and a git blocked inside `$(…)` on a FIFO the checkout planted
 * would outlive it — one more stranded process per poll.
 */
function runContained(script: string, dir: string, root: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', script, 'sh', dir, root], {
            detached: true,
            env: containedEnv(),
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const killGroup = () => {
            try {
                if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
            } catch {
                // The group already exited.
            }
        };
        const deadline = setTimeout(killGroup, timeoutMs);
        // Before anything can throw: a spawn that fails (ENOENT, EMFILE) emits `error`, and
        // an unlistened one would take the board down.
        child.on('error', (error) => {
            clearTimeout(deadline);
            reject(error);
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        child.stdout?.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_OUTPUT_BYTES) killGroup();
            else chunks.push(chunk);
        });
        child.on('close', (code) => {
            clearTimeout(deadline);
            if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
            else reject(new Error(`contained read exited ${code ?? 'on a signal'}`));
        });
    });
}

async function readHead(
    dir: string,
    root: string,
    timeoutMs: number
): Promise<Pick<CheckoutFacts, 'branch' | 'lastCommit'>> {
    const out = await realpath(root)
        .then((real) => runContained(CONTAINED_HEAD, dir, real, timeoutMs))
        .catch(() => '');
    const [branch = '', sha = ''] = out.split('\n', 2);
    const { headers, body } = splitCommit(out.slice(branch.length + sha.length + 2));
    const at = sha ? committerIso(headers) : null;
    return {
        branch: branch.trim() || null,
        lastCommit: sha && at ? { sha, at, headline: subjectOf(body) } : null,
    };
}

/** The bytes in `du -sk` output's leading kibibyte count, or null when it has none. */
function bytesOfDu(stdout: string): number | null {
    const kib = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
    return Number.isFinite(kib) ? kib * BYTES_PER_KIB : null;
}

/**
 * `du`, not a walk in this process: a checkout with its dependencies installed is hundreds of
 * thousands of files, and a walk here would stall the event loop for every other request.
 * `-s` for a total, `-k` for kibibytes (POSIX; `-b` is GNU-only and this runs on alpine).
 */
async function readSize(dir: string, root: string): Promise<number | null> {
    try {
        return bytesOfDu(await runContained(CONTAINED_DU, dir, await realpath(root), SIZE_TIMEOUT_MS));
    } catch {
        // Absent, outside the root, timed out, or `du` is absent. Null renders as an em dash, which
        // is the honest answer: nobody measured it. Never 0, which would claim an empty checkout.
        return null;
    }
}

export function createFactsCache(
    now: () => number = Date.now,
    { headTimeoutMs = HEAD_TIMEOUT_MS }: { headTimeoutMs?: number } = {}
): FactsCache {
    const entries = new Map<string, Entry>();

    /** `withHead` false: a size-only reading (`sizeOf`), with no git run at all. */
    const refresh = (dir: string, root: string, entry: Entry, withHead: boolean): void => {
        if (entry.pending) return;
        const wantHead = withHead && now() - entry.headAt >= HEAD_TTL_MS;
        const wantSize = now() - entry.sizeAt >= SIZE_TTL_MS;
        if (!wantHead && !wantSize) return;

        entry.pending = (async () => {
            // Both off the request path — nothing awaits this promise — and both concurrent with
            // each other, because they are separate processes reading the same directory.
            const [head, size] = await Promise.all([
                wantHead ? readHead(dir, root, headTimeoutMs) : null,
                wantSize ? readSize(dir, root) : null,
            ]);
            if (head) {
                entry.facts = { ...entry.facts, ...head };
                entry.headAt = now();
            }
            if (wantSize) {
                entry.facts = { ...entry.facts, sizeBytes: size };
                entry.sizeAt = now();
                entry.absent = size === null && !existsSync(dir);
            }
        })()
            .catch(() => {
                // A checkout that vanished, or a git that is not installed. The stale facts stay,
                // and the route keeps answering — none of this is load-bearing.
            })
            .finally(() => {
                entry.pending = null;
            });
    };

    const entryOf = (dir: string): Entry => {
        let entry = entries.get(dir);
        if (!entry) {
            entry = { facts: UNKNOWN, headAt: 0, sizeAt: 0, absent: false, pending: null };
            entries.set(dir, entry);
        }
        return entry;
    };

    return {
        get(dir, root) {
            const entry = entryOf(dir);
            refresh(dir, root, entry, true);
            return entry.facts;
        },

        sizeOf(dir, root) {
            const entry = entryOf(dir);
            // A cache a run has just created must not wait out the TTL behind an absent reading.
            if (entry.absent && existsSync(dir)) entry.sizeAt = 0;
            refresh(dir, root, entry, false);
            return entry.facts.sizeBytes;
        },

        invalidate(dir) {
            entries.delete(dir);
        },
    };
}
