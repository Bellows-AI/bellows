import { spawn } from 'node:child_process';
import { readdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { StalePurge, UserRepoStore } from '../db/user-repo-store.js';
import type { FactsCache } from './facts.js';
import { workspaceDir } from './reconcile.js';

/**
 * The manual purge (issue #92): one member deletes ONE orphaned checkout, deliberately.
 *
 * The sequence is the issue's serialization contract, in order:
 *
 * 1. `stampPurge` — one transaction, row locked, every refusal (selected, cloning, duplicate,
 *    unfinished tasks) decided under the lock, the row stamped `purging` under a `purge_token`.
 * 2. `holdPurge` — the checkout is MOVED to its tombstone `<name>~purge-<token>` while the row is
 *    locked and still carries that token. After the move the member's path is free: a reselection
 *    clones into it, and nothing below ever names it again.
 * 3. The removal — a bounded child process, OUTSIDE any database transaction, on the tombstone
 *    only. A holder that lost its stamp (a stale recovery took it over) can still only ever reach
 *    its own tombstone, so a late `rm` cannot touch a fresh clone.
 * 4. The second transaction deletes the row (only if it is still deselected and still `purging`
 *    under this token). An error lands the row on `failed` with the reason, token-fenced too.
 *
 * The disk is the record of what is owed: before ANY path releases the row (deletes it, answers
 * `cleaned`), `removeTombstones` lists every `<name>~purge-*` of the destination and removes the
 * ones no other purging row holds, so tokens lost to a failed retry or a restamp cannot strand one.
 * An unconfirmed listing or token read releases nothing; the row lands `failed` for a later retry.
 *
 * Recovery (`recoverInterrupted`, at boot and on an interval) claims only stamps older than
 * `PURGE_STALE_MS`, restamping them in the same statement, then runs the same move-and-remove under
 * its own token. Staleness no longer has to prove the old child exited: removal only ever targets
 * tombstones, never the member's path.
 */

/**
 * How long the removal child may run before it is killed and reaped.
 *
 * The facts cache bounds its `du` at 20s, but a read is not a delete: a checkout with its
 * dependencies installed is hundreds of thousands of files, and unlinking is slower than sizing,
 * especially on a cold network volume. Generous on purpose — the member is watching a spinner,
 * and a false timeout would leave a half-deleted tree and a failed row for a retry to finish.
 */
export const PURGE_TIMEOUT_MS = 60_000;

/**
 * How old a stamp must be before another process may take it over: twice the longest a removal may
 * run, so a live holder's stamp is never stale while its `rm` is still inside its own bound.
 */
export const PURGE_STALE_MS = 2 * PURGE_TIMEOUT_MS;

/** How often a running board looks for stale stamps once it has booted. */
export const PURGE_RECOVERY_INTERVAL_MS = 60_000;

/** Captured so a failing child's own words can travel on the row. */
const STDERR_KEEP = 2000;
const MS_PER_SECOND = 1000;

/**
 * `rm -rf` in a bounded child process, argv-array (never a shell string), observing the child's
 * EXIT — not spawning it and walking away. A timeout kills with SIGKILL and then waits for the
 * exit event, so no caller can release a stamp while the child still runs.
 */
export function removeTree(
    dir: string,
    timeoutMs: number = PURGE_TIMEOUT_MS,
    spawnImpl: typeof spawn = spawn
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawnImpl('rm', ['-rf', '--', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-STDERR_KEEP);
        });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) return resolve();
            const detail = stderr.trim();
            if (timedOut) {
                return reject(new Error(`purge of ${dir} timed out after ${Math.round(timeoutMs / MS_PER_SECOND)}s`));
            }
            reject(new Error(detail || `rm -rf exited with code ${code ?? signal}`));
        });
    });
}

/** What a purge decided. The refusals are the store's, untouched; the results drive the status codes. */
export type PurgeOutcome =
    | 'missing'
    | { refused: 'selected' }
    | { refused: 'cloning' }
    | { refused: 'purging' }
    | { refused: 'tasks'; count: number }
    /** 202: the row is stamped and the removal child is running. */
    | { result: 'started' }
    /** 204: nothing to remove — the row was stale, and it is gone now. */
    | { result: 'cleaned' };

export interface Purger {
    purge(userId: string, repo: { owner: string; name: string }): Promise<PurgeOutcome>;
    /** Finishes every `purging` row whose stamp went stale. Runs at boot, before the routes serve, and on `start`'s interval. */
    recoverInterrupted(): Promise<void>;
    /** Runs `recoverInterrupted` every `intervalMs` until `stop`; coalesced, and never holds the process open. */
    start(intervalMs: number): void;
    stop(): void;
    /** Awaits every in-flight finish. The tests use it instead of waiting on a real child. */
    settle(): Promise<void>;
}

const firstLine = (error: unknown): string => (error as Error).message.split('\n')[0] ?? 'purge failed';

/** The directory a purge's removal is confined to. Never a path a member's clone can be at. */
const tombOf = (dest: string, token: string): string => `${dest}~purge-${token}`;

type RepoRef = { owner: string; name: string };

/** Which stamp a failure is recorded against: the holder's own row and token. */
interface Stamp {
    readonly userId: string;
    readonly repo: RepoRef;
    readonly token: string;
}

interface PurgeContext {
    readonly store: UserRepoStore;
    readonly facts: FactsCache;
    readonly log: (message: string) => void;
    readonly remove: (dir: string) => Promise<void>;
    readonly rename: typeof renameSync;
    /** The entry names of a directory; throws on any failure, absence included. */
    readonly list: (dir: string) => string[];
    /** The path is built from the authenticated caller and the stored row, never from a client-supplied segment. */
    readonly dirOf: (userId: string, name: string) => string;
}

/** Moves the checkout to its tombstone. Absence is a fact; any other failure throws. */
function moveAside(rename: typeof renameSync, dir: string, tomb: string): 'moved' | 'absent' {
    try {
        rename(dir, tomb);
        return 'moved';
    } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'absent';
        throw error;
    }
}

/**
 * Records a failure against this holder's own stamp. Best-effort for exactly the reason it exists:
 * if the database just failed, this write fails too, and letting it throw would reject a chain
 * nobody handles. The row stays `purging` and a stale recovery finishes it.
 */
async function recordFailure(ctx: PurgeContext, stamp: Stamp, message: string) {
    const { userId, repo, token } = stamp;
    try {
        if (!(await ctx.store.markPurgeFailed(userId, repo, token, message))) {
            ctx.log(`purge of ${repo.name}: the stamp is no longer ours; failure not recorded`);
        }
    } catch (e) {
        ctx.log(`purge of ${repo.name}: could not record the failure: ${(e as Error).message}`);
    }
}

/**
 * Removes every tombstone of `dir` that no OTHER purging row holds — this holder's own included
 * when it exists. The listing comes before the token read, so a tombstone created in
 * between is never in it. Absence of the parent is an empty listing; any other failure throws, and
 * the caller keeps the row.
 */
async function removeTombstones(ctx: PurgeContext, dir: string, ownToken: string) {
    let names: string[];
    try {
        names = ctx.list(dirname(dir));
    } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        names = [];
    }
    const prefix = `${basename(dir)}~purge-`;
    const listed = names.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
    const held = new Set(await ctx.store.heldTokens());
    held.delete(ownToken);
    for (const token of listed) {
        if (!held.has(token)) await ctx.remove(tombOf(dir, token));
    }
}

/** Runs after the move: removes the tombstone(s), then — and only then — releases the stamp by deleting the row. */
async function finishPurge(ctx: PurgeContext, { userId, repo, token }: Stamp) {
    const dir = ctx.dirOf(userId, repo.name);
    try {
        await removeTombstones(ctx, dir, token);
        if (!(await ctx.store.deletePurged(userId, repo, token))) {
            // A selection committed behind the stamp, or a recoverer took it over: the row is
            // not ours to delete. Say so rather than swallow it.
            ctx.log(`purge of ${repo.name}: the row moved behind the deletion; the checkout will re-clone`);
        }
    } catch (error) {
        const message = firstLine(error);
        ctx.log(`purge of ${repo.name} failed: ${message}`);
        await recordFailure(ctx, { userId, repo, token }, message);
    } finally {
        // Whatever happened, the tree at this path is gone or about to be re-cloned: the old
        // measurements must not answer for it.
        ctx.facts.invalidate(dir);
    }
}

/** The purge's move under the row lock, folded into what the caller answers; 'moved' means a removal is still owed. */
async function moveForPurge(
    ctx: PurgeContext,
    { userId, repo, token }: Stamp
): Promise<'moved' | { result: 'started' | 'cleaned' }> {
    const dir = ctx.dirOf(userId, repo.name);
    let moved: 'moved' | 'absent' | null;
    try {
        moved = await ctx.store.holdPurge(userId, repo, token, () => moveAside(ctx.rename, dir, tombOf(dir, token)));
    } catch (error) {
        // The move failed (or the lock could not be confirmed): the checkout stays where it is,
        // and the row lands on `failed` for a retry.
        const message = firstLine(error);
        ctx.log(`purge of ${repo.name} failed: ${message}`);
        await recordFailure(ctx, { userId, repo, token }, message);
        return { result: 'started' };
    }
    if (moved === null) {
        ctx.log(`purge of ${repo.name}: the claim was taken before the move; leaving the checkout alone`);
        return { result: 'started' };
    }
    if (moved === 'absent') {
        // A missing directory is a successful cleanup of a stale row — the member asked for the
        // disk back, and there is no disk to take back — except tombstones a failed earlier purge left.
        try {
            await removeTombstones(ctx, dir, token);
        } catch (error) {
            const message = firstLine(error);
            ctx.log(`purge of ${repo.name} failed: ${message}`);
            await recordFailure(ctx, { userId, repo, token }, message);
            return { result: 'started' };
        }
        if (!(await ctx.store.deletePurged(userId, repo, token))) {
            ctx.log(`purge of ${repo.name}: the row moved behind the stamp; leaving it alone`);
        }
        return { result: 'cleaned' };
    }
    return 'moved';
}

/** Finishes one claimed stale stamp: move, remove every tombstone of the destination, then delete the row. */
async function recoverOne(ctx: PurgeContext, row: StalePurge) {
    const dir = ctx.dirOf(row.userId, row.name);
    try {
        const moved = await ctx.store.holdPurge(row.userId, row, row.token, () =>
            moveAside(ctx.rename, dir, tombOf(dir, row.token))
        );
        if (moved === null) {
            ctx.log(`purge of ${row.name}: the claim was taken before recovery moved it`);
            return;
        }
        // A lost holder's tombstone is garbage; its own rm may be running on it still, which is
        // harmless.
        await removeTombstones(ctx, dir, row.token);
        if (await ctx.store.deletePurged(row.userId, row, row.token)) {
            ctx.log(`finished interrupted purge of ${row.userId}/${row.name}`);
        } else {
            ctx.log(`purge of ${row.name}: the row moved behind the recovery; the checkout will re-clone`);
        }
    } catch (error) {
        const message = firstLine(error);
        ctx.log(`purge of ${row.name} failed: ${message}`);
        await recordFailure(ctx, { userId: row.userId, repo: row, token: row.token }, message);
    } finally {
        // Every exit path invalidates, as in finishPurge.
        ctx.facts.invalidate(dir);
    }
}

export function createPurger(deps: {
    store: UserRepoStore;
    root: string;
    orgId: string;
    facts: FactsCache;
    log?: (message: string) => void;
    /** Test seam over removeTree, so faults can be injected without a real child. */
    remove?: (dir: string) => Promise<void>;
    /** Test seam over the rename that moves a checkout aside. */
    rename?: typeof renameSync;
    /** Test seam over the directory listing that finds the tombstones. */
    list?: (dir: string) => string[];
}): Purger {
    const {
        store,
        root,
        orgId,
        facts,
        log = () => {},
        remove = (dir) => removeTree(dir),
        rename = renameSync,
        list = (dir) => readdirSync(dir),
    } = deps;
    // The sibling `.worktrees/` directory is one level up and never traversed: only this exact
    // path (and its tombstone) is handed to rm.
    const ctx: PurgeContext = {
        store,
        facts,
        log,
        remove,
        rename,
        list,
        dirOf: (userId, name) => join(workspaceDir(root, orgId, userId), name),
    };
    const inFlight = new Set<Promise<void>>();
    let timer: NodeJS.Timeout | null = null;
    let recovering = false;

    const recoverInterrupted = async () => {
        let stale: StalePurge[];
        try {
            stale = await store.claimStalePurges(PURGE_STALE_MS);
        } catch (error) {
            // Inconclusive: nothing is recovered this pass, and the next one asks again.
            log(`could not look for stale purges: ${(error as Error).message}`);
            return;
        }
        for (const row of stale) await recoverOne(ctx, row);
    };

    return {
        async purge(userId, repo) {
            const stamped = await store.stampPurge(userId, repo);
            if (stamped === 'missing') return 'missing';
            if ('refused' in stamped) return stamped;

            const moved = await moveForPurge(ctx, { userId, repo, token: stamped.token });
            if (moved !== 'moved') {
                facts.invalidate(ctx.dirOf(userId, repo.name));
                return moved;
            }
            // Started, not awaited — the route answers 202 and the SPA polls the row through
            // `purging` to `failed` or disappearance. Tracked so `settle()` can await it. The
            // `.catch` on the DERIVED chain is the last line of defense: finishPurge handles its
            // own errors, but a bug in this module must surface as a log line, never as an
            // unhandled rejection — Node's default for one of those is to terminate the process.
            const finish = finishPurge(ctx, { userId, repo, token: stamped.token });
            inFlight.add(finish);
            void finish
                .finally(() => inFlight.delete(finish))
                .catch((e: Error) => log(`purge of ${repo.name} finished unrecorded: ${e.message}`));
            return { result: 'started' };
        },

        recoverInterrupted,

        start(intervalMs) {
            if (timer) return;
            timer = setInterval(() => {
                if (recovering) return;
                recovering = true;
                void recoverInterrupted()
                    .catch((e: Error) => log(`purge recovery failed: ${e.message}`))
                    .finally(() => {
                        recovering = false;
                    });
            }, intervalMs);
            timer.unref?.();
        },

        stop() {
            if (timer) clearInterval(timer);
            timer = null;
        },

        async settle() {
            await Promise.all([...inFlight]);
        },
    };
}
