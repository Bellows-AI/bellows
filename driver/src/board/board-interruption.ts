/** One interrupted attempt, as `Board.interrupt` reports it. Split out of `board.ts` for its line budget. */
export interface Interruption {
    reason: string;
    release: boolean;
    claimSeq?: number;
    /** The runner never started: the released claim's launch is `refused`, not merely unproven. */
    refused?: boolean;
    /**
     * Nothing proven against the attempt — a leftover that will not go away, an unconfirmed group read, a credential
     * left unconfirmed (`credentialWait`): released outside the interruption budget, its retry deferred.
     */
    blocked?: boolean;
    /**
     * The agent's helper asked for a connection the task lacks: released outside the interruption
     * budget with no retry deferral, and held by the board's claim gate until the requirement closes.
     */
    requirement?: boolean;
    /**
     * The platform took the attempt away (a drained driver, an evicted runner): released outside the
     * poison interruption budget, counted against the board's far looser node-loss bound.
     */
    nodeLoss?: boolean;
    /**
     * A docker class's dockerd lost under a failed gate, sent beside `nodeLoss`: the board refunds two in a
     * row and records the third consecutive one on as an ordinary interruption that spends an attempt.
     */
    daemonLoss?: boolean;
    /**
     * The task's organization is suspended (the heartbeat's `release`): released outside every budget, never a node
     * loss, and held by the board's claim until the organization is reactivated.
     */
    orgSuspended?: boolean;
}
