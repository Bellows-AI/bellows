import { READ_BINDING, sameRepo } from '@factory-ai/core';
import type { PrFacts } from '@factory-ai/core';
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import {
    createReadPause,
    MAX_ROUNDS_PER_TICK,
    observedMergeId,
    OBSERVER_CONCURRENCY,
    readFacts,
    type PrReader,
    type ReadPause,
} from './batch-pr-observer.js';
import type { PrLifecycleStore } from './db/pr-lifecycle-store.js';
import {
    claimDue,
    withFollowClaim,
    PR_FOLLOW_INTERVAL_MS,
    type PrFollowClaim,
    type PrFollowResult,
} from './db/pr-follow-store.js';

/**
 * The PR follower (docs/workflows.md): the periodic PR read behind the two paths that only a
 * webhook drove — a parked block wait on a PR, and the merged-PR close of a non-batch thread. It
 * reads through the batch observer's reader, backoff and rate-limit pause and applies exactly what
 * the webhook would have, idempotently: the webhook stays the fast path, and a pass after it
 * changes nothing. A failed read changes nothing and is retried on the backoff.
 */

export interface PrFollowerDeps {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
    /** Absent offline: nothing is followed. */
    reader?: PrReader | undefined;
    prs: Pick<PrLifecycleStore, 'cancelForRepoPr' | 'foldObservedActivity'>;
    /** Records a merge GitHub reports: the job store's `closeMergedPr`, the batch observer's own hand-off. */
    recordMerge: (repo: string, prNumber: number, deliveryId: string, mergedAt: Date | undefined) => Promise<unknown>;
    now?: (() => Date) | undefined;
    concurrency?: number | undefined;
    /** How far a newly followed PR's first read is spread; the follow interval when absent. */
    spreadMs?: number | undefined;
    /** The org's rate-limit pause, shared with the batch observer. */
    pause?: ReadPause | undefined;
}

export interface PrFollower {
    /** Reads every due PR once; resolves to how many reads were committed. */
    observeDue(): Promise<number>;
}

/** The terminal reason the webhook's plain close stamps on a cancelled wait. */
const CLOSED_REASON = 'pr closed';

/** Hex digits of the fingerprint kept; the column is text, this only bounds the row. */
const FINGERPRINT_DIGITS = 40;

/**
 * What a read says about the PR, as a stable hash: the activity stamp and every field the read
 * returns that activity can change (head, state, mergeability, approvals, each check's state). Two
 * activities that leave all of them identical (a comment in the same second as another) cannot be
 * told apart; that is a stated limit (docs/workflows.md), not a wake on every poll.
 */
const observedFingerprint = (facts: PrFacts): string => {
    const checks = facts.checks.map((check) => `${check.name}=${check.state}`).sort();
    const parts = [facts.updatedAt, facts.headSha, facts.state, facts.merged, facts.mergeable, facts.approvals, checks];
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, FINGERPRINT_DIGITS);
};

/** A provider timestamp as a date, or undefined when absent or unparseable: never acted on unconfirmed. */
const validDate = (value: string | null): Date | undefined => {
    if (value === null) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
};

export function createPrFollower(deps: PrFollowerDeps): PrFollower {
    const { sql, orgId, ready, reader, prs, recordMerge, now } = deps;
    const concurrency = deps.concurrency ?? OBSERVER_CONCURRENCY;
    const spreadMs = deps.spreadMs ?? PR_FOLLOW_INTERVAL_MS;
    const store = { sql, orgId, now };
    const pause = deps.pause ?? createReadPause(now);

    /**
     * What the webhook would have done for the PR as GitHub reports it now, inside the claim's
     * transaction. A merge is the exception that cannot join it (the job store opens its own); it is
     * safe regardless: it is idempotent and a merge is never undone.
     */
    const apply = async (facts: PrFacts, tx: TransactionSql): Promise<PrFollowResult> => {
        if (facts.merged) {
            const mergedAt = validDate(facts.mergedAt);
            await recordMerge(facts.repo, facts.number, observedMergeId(facts), mergedAt);
            return { kind: 'seen', closed: true };
        }
        if (facts.state === 'closed') {
            await prs.cancelForRepoPr(facts.repo, facts.number, CLOSED_REASON, tx);
            return { kind: 'seen', closed: true };
        }
        const activityAt = validDate(facts.updatedAt);
        if (activityAt !== undefined) {
            await prs.foldObservedActivity(
                { repo: facts.repo, prNumber: facts.number, activityAt, fingerprint: observedFingerprint(facts) },
                tx
            );
        }
        return { kind: 'seen', closed: false };
    };

    const followOne = async (claim: PrFollowClaim): Promise<boolean> => {
        const read = await readFacts(reader!, claim.repo, claim.prNumber);
        pause.note(read);
        return withFollowClaim(store, claim, async (tx): Promise<PrFollowResult> => {
            if (read.kind === 'error') return { kind: 'failed', error: read.error, retryAfterMs: read.retryAfterMs };
            // Facts about another PR are never applied to this one.
            if (!sameRepo(read.facts.repo, claim.repo) || read.facts.number !== claim.prNumber) {
                return { kind: 'failed', error: READ_BINDING, retryAfterMs: null };
            }
            return apply(read.facts, tx);
        });
    };

    return {
        async observeDue() {
            if (ready) await ready;
            if (!reader) return 0;
            let committed = 0;
            for (let round = 0; round < MAX_ROUNDS_PER_TICK && pause.open(); round += 1) {
                const claims = await claimDue(store, concurrency, spreadMs);
                if (claims.length === 0) break;
                const outcomes = await Promise.all(
                    claims.map((claim) =>
                        followOne(claim).catch((e: Error) => {
                            // The lease expires on its own and the PR is read again; nothing is lost.
                            console.error(`[pr-follow] following ${claim.repo}#${claim.prNumber} failed: ${e.message}`);
                            return false;
                        })
                    )
                );
                committed += outcomes.filter(Boolean).length;
            }
            return committed;
        },
    };
}
