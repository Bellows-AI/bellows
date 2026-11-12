/** The interrupt route's body validation, split out of `job-handlers-worker.ts` for its line budget. */

/** The longest interruption reason the board records: one driver sentence. */
const INTERRUPTION_REASON_MAX = 500;

/**
 * The flags only a release carries: a start the runner refused is a released attempt's outcome (an
 * adoption has a runner), and a claim that waits on a leftover still terminating or on a
 * connection the task asked for is a release outside the budget.
 */
function releaseFlagsOf(
    raw: Record<string, unknown>,
    release: boolean
): { refused: boolean; blocked: boolean; requirement: boolean; nodeLoss: boolean } | string {
    for (const name of ['refused', 'blocked', 'requirement', 'nodeLoss'] as const) {
        if (raw[name] !== undefined && typeof raw[name] !== 'boolean') return `${name} must be a boolean`;
        if (raw[name] === true && !release) return `${name} applies to a release`;
    }
    return {
        refused: raw.refused === true,
        blocked: raw.blocked === true,
        requirement: raw.requirement === true,
        nodeLoss: raw.nodeLoss === true,
    };
}

/** The interruption body's fields, or the refusal message for the first bad one. */
export function interruptionOf(raw: Record<string, unknown>):
    | {
          reason: string;
          release: boolean;
          claimSeq: number | null;
          refused?: true;
          blocked?: true;
          requirement?: true;
          nodeLoss?: true;
      }
    | string {
    const { reason, release, claimSeq } = raw;
    if (typeof reason !== 'string' || !reason.trim() || reason.length > INTERRUPTION_REASON_MAX) {
        return `reason must be a non-empty string of at most ${INTERRUPTION_REASON_MAX} characters`;
    }
    if (typeof release !== 'boolean') return 'release must be a boolean';
    if (claimSeq !== undefined && claimSeq !== null && (!Number.isSafeInteger(claimSeq) || (claimSeq as number) < 1)) {
        return 'claimSeq must be a positive integer';
    }
    // An adoption records the earlier claim it adopted, never the adopter's own.
    if (!release && (claimSeq === undefined || claimSeq === null))
        return 'an adoption (release false) names its claimSeq';
    const flagged = releaseFlagsOf(raw, release);
    if (typeof flagged === 'string') return flagged;
    const { refused, blocked, requirement, nodeLoss } = flagged;
    return {
        reason,
        release,
        claimSeq: (claimSeq as number | null | undefined) ?? null,
        ...(refused ? { refused: true as const } : {}),
        ...(blocked ? { blocked: true as const } : {}),
        ...(requirement ? { requirement: true as const } : {}),
        ...(nodeLoss ? { nodeLoss: true as const } : {}),
    };
}
