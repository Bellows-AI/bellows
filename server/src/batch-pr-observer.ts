import { nextObservationDelayMs, READ_BINDING, READ_RATE_LIMITED, READ_TRANSPORT, sameRepo } from '@factory-ai/core';
import type { PrFacts } from '@factory-ai/core';
import type { Sql } from 'postgres';
import {
    claimDue,
    commitObservation,
    readObservations,
    requestRefresh,
    type BatchPrObservation,
    type ObservationClaim,
    type ObservationResult,
    type RefreshHint,
} from './db/batches/batch-store-observation.js';
import { GitHubReadError } from './github/pr-read.js';

/**
 * The batch PR observer (docs/batches.md): reads each eligible task's PR from GitHub on a steady
 * cadence and records what it found. Webhooks only ask for a refresh; this loop is the authority,
 * so a missed delivery, a restart or a second replica converges on the same rows. The provider is
 * read with no database lock held, and a result is committed only if its claim still stands.
 */

/** How often the loop looks for a due row; each row's own `next_refresh_at` sets how often a PR is read. */
export const BATCH_OBSERVE_TICK_MS = 5000;
/** Provider calls in flight at once, per organization. */
export const OBSERVER_CONCURRENCY = 4;
/** Batches of claims one tick may work through, so a large backlog cannot starve the next tick. */
export const MAX_ROUNDS_PER_TICK = 50;

export interface PrReader {
    readPullRequest(repo: string, number: number): Promise<PrFacts>;
}

export interface BatchPrObserverDeps {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
    /** Absent offline: nothing is observed. */
    reader?: PrReader | undefined;
    /** Records a merge GitHub reports as done: the job store's `closeMergedPr`, with the merge's own time. */
    recordMerge: (repo: string, prNumber: number, deliveryId: string, mergedAt: Date | undefined) => Promise<unknown>;
    /** Lets the human gate judge a merge just recorded. */
    reconcile: (batchId: string) => Promise<unknown>;
    now?: (() => Date) | undefined;
    concurrency?: number | undefined;
    /** The org's rate-limit pause, shared with the PR follower; the observer's own when absent. */
    pause?: ReadPause | undefined;
}

export interface BatchPrObserver {
    /** Reads every due PR once; resolves to how many results were committed. */
    observeDue(): Promise<number>;
    /** A webhook's hint: the named PR changed, read it soon. Never reads. */
    requestRefresh(hint: RefreshHint): Promise<number>;
    /** The org's observations of one batch, in plan order. */
    list(batchId: string): Promise<BatchPrObservation[]>;
}

/** `pr_merge.delivery_id` is bounded to 64 characters (048). */
const DELIVERY_ID_LIMIT = 64;

/** The `pr_merge.delivery_id` of a merge the board saw itself; GitHub's own deliveries are GUIDs. */
export const observedMergeId = (facts: PrFacts): string =>
    `observed:${facts.mergeCommitSha ?? facts.number}`.slice(0, DELIVERY_ID_LIMIT);

const failure = (error: GitHubReadError): ObservationResult => ({
    kind: 'error',
    error: error.kind,
    detail: error.message,
    retryAfterMs: error.retryAfterMs,
});

/**
 * One provider read as a result: the facts, or the kind of failure. A non-provider error is a
 * transport failure, so no read ever escapes as an answer; the PR follower reads through this too.
 */
export async function readFacts(reader: PrReader, repo: string, number: number): Promise<ObservationResult> {
    try {
        return { kind: 'facts', facts: await reader.readPullRequest(repo, number) };
    } catch (e) {
        if (e instanceof GitHubReadError) return failure(e);
        return failure(new GitHubReadError((e as Error).message, READ_TRANSPORT));
    }
}

/**
 * Installation-level throttling: a rate limit pauses every read of the org, not one PR's. One pause
 * is shared by the batch observer and the PR follower, which read through the same installation.
 */
export interface ReadPause {
    /** Whether reads may go out now. */
    open(): boolean;
    /** Learns from a result: a rate-limited read pauses for the provider's Retry-After (or the backoff). */
    note(result: ObservationResult): void;
}

export function createReadPause(now?: (() => Date) | undefined): ReadPause {
    const clock = (): Date => (now ? now() : new Date());
    let pausedUntil = 0;
    return {
        open: () => clock().getTime() >= pausedUntil,
        note(result) {
            if (result.kind !== 'error' || result.error !== READ_RATE_LIMITED) return;
            const pause = nextObservationDelayMs({ ok: false, failures: 1, retryAfterMs: result.retryAfterMs });
            pausedUntil = Math.max(pausedUntil, clock().getTime() + pause);
        },
    };
}

export function createBatchPrObserver(deps: BatchPrObserverDeps): BatchPrObserver {
    const { sql, orgId, ready, reader, recordMerge, reconcile } = deps;
    const now = deps.now;
    const concurrency = deps.concurrency ?? OBSERVER_CONCURRENCY;
    const store = { sql, orgId, now };
    const gate = async () => {
        if (ready) await ready;
    };
    const pause = deps.pause ?? createReadPause(now);

    const read = async (claim: ObservationClaim): Promise<ObservationResult> => {
        // The recorded PR must be in the plan's own repository; a number alone identifies nothing.
        if (!sameRepo(claim.repo, claim.targetRepo)) {
            return {
                kind: 'error',
                error: READ_BINDING,
                detail: `the PR is in ${claim.repo}, the task targets ${claim.targetRepo}`,
                retryAfterMs: null,
            };
        }
        return readFacts(reader!, claim.repo, claim.prNumber);
    };

    const observeOne = async (claim: ObservationClaim): Promise<boolean> => {
        const result = await read(claim);
        pause.note(result);
        const committed = await commitObservation(store, claim, result);
        if (committed.status === 'superseded') return false;
        // Facts about another PR were downgraded to a binding error at commit; never record their merge.
        if (
            result.kind === 'facts' &&
            result.facts.merged &&
            sameRepo(result.facts.repo, claim.repo) &&
            result.facts.number === claim.prNumber
        ) {
            await recordMergeOf(claim, result.facts);
        }
        return true;
    };

    // Recording is idempotent (the ledger is keyed by repo and number), so a crash between the
    // commit and here is repaired by the next read, which finds the PR still unrecorded.
    const recordMergeOf = async (claim: ObservationClaim, facts: PrFacts): Promise<void> => {
        const mergedAt = facts.mergedAt === null ? undefined : new Date(facts.mergedAt);
        await recordMerge(claim.repo, claim.prNumber, observedMergeId(facts), mergedAt);
        await reconcile(claim.batchId);
    };

    return {
        async observeDue() {
            await gate();
            if (!reader) return 0;
            let committed = 0;
            for (let round = 0; round < MAX_ROUNDS_PER_TICK && pause.open(); round += 1) {
                const claims = await claimDue(store, concurrency);
                if (claims.length === 0) break;
                const outcomes = await Promise.all(
                    claims.map((claim) =>
                        observeOne(claim).catch((e: Error) => {
                            // The lease expires on its own and the row is read again; nothing is lost.
                            console.error(`[batches] observing ${claim.repo}#${claim.prNumber} failed: ${e.message}`);
                            return false;
                        })
                    )
                );
                committed += outcomes.filter(Boolean).length;
            }
            return committed;
        },

        async requestRefresh(hint) {
            await gate();
            return requestRefresh(store, hint);
        },

        async list(batchId) {
            await gate();
            return readObservations(store, batchId);
        },
    };
}

/**
 * Observes every org's due PRs once now and then on an interval, the shape of the reconciler:
 * a pass never overlaps the previous one and never throws. Returns the stop.
 */
export function startBatchPrObserver(
    orgs: { observeBatchPrs(): Promise<void> },
    intervalMs = BATCH_OBSERVE_TICK_MS
): () => void {
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await orgs.observeBatchPrs();
        } catch (e) {
            console.error(`[batches] observe failed: ${(e as Error).message}`);
        } finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
