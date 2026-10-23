import { secondsSince } from '../../prometheus.js';
import type { AdmissionScope, ClaimObserver, ClaimWaitKind } from './job-store-admission.js';

/**
 * One acquisition's measurements, taken inside its transaction and reported by `done` only after the
 * transaction resolved: a rollback (a throwing assembly) records nothing, so no series ever describes
 * work that did not happen.
 */
export interface AcquireProbe {
    /** Both locks are held. */
    locked(): void;
    /** The candidate waited `seconds` as a row of `kind`. */
    aged(kind: ClaimWaitKind, seconds: number): void;
    /** A full budget refused the candidate. */
    refused(scope: AdmissionScope): void;
    /** The transaction committed; `claimed` is whether it handed out a claim. */
    done(claimed: boolean): void;
}

export function startAcquire(observer: ClaimObserver | undefined): AcquireProbe {
    const start = performance.now();
    let lockWait: number | null = null;
    let aged: { kind: ClaimWaitKind; seconds: number } | null = null;
    let refusal: AdmissionScope | null = null;
    return {
        locked: () => {
            lockWait = secondsSince(start);
        },
        aged: (kind, seconds) => {
            aged = { kind, seconds: Math.max(0, seconds) };
        },
        refused: (scope) => {
            refusal = scope;
        },
        done: (claimed) => {
            if (!observer) return;
            if (lockWait !== null) observer.lockWait(lockWait);
            observer.acquire(secondsSince(start));
            if (refusal !== null) observer.refusal(refusal);
            if (claimed && aged !== null) observer.wait(aged.kind, aged.seconds);
        },
    };
}
