import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

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
     * Never blocks and never throws. Schedules a refresh when what it has is stale.
     */
    get(dir: string): CheckoutFacts;

    /**
     * `get`'s size alone, for a directory that is not a checkout (a repo's package cache), measured
     * only where it really lies strictly inside `root` (`readContainedSize`); null otherwise.
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

async function readHead(dir: string): Promise<Pick<CheckoutFacts, 'branch' | 'lastCommit'>> {
    // Concurrent: two independent reads of the same checkout, and each is a process spawn.
    const [branch, log] = await Promise.all([
        run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
            .then((r) => r.stdout.trim() || null)
            .catch(() => null),
        run('git', ['-C', dir, 'log', '-1', '--format=%H%x00%cI%x00%s'])
            .then((r) => r.stdout.trim())
            .catch(() => ''),
    ]);
    const [sha, at, headline] = log.split('\0');
    return {
        branch,
        lastCommit: sha && at ? { sha, at, headline: headline ?? '' } : null,
    };
}

/** The bytes in `du -sk` output's leading kibibyte count, or null when it has none. */
function bytesOfDu(stdout: string): number | null {
    const kib = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
    return Number.isFinite(kib) ? kib * BYTES_PER_KIB : null;
}

/**
 * `du`, not a walk in this process.
 *
 * This was a `readdirSync`/`statSync` recursion, and it was a genuine mistake: an async function
 * runs synchronously up to its first `await`, so on the common path — the size is due, the head is
 * not — the whole traversal executed inline inside the request handler. A checkout with its
 * dependencies installed is hundreds of thousands of files, so that stalled the event loop for
 * every other request in the process, for seconds, per checkout, every five minutes.
 *
 * `du` does the same work in another process, where blocking is free. `-s` for a total, `-k` for
 * kibibytes (POSIX; `-b` is GNU-only and this runs on alpine). Symlinks are not followed by
 * default, which is what stops a link out of the checkout double-counting or walking the disk.
 */
async function readSize(dir: string): Promise<number | null> {
    try {
        const { stdout } = await run('du', ['-sk', dir], { timeout: SIZE_TIMEOUT_MS });
        return bytesOfDu(stdout);
    } catch {
        // Timed out, or `du` is absent. Null renders as an em dash, which is the honest answer:
        // nobody measured it. Never 0, which would claim an empty checkout.
        return null;
    }
}

/**
 * `cd -P` lands on the directory the path REALLY names, symlinks resolved; `pwd -P` reports where
 * that is, derived from the landed directory itself, so no symlink swapped in afterwards can change
 * the answer; and `du .` measures the landed directory, following nothing below it. Anything that
 * lands outside `$2` exits before `du` runs.
 */
const CONTAINED_DU = 'cd -P -- "$1" || exit 1; case "$(pwd -P)" in "$2"/*) exec du -sk . ;; esac; exit 3';

/**
 * `readSize` for a directory whose path runs through components a member's agent can write: the
 * repo's package cache under `<member>/.cache/`. The board sees every org's tree, so a symlink
 * planted there must never turn the reading into another tenant's directory size — and a
 * check-then-measure on the path would race a symlink swapped between the two.
 */
async function readContainedSize(dir: string, root: string): Promise<number | null> {
    try {
        const { stdout } = await run('sh', ['-c', CONTAINED_DU, 'sh', dir, await realpath(root)], {
            timeout: SIZE_TIMEOUT_MS,
        });
        return bytesOfDu(stdout);
    } catch {
        // Absent, outside the root, timed out: not measured.
        return null;
    }
}

export function createFactsCache(now: () => number = Date.now): FactsCache {
    const entries = new Map<string, Entry>();

    /** `root` set: a size-only reading confined to it (`sizeOf`); unset: a checkout (`get`). */
    const refresh = (dir: string, entry: Entry, root?: string): void => {
        if (entry.pending) return;
        const wantHead = root === undefined && now() - entry.headAt >= HEAD_TTL_MS;
        const wantSize = now() - entry.sizeAt >= SIZE_TTL_MS;
        if (!wantHead && !wantSize) return;

        entry.pending = (async () => {
            // Both off the request path — nothing awaits this promise — and both concurrent with
            // each other, because they are separate processes reading the same directory.
            const measure = () => (root === undefined ? readSize(dir) : readContainedSize(dir, root));
            const [head, size] = await Promise.all([wantHead ? readHead(dir) : null, wantSize ? measure() : null]);
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
        get(dir) {
            const entry = entryOf(dir);
            refresh(dir, entry);
            return entry.facts;
        },

        sizeOf(dir, root) {
            const entry = entryOf(dir);
            // A cache a run has just created must not wait out the TTL behind an absent reading.
            if (entry.absent && existsSync(dir)) entry.sizeAt = 0;
            refresh(dir, entry, root);
            return entry.facts.sizeBytes;
        },

        invalidate(dir) {
            entries.delete(dir);
        },
    };
}
