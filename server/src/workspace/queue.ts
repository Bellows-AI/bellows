import { type Dirent, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CLONE_LEASE_MS, type PendingClone, type UserRepoStore } from '../db/user-repo-store.js';
import type { TokenProvider } from '../github/token.js';
import { cloneRepo, type CloneOptions, workspaceDir } from './reconcile.js';

type QueueLog = (message: string) => void;

/**
 * Clones the repositories members have selected, in the background, a couple at a time.
 *
 * Driven off `user_repo` rows rather than off a promise queue held in the route. The row has to
 * exist regardless — it is what the SPA polls for a clone's progress — so driving off it is
 * strictly less machinery than a queue that would also have to be reconciled against it. It also
 * survives a restart, which an in-memory queue does not.
 */

/**
 * How many clones run at once.
 *
 * Low, because each one is minutes of network and unbounded disk, and because a burst of them
 * against one origin is exactly the shape of a request nobody thanks you for. Raising it does not
 * make any single clone finish sooner.
 */
export const DEFAULT_CLONE_CONCURRENCY = 2;

/** How often the queue looks for work when it found none last time. */
const IDLE_POLL_MS = 5_000;

/** How often a running clone renews its lease: three chances inside one lease. */
const HEARTBEATS_PER_LEASE = 3;
const HEARTBEAT_MS = CLONE_LEASE_MS / HEARTBEATS_PER_LEASE;

export interface CloneQueue {
    /** Sweeps orphaned staging directories and tombstones, then starts polling; each pass recovers expired leases. */
    start(): Promise<void>;
    stop(): void;
    /** Runs one pass immediately. The route calls this after a selection so it starts at once. */
    kick(): void;
}

export interface CloneQueueDeps {
    readonly store: UserRepoStore;
    readonly root: string;
    readonly orgId: string;
    /** Absent under the code-only `none` arm (the offline tooling), where only public repositories can clone. */
    readonly tokens?: TokenProvider | undefined;
    readonly concurrency?: number;
    readonly log?: (message: string) => void;
    /** Test seams, passed straight through to cloneRepo. */
    readonly cloneUrl?: CloneOptions['cloneUrl'];
    readonly run?: CloneOptions['run'];
    /** Lease length and renewal cadence; the suite shortens the cadence instead of waiting out a timer. */
    readonly leaseMs?: number;
    readonly heartbeatMs?: number;
    /** Called after each pass. The suite uses it instead of waiting on a timer. */
    readonly onIdle?: () => void;
}

const UUID_TAIL = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `<name>~tmp-<claim token>` or `<name>~purge-<token>`: `~` is in no repo name, so no checkout can match, and the token says whose it is. */
const OWNED_ENTRY = new RegExp(`~(?:tmp|purge)-(${UUID_TAIL})$`, 'i');

const isAbsence = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/** The names in `dir`, or [] — an absent directory is nothing to sweep, any other error is said and skipped. */
function listDir(dir: string, log: (message: string) => void): Dirent[] {
    try {
        return readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        if (!isAbsence(error)) log(`sweep skipped ${dir}: ${(error as Error).message}`);
        return [];
    }
}

interface OwnedEntry {
    readonly path: string;
    readonly entry: string;
    readonly token: string;
}

/** Every staging dir and tombstone under the org's member dirs, listed BEFORE any token is read. */
function listOwnedEntries(orgDir: string, log: QueueLog): OwnedEntry[] {
    const found: OwnedEntry[] = [];
    for (const user of listDir(orgDir, log)) {
        if (!user.isDirectory()) continue;
        for (const entry of listDir(join(orgDir, user.name), log)) {
            const token = OWNED_ENTRY.exec(entry.name)?.[1]?.toLowerCase();
            if (token === undefined) continue;
            found.push({ path: join(orgDir, user.name, entry.name), entry: `${user.name}/${entry.name}`, token });
        }
    }
    return found;
}

/** The held tokens, or null when the read is not confirmed: a failed or malformed answer licenses no removal. */
async function confirmedTokens(store: Pick<UserRepoStore, 'heldTokens'>, log: QueueLog): Promise<Set<string> | null> {
    try {
        const tokens = await store.heldTokens();
        if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== 'string')) {
            throw new Error('malformed token list');
        }
        return new Set(tokens.map((token) => token.toLowerCase()));
    } catch (error) {
        log(`sweep skipped, held tokens unconfirmed: ${(error as Error).message}`);
        return null;
    }
}

/**
 * Removes `<name>~tmp-<token>` staging trees and `<name>~purge-<token>` tombstones that no row holds.
 *
 * The rename into place is atomic, so a `~tmp-` directory is never a finished clone and a `~purge-`
 * directory is never anything anybody wants; but one whose token a row still holds belongs to a live
 * clone or purge, possibly another process's. The entries are LISTED first and the held tokens read
 * after, so a directory created in between is never in the list. An unconfirmed token read sweeps
 * nothing.
 */
export async function sweepStaging(
    root: string,
    orgId: string,
    store: Pick<UserRepoStore, 'heldTokens'>,
    log: QueueLog
): Promise<number> {
    const found = listOwnedEntries(join(root, orgId), log);
    if (!found.length) return 0;

    const held = await confirmedTokens(store, log);
    if (held === null) return 0;

    let removed = 0;
    for (const { path, entry, token } of found) {
        if (held.has(token)) continue;
        rmSync(path, { recursive: true, force: true });
        removed += 1;
        log(`swept ${entry}`);
    }
    return removed;
}

/** The claims this process is cloning under, renewed while any are in flight. */
function createHeartbeat(store: UserRepoStore, log: QueueLog, leaseMs: number, everyMs: number) {
    const live = new Map<string, PendingClone>();
    let timer: NodeJS.Timeout | null = null;

    const stop = () => {
        if (timer) clearInterval(timer);
        timer = null;
    };

    const renew = async () => {
        if (!live.size) return;
        const tokens = [...live.keys()];
        try {
            const held = new Set(await store.renewLeases(tokens, leaseMs));
            // The fence, not this answer, decides the outcome: a lost claim is only said out loud here.
            for (const token of tokens) {
                const job = live.get(token);
                if (job && !held.has(token)) log(`${job.userId} lease lost for ${job.owner}/${job.name}`);
            }
        } catch (error) {
            // Inconclusive, never a verdict: the clone carries on and the next beat tries again.
            log(`could not renew clone leases: ${(error as Error).message}`);
        }
    };

    return {
        add(job: PendingClone) {
            live.set(job.claimToken, job);
            timer ??= setInterval(() => void renew(), everyMs);
            timer.unref?.();
        },
        remove(job: PendingClone) {
            live.delete(job.claimToken);
            if (!live.size) stop();
        },
        stop,
    };
}

/** Returns rows whose lease ran out to `queued` and removes the staging their lost holder left. */
async function recoverExpired(store: UserRepoStore, root: string, orgId: string, log: QueueLog): Promise<void> {
    try {
        for (const lost of await store.requeueExpired()) {
            log(`requeued ${lost.userId}/${lost.name}: its lease ran out`);
            rmSync(join(workspaceDir(root, orgId, lost.userId), `${lost.name}~tmp-${lost.staleToken}`), {
                recursive: true,
                force: true,
            });
        }
    } catch (error) {
        log(`could not recover expired clones: ${(error as Error).message}`);
    }
}

interface CloneJobContext extends Pick<CloneQueueDeps, 'store' | 'root' | 'orgId' | 'tokens' | 'cloneUrl' | 'run'> {
    readonly log: QueueLog;
}

/** One claimed clone, end to end. Its outcome is recorded against the row, never thrown. */
async function cloneClaimed(job: PendingClone, ctx: CloneJobContext): Promise<void> {
    const { store, root, orgId, tokens, cloneUrl, run, log } = ctx;
    try {
        // A fresh token per repo. An installation token lasts an hour and a batch of
        // clones can outlive one, so taking it once for the batch would fail the tail.
        // The provider caches, so this is usually free.
        const token = tokens ? await tokens.get() : undefined;
        let published = false;
        const outcome = await cloneRepo({
            root,
            orgId,
            userId: job.userId,
            repo: { owner: job.owner, name: job.name },
            token,
            claimToken: job.claimToken,
            // The rename runs inside markReady, under the row's lock and only while this
            // claim still holds it.
            publish: async (move) => {
                published = await store.markReady(job, move);
                return published;
            },
            log: (m) => log(`${job.userId} ${m}`),
            cloneUrl,
            run,
        });
        // A checkout that was already there never reached the publish: record it ready.
        if (outcome === 'present' && !published && !(await store.markReady(job))) {
            log(`${job.userId} lease lost for ${job.owner}/${job.name}; not recorded ready`);
        }
    } catch (error) {
        // Recorded against the row rather than thrown. One member's broken repository
        // must not stop everyone else's clones, and the page shows this sentence.
        const message = (error as Error).message.split('\n')[0] ?? 'clone failed';
        log(`failed ${job.owner}/${job.name}: ${message}`);
        // A failing markFailed leaves the row `cloning` until its lease runs out and a pass
        // requeues it, so it is said out loud rather than swallowed: the page shows a
        // clone that never finishes and nothing else would explain why.
        await store
            .markFailed(job, message)
            .then((recorded) => {
                if (!recorded) log(`${job.userId} lease lost for ${job.owner}/${job.name}, failure not recorded`);
            })
            .catch((e: Error) => log(`${job.userId} could not record the failure: ${e.message}`));
    }
}

export function createCloneQueue(deps: CloneQueueDeps): CloneQueue {
    const {
        store,
        root,
        orgId,
        concurrency = DEFAULT_CLONE_CONCURRENCY,
        log = () => {},
        onIdle,
        leaseMs = CLONE_LEASE_MS,
        heartbeatMs = HEARTBEAT_MS,
    } = deps;

    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let inFlight = 0;
    let passing: Promise<void> | null = null;
    const heartbeat = createHeartbeat(store, log, leaseMs, heartbeatMs);

    const pass = async (): Promise<void> => {
        if (stopped) return;
        await recoverExpired(store, root, orgId, log);
        const room = concurrency - inFlight;
        if (room <= 0) return;

        const claimed = await store.claimPending(room, leaseMs);
        if (!claimed.length) return;

        /*
         * Started, not awaited as a batch.
         *
         * `await Promise.all(...)` here made concurrency effectively one: a pass could not finish
         * until its slowest clone did, and passes are serialised — so one fifteen-minute clone of a
         * large monorepo idled the other slot and held up every other member's queued repository
         * behind it. Each clone now frees its own slot and immediately re-runs a pass to refill it,
         * which is the pipeline the concurrency setting is supposed to describe.
         */
        for (const job of claimed) {
            inFlight += 1;
            heartbeat.add(job);
            void cloneClaimed(job, { ...deps, log })
                .catch((e: Error) => log(`clone of ${job.owner}/${job.name} ended unrecorded: ${e.message}`))
                .finally(() => {
                    inFlight -= 1;
                    heartbeat.remove(job);
                    // Refill the slot this clone just freed, rather than waiting out the poll.
                    if (!stopped) void runPass();
                    else settle();
                });
        }
    };

    /**
     * Announces that there is nothing left to do — no pass running and no clone in flight.
     *
     * Only the tests listen. It has to account for `inFlight` as well as the pass, because a pass
     * now returns as soon as it has *started* its clones rather than when they finish.
     */
    const settle = () => {
        if (passing === null && inFlight === 0) onIdle?.();
    };

    /**
     * Coalesced rather than queued: a `kick()` arriving during a pass joins that pass instead of
     * starting a second one. A selection saved after this pass has already claimed its rows
     * therefore waits for the next tick — acceptable, because a clone that just finished re-runs a
     * pass from its `finally` anyway.
     */
    const runPass = (): Promise<void> => {
        passing ??= pass()
            .catch((error: Error) => log(`pass failed: ${error.message}`))
            .finally(() => {
                passing = null;
                settle();
            });
        return passing;
    };

    const loop = () => {
        if (stopped) return;
        void runPass().finally(() => {
            if (stopped) return;
            timer = setTimeout(loop, IDLE_POLL_MS);
            // Nothing here should hold the process open.
            timer.unref?.();
        });
    };

    return {
        async start() {
            /*
             * Only orphans are swept here. A `cloning` row is never requeued at boot: another
             * process may hold it, so a pass recovers rows whose lease ran out instead.
             */
            try {
                const swept = await sweepStaging(root, orgId, store, log);
                if (swept) log(`swept ${swept} orphaned staging director${swept === 1 ? 'y' : 'ies'}`);
            } catch (error) {
                log(`staging sweep failed: ${(error as Error).message}`);
            }

            loop();
        },

        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
            heartbeat.stop();
        },

        kick() {
            if (stopped) return;
            void runPass();
        },
    };
}
