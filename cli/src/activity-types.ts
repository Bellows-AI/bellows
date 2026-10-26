/**
 * The gate and PR wire shapes of `GET /api/jobs/:id/activity` (issue #983), copied from the server's
 * `telemetry/run-activity.ts` (the CLI imports nothing from it). `null` is "not recorded", never zero.
 */

/** `null`: nothing was recorded, so nothing is claimed. `partial`: some figure is missing or unconfirmed. */
export type ActivityCoverage = 'complete' | 'partial' | null;
export type GateOutcomeCounts = Record<
    'passed' | 'failed' | 'setup_failed' | 'not_started' | 'incomplete' | 'running' | 'unknown',
    number
>;

/** Copied from the server's `telemetry/run-activity.ts` (the CLI imports nothing from it). */
export interface GateActivity {
    coverage: ActivityCoverage;
    executions: number | null;
    byOutcome: GateOutcomeCounts | null;
    measuredMs: number | null;
    measuredCount: number;
    unmeasuredCount: number;
    reused: { jobId: string; gate: string; executionId: string; finishedAt: string | null; reason: string }[];
    observed: { executions: number; byOutcome: GateOutcomeCounts } | null;
}

export interface PrActivity {
    coverage: ActivityCoverage;
    counts: { operations: number; distinct: number } | null;
    operations: {
        jobId: string;
        operationId: string | null;
        kind: 'created' | 'reused' | 'agent_created';
        repo: string;
        number: number;
        url: string;
    }[];
    distinct: { repo: string; number: number; url: string }[];
}
