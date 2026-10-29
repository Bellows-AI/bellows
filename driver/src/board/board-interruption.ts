/** One interrupted attempt, as `Board.interrupt` reports it. Split out of `board.ts` for its line budget. */
export interface Interruption {
    reason: string;
    release: boolean;
    claimSeq?: number;
    /** The runner never started: the released claim's launch is `refused`, not merely unproven. */
    refused?: boolean;
    /** A claim held back by a leftover that will not go away: released outside the interruption budget, its retry deferred. */
    blocked?: boolean;
}
