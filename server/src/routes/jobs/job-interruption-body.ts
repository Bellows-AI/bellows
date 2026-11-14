/** The interrupt route's body validation, split out of `job-handlers-worker.ts` for its line budget. */

/** The longest interruption reason the board records: one driver sentence. */
const INTERRUPTION_REASON_MAX = 500;

/**
 * The flags only a release carries: a start the runner refused is a released attempt's outcome (an
 * adoption has a runner), and a claim that waits on a leftover still terminating or on a
 * connection the task asked for is a release outside the budget. `daemonLoss` (a docker class's
 * dockerd lost under a failed gate) rides beside `nodeLoss`; the store bounds a run of them.
 */
const RELEASE_FLAGS = ['refused', 'blocked', 'requirement', 'nodeLoss', 'daemonLoss'] as const;
type ReleaseFlags = Partial<Record<(typeof RELEASE_FLAGS)[number], true>>;

/** The release flags the body sets, each `true` or absent — never `false`. */
function releaseFlagsOf(raw: Record<string, unknown>, release: boolean): ReleaseFlags | string {
    const flags: ReleaseFlags = {};
    for (const name of RELEASE_FLAGS) {
        if (raw[name] !== undefined && typeof raw[name] !== 'boolean') return `${name} must be a boolean`;
        if (raw[name] === true && !release) return `${name} applies to a release`;
        if (raw[name] === true) flags[name] = true;
    }
    return flags;
}

/** The interruption body's fields, or the refusal message for the first bad one. */
export function interruptionOf(raw: Record<string, unknown>):
    | ({
          reason: string;
          release: boolean;
          claimSeq: number | null;
      } & ReleaseFlags)
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
    return { reason, release, claimSeq: (claimSeq as number | null | undefined) ?? null, ...flagged };
}
