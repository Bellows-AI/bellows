import { LEASE_BATCH_MAX, type Board, type BoardLease, type BoardThreadFacts, UUID_SHAPE } from './board.js';
import { secondsSince } from './prometheus.js';

/** What the reaper reports about each sweep (issue #831). */
export interface ReaperObserver {
    sweep(outcome: 'ok' | 'aborted' | 'error', seconds: number): void;
    scanned(what: 'groups' | 'objects' | 'volume_threads', count: number): void;
}

/**
 * The orphan reaper (issue #301): the periodic watcher that reaps service objects whose owning
 * job can no longer use them. This file is the executor-neutral core — the decision table and
 * the sweep timer. The platform arms it drives are `k8s-reaper.ts` (Jobs, the attempt-scoped env
 * Secrets, the checkout claim) and `docker-reaper.ts` (service containers and the task group's
 * containers and volumes); the driver entrypoint picks one and starts the timer.
 *
 * The fence stays the one job-scoped actor at claim time; the reaper only ever acts on what the
 * BOARD says is dead, and never on the live attempt's own objects — so the two can share a job
 * id without racing.
 */

/** One reappable object, named the way its platform's delete call names it. */
export interface OrphanObject {
    kind: 'job' | 'container' | 'volume';
    name: string;
    /**
     * A runner that finished after its driver died (issue #792): the next claim's to adopt, so a
     * `superseded` verdict spares its whole group — only a `gone` job's is reaped.
     */
    unread?: true;
    /**
     * A runner of the attempt, running or finished (issue #821): a scan is a snapshot, and one listed
     * running may finish before its reap, so a live job's runner group is its next claim's fence's to
     * adopt or sweep — a `superseded` verdict spares the whole group, only a `gone` job's is reaped.
     */
    runner?: true;
    /** The uid the scan listed it under: its delete names that incarnation only, never one created since. */
    uid?: string;
    /** Kubernetes: the checkout holder a listed reclaim group serves (`HOLDER_LABEL`). */
    holder?: string;
}

/**
 * Every service object of one (job, attempt) pair, found by label. `createdAtMs` is the OLDEST
 * object in the group — the grace window is measured from the moment the fleet began to exist,
 * never from when the reaper first saw it.
 */
export interface OrphanGroup {
    jobId: string;
    leaseToken: string | null;
    createdAtMs: number;
    objects: OrphanObject[];
}

/**
 * Why a group was condemned:
 * - `gone`       the job is terminal, or the board has never heard of it — nothing can ever use
 *                these objects again.
 * - `superseded` the job is alive under a different (or no) lease — these objects belong to a
 *                dead attempt, and the live attempt's fence has either swept them already or
 *                needs no help; attempt-scoped deletes cannot reach the live attempt's objects.
 */
export type ReapVerdict = 'gone' | 'superseded';

/**
 * One platform's half of the reaper. `scan` enumerates and groups; `reap` deletes one group and
 * answers a line per object actually removed, for the log. Both fail SOFT — a scan that cannot
 * read answers nothing, and a reap that cannot delete is the next round's problem, because the
 * whole loop is periodic and idempotent.
 */
export interface ReaperArm {
    /**
     * Every orphan-candidate group of the platform; null when the listing proved nothing — a refused call
     * or a row it could not read — which the sweep reports as aborted and acts on none of.
     */
    scan(): Promise<OrphanGroup[] | null>;
    /**
     * What it removed, or — when a read the cleanup depended on proved nothing — what it removed and why the
     * cleanup is unconfirmed (the sweep then reports aborted, never ok).
     */
    reap(group: OrphanGroup, verdict: ReapVerdict): Promise<readonly string[] | ReapInconclusive>;
    /**
     * Every task volume of the platform (issue #775), all generations, grouped by thread root; null when
     * the listing proved nothing — a refused call or a row it could not read — and the round deletes none.
     */
    scanVolumes?(): Promise<VolumeListing | null>;
    /** Deletes every generation of one thread, answering a line per volume actually removed. */
    reapVolumes?(thread: VolumeThread): Promise<readonly string[]>;
}

/** A reap that could not confirm its cleanup: what it did remove, and the read that proved nothing. */
export interface ReapInconclusive {
    removed: readonly string[];
    inconclusive: string;
}

/** One thread's task volumes, named the way their platform's delete call names them. */
export interface VolumeThread {
    /** The thread's root job id: what the board is asked about. */
    root: string;
    /** `createdAtMs`: the platform's creation time; null or absent when it could not be read, which keeps the volume. */
    volumes: { name: string; uid?: string; createdAtMs?: number | null | undefined }[];
}

/** The task volume listing: the threads it proved, and a line per labelled object skipped as no thread's (logged by the sweep). */
export interface VolumeListing {
    threads: VolumeThread[];
    skipped: readonly string[];
}

/** How long a task volume outlives its thread's last finalize: `ttlMs` when it is whole, `boundMs` when it is not. */
export interface VolumePolicy {
    ttlMs: number;
    boundMs: number;
}

/**
 * The statuses a job can never come back from — the objects its attempts created are orphans.
 * Exported because the reclaim loop's orphaned-claim decision (issue #344) must read the SAME
 * vocabulary the reaper decides with, not a restated list that can drift.
 */
export const TERMINAL_JOB_STATUSES: readonly string[] = ['succeeded', 'failed', 'dead', 'stopped'];

/**
 * The decision table, pure — the unit-test surface for the whole feature. `lease` is the board's
 * answer FOR THIS GROUP's job id, `undefined` when the board does not know the job. The board
 * state alone decides; the grace window only DEFERS an action already decided, never decides
 * one — which is why the fence's rejection of age-as-classification is preserved here too.
 */
export function reapDecision(
    lease: BoardLease | undefined,
    group: Pick<OrphanGroup, 'leaseToken' | 'createdAtMs'>,
    nowMs: number,
    graceMs: number
): ReapVerdict | null {
    let verdict: ReapVerdict | null;
    if (lease === undefined) {
        verdict = 'gone';
    } else if (TERMINAL_JOB_STATUSES.includes(lease.status)) {
        verdict = 'gone';
    } else if (lease.leaseToken !== null && lease.leaseToken === group.leaseToken) {
        // The live attempt's own objects: its teardown, and its fence, own them.
        verdict = null;
    } else {
        // Live job under another lease, or holding none at all — every labelled object is a
        // dead attempt's.
        verdict = 'superseded';
    }
    if (verdict === null) return null;
    if (nowMs - group.createdAtMs < graceMs) return null;
    return verdict;
}

/**
 * Whether a thread's task volumes may go (issue #775), pure. Deleted only when no job of the thread is
 * live and its last attempt finalized, and then only once idle for the ttl when everything it left is
 * whole — its artifacts all terminal and a complete checkpoint of that attempt — or for the (longer)
 * bound when it is not: a truncated checkpoint or a pending artifact keeps the tree up to the bound,
 * never forever. Anything unknown — no facts, no date, a date in the future — keeps it.
 */
export function volumeDecision(
    facts: BoardThreadFacts | undefined,
    nowMs: number,
    policy: VolumePolicy
): 'delete' | 'keep' {
    if (facts === undefined || facts.live || facts.lastFinalizedAt === null) return 'keep';
    const idleMs = nowMs - Date.parse(facts.lastFinalizedAt);
    if (Number.isNaN(idleMs) || idleMs < 0) return 'keep';
    const whole = facts.artifactsComplete && facts.checkpoint === 'complete';
    return idleMs >= (whole ? policy.ttlMs : Math.max(policy.ttlMs, policy.boundMs)) ? 'delete' : 'keep';
}

/**
 * Whether a thread's task volumes may go, given the board's lease row for its root (issue #775), pure.
 * A row answers by its thread facts. NO row — the root absent from a fully confirmed answer, which is
 * how `removeTask` leaves a thread — can never finalize again, so its volumes go once every one is at
 * least the ttl old; a creation time that could not be read keeps them.
 */
export function volumeVerdict(
    row: BoardLease | undefined,
    volumes: VolumeThread['volumes'],
    nowMs: number,
    policy: VolumePolicy
): 'delete' | 'keep' {
    if (row !== undefined) return volumeDecision(row.thread, nowMs, policy);
    const old = volumes.every(
        (volume) => typeof volume.createdAtMs === 'number' && nowMs - volume.createdAtMs >= policy.ttlMs
    );
    return old ? 'delete' : 'keep';
}

/**
 * Asks the board about every id, in LEASE_BATCH_MAX-sized chunks. Null — ANY chunk refused —
 * aborts the whole round: absence must be proven for every id before anything is condemned.
 */
const lookupAll = async (
    board: Pick<Board, 'leases'>,
    ids: readonly string[],
    log: (message: string) => void,
    { withThreads = false, consequence = 'reaping nothing this round' } = {}
): Promise<Map<string, BoardLease> | null> => {
    const leases = new Map<string, BoardLease>();
    for (let i = 0; i < ids.length; i += LEASE_BATCH_MAX) {
        const answer = await board.leases(ids.slice(i, i + LEASE_BATCH_MAX), withThreads);
        if (answer === null) {
            log(`reaper: the board could not answer a lease lookup — ${consequence}`);
            return null;
        }
        for (const row of answer) leases.set(row.id, row);
    }
    return leases;
};

/** Decides one group and reaps it, logging a line per object actually removed. */
const reapOne = async (
    arm: ReaperArm,
    group: OrphanGroup,
    ctx: {
        lease: BoardLease | undefined;
        graceMs: number;
        nowMs: number;
        log: (message: string) => void;
        onUnproven: () => void;
    }
): Promise<void> => {
    const verdict = reapDecision(ctx.lease, group, ctx.nowMs, ctx.graceMs);
    if (verdict === null) return;
    // A live job's next claim adopts it (issue #792), or its fence sweeps it: never deleted from a scan.
    if (verdict === 'superseded' && group.objects.some((object) => object.unread || object.runner)) return;
    const result = await arm.reap(group, verdict);
    if (!Array.isArray(result)) {
        ctx.onUnproven();
        ctx.log(`reaper: job ${group.jobId} — cleanup unconfirmed: ${(result as ReapInconclusive).inconclusive}`);
    }
    for (const removed of Array.isArray(result) ? result : (result as ReapInconclusive).removed) {
        ctx.log(`reaper: job ${group.jobId} lease ${group.leaseToken ?? 'none'} (${verdict}) — removed ${removed}`);
    }
};

/**
 * The sweep loop. One round: scan → ask the board in batches → decide → reap → log. Failures are
 * logged, never thrown: this runs out of a timer, and a refused delete is the next round's
 * problem.
 */
export function createReaper(deps: {
    board: Pick<Board, 'leases'>;
    arm: ReaperArm;
    intervalMs: number;
    graceMs: number;
    log?: (message: string) => void;
    now?: () => number;
    /** Sweeps task volumes (issue #775) when set and the arm lists them. */
    volumePolicy?: VolumePolicy;
    /** Reports each sweep (issue #831): its outcome and duration, and what it scanned. */
    observe?: ReaperObserver;
}): {
    sweep(): Promise<void>;
    start(): void;
    stop(): void;
} {
    const log = deps.log ?? ((message: string) => console.log(`[driver] ${message}`));
    const now = deps.now ?? (() => Date.now());
    let sweeping = false;
    // Set when a lookup, listing or re-read the sweep depended on was not proven: the round then
    // reaped less than it could, and the series says so rather than reporting ok.
    let unproven = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    /** The orphan groups: scan → ask the board in batches → decide → reap. */
    const sweepGroups = async (): Promise<void> => {
        const groups = await deps.arm.scan();
        if (groups === null) {
            unproven = true;
            log('reaper: the groups could not be listed — reaping nothing this round');
            return;
        }
        deps.observe?.scanned('groups', groups.length);
        deps.observe?.scanned(
            'objects',
            groups.reduce((n, group) => n + group.objects.length, 0)
        );
        // A labelled object whose factory.job is not a uuid can never be a board job — a
        // foreign object, another tool's pod, a manual leftover. Asking the board about it
        // would 400 the WHOLE batch and disable the reaper for as long as the object lives,
        // so it is skipped at the source instead.
        const reapable: OrphanGroup[] = [];
        for (const group of groups) {
            if (UUID_SHAPE.test(group.jobId)) reapable.push(group);
            else log(`reaper: skipping a group whose factory.job label is not a uuid: ${group.jobId}`);
        }
        const ids = [...new Set(reapable.map((group) => group.jobId))];
        const leases = await lookupAll(deps.board, ids, log);
        if (leases === null) {
            unproven = true;
            return;
        }
        for (const group of reapable) {
            await reapOne(deps.arm, group, {
                lease: leases.get(group.jobId),
                graceMs: deps.graceMs,
                nowMs: now(),
                log,
                onUnproven: () => {
                    unproven = true;
                },
            });
        }
    };

    /** The listed task volume threads that name a board job, the rest logged and skipped. */
    const threadsOfVolumes = (listed: VolumeListing): VolumeThread[] => {
        for (const line of listed.skipped) log(`reaper: skipping ${line}`);
        const threads: VolumeThread[] = [];
        for (const thread of listed.threads) {
            if (UUID_SHAPE.test(thread.root)) threads.push(thread);
            else log(`reaper: skipping task volumes whose root label is not a uuid: ${thread.root}`);
        }
        return threads;
    };

    /** The task volumes: list → ask the board about each root → decide → delete every generation of the deletable. */
    const sweepVolumes = async (): Promise<void> => {
        const { arm, volumePolicy } = deps;
        if (volumePolicy === undefined || !arm.scanVolumes || !arm.reapVolumes) return;
        const listed = await arm.scanVolumes();
        if (listed === null) {
            unproven = true;
            log('reaper: the task volumes could not be listed — deleting none this round');
            return;
        }
        const threads = threadsOfVolumes(listed);
        deps.observe?.scanned('volume_threads', threads.length);
        const leases = await lookupAll(deps.board, [...new Set(threads.map((thread) => thread.root))], log, {
            withThreads: true,
        });
        if (leases === null) {
            unproven = true;
            return;
        }
        for (const thread of threads) {
            if (!(await deletable(thread, leases, volumePolicy))) continue;
            for (const removed of await arm.reapVolumes(thread))
                log(`reaper: thread ${thread.root} — removed ${removed}`);
        }
    };

    /**
     * The batch answer is minutes old by the time a thread's turn comes: a follow-up may have been queued
     * and claimed since, and a volume deleted under it is recreated empty by its mount. So a thread the
     * batch condemns is decided again on a read of its root alone, right before the delete; an
     * unconfirmed read keeps it.
     */
    const deletable = async (
        thread: VolumeThread,
        leases: ReadonlyMap<string, BoardLease>,
        policy: VolumePolicy
    ): Promise<boolean> => {
        if (volumeVerdict(leases.get(thread.root), thread.volumes, now(), policy) === 'keep') return false;
        const fresh = await lookupAll(deps.board, [thread.root], log, {
            withThreads: true,
            consequence: `keeping thread ${thread.root} this round`,
        });
        if (fresh === null) unproven = true;
        return fresh !== null && volumeVerdict(fresh.get(thread.root), thread.volumes, now(), policy) === 'delete';
    };

    const sweep = async (): Promise<void> => {
        if (sweeping) return;
        sweeping = true;
        unproven = false;
        const start = performance.now();
        let outcome: 'ok' | 'aborted' | 'error' = 'ok';
        try {
            await sweepGroups();
            await sweepVolumes();
            if (unproven) outcome = 'aborted';
        } catch (e) {
            outcome = 'error';
            log(`reaper: sweep failed, the next round retries: ${(e as Error).message}`);
        } finally {
            sweeping = false;
            deps.observe?.sweep(outcome, secondsSince(start));
        }
    };

    return {
        sweep,
        start() {
            if (deps.intervalMs <= 0 || timer !== null) return;
            void sweep();
            timer = setInterval(() => {
                void sweep();
            }, deps.intervalMs);
            timer.unref();
        },
        stop() {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        },
    };
}
