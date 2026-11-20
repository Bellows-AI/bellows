/**
 * The attempt outcomes a transaction records, carried out of it: a body pushes into a tally, and the function that owns
 * the outermost `sql.begin` reports it only after that transaction resolved. A throw rolls back and reports nothing; a
 * savepoint collects into a child tally merged only when the savepoint resolved. `metrics.ts` turns the reports into
 * `bellows.job.interruptions` and `bellows.job.settled`.
 */

import type { FailureKind, JobOutcome } from './job-store-types.js';

/** Why an attempt was interrupted: what recorded the entry on the row. */
export type InterruptionCause =
    | 'lease_expired'
    | 'adopted'
    | 'node_loss'
    | 'daemon_loss'
    | 'blocked'
    | 'requirement'
    | 'org_suspended'
    | 'refused'
    | 'handback'
    | 'staged_commit'
    | 'review_lease_expired';

/** How an attempt ended: a verdict, or the board's retirement of a row out of attempts. */
export type SettledOutcome = JobOutcome | 'dead';

/** The rule a dead retirement ran into. */
export type RetirementCause = 'poison_budget' | 'node_loss_bound' | 'interruption_bound';

/** A verdict's failure kind (`none` for a success), or a retirement's rule. */
export type SettledCause = FailureKind | 'none' | RetirementCause;

/** Where a tally reports: `ClaimObserver` is one. */
export interface OutcomeObserver {
    /** A committed interruption entry, by cause, and whether it refunded the attempt (read off the written row). */
    interrupted(cause: InterruptionCause, refunded: boolean): void;
    /** A committed attempt outcome: the verdict as it landed, policy rewrite included, or a dead retirement. */
    settled(outcome: SettledOutcome, cause: SettledCause): void;
}

export interface OutcomeTally extends OutcomeObserver {
    /** Takes a resolved savepoint's child tally into this one. */
    merge(child: OutcomeTally): void;
    /** Reports everything collected, once the owning transaction resolved. */
    report(observer: OutcomeObserver | undefined): void;
}

export function createTally(): OutcomeTally {
    const entries: ((observer: OutcomeObserver) => void)[] = [];
    const tally: OutcomeTally = {
        interrupted: (cause, refunded) => void entries.push((o) => o.interrupted(cause, refunded)),
        settled: (outcome, cause) => void entries.push((o) => o.settled(outcome, cause)),
        merge: (child) => child.report(tally),
        report: (observer) => {
            if (!observer) return;
            for (const entry of entries) entry(observer);
        },
    };
    return tally;
}
