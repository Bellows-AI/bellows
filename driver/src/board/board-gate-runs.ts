/**
 * The gate-run record's two board calls (issue #983). Split out of `board.ts` for its line budget;
 * `createBoard` is the only importer. Neither throws: a write the board did not take and a read it
 * did not answer are both "nothing confirmed" — the write's caller refuses or goes on as its policy
 * says, and a read that is not fully readable reuses nothing.
 */

import type { BoardJob } from './board.js';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const CONFLICT_CODE = 'GATE_RUN_CONFLICT';

/** Where a gate run came from: the agent's ad-hoc call, or the end-of-run gates pass. */
export const GATE_RUN_SOURCES = ['adhoc', 'completion'] as const;
export type GateRunSource = (typeof GATE_RUN_SOURCES)[number];

/**
 * How one execution ended (copied from the board's). `running` is the row written before the gate
 * starts; the terminal ones: it `passed` or `failed`, its environment's setup failed so it never ran
 * (`setup_failed`), it was never started (`not_started`), or it started and its result was lost
 * (`incomplete`).
 */
export const GATE_RUN_OUTCOMES = ['running', 'passed', 'failed', 'setup_failed', 'not_started', 'incomplete'] as const;
export type GateRunOutcome = (typeof GATE_RUN_OUTCOMES)[number];

/** One execution as the driver records it; the run it belongs to rides separately. */
export interface GateRunRow {
    executionId: string;
    gate: string;
    /** The gate's identity hash (`gate-identity.ts`): never a raw value. */
    identity: string;
    filtered: boolean;
    source: GateRunSource;
    outcome: GateRunOutcome;
    exitCode: number | null;
    treeBefore: string | null;
    treeAfter: string | null;
    /** Whether a shipped path was touched during the run; null when unmeasured. Only false is clean. */
    mutatedSince: boolean | null;
    startedAt: string | null;
    finishedAt: string | null;
}

/** A write: the row and the run it belongs to. */
export interface GateRunWrite extends GateRunRow {
    runClaimSeq: number;
}

/** A stored row: what was written, and the claim of the driver that wrote it. */
export interface GateRunRecord extends GateRunWrite {
    claimSeq: number;
}

type Post = (
    path: string,
    body: unknown,
    allow404?: boolean,
    options?: { signal?: AbortSignal | undefined; allow?: readonly number[] }
) => Promise<Response>;

const isString = (v: unknown): v is string => typeof v === 'string';
const nullable = (v: unknown, check: (x: unknown) => boolean): boolean => v === null || check(v);
const isInteger = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** A row read field by field: anything the driver cannot vouch for makes the whole answer unreadable. */
function recordOf(raw: unknown): GateRunRecord | null {
    const row = raw as Partial<Record<keyof GateRunRecord, unknown>> | null;
    if (typeof row !== 'object' || row === null) return null;
    if (!isString(row.executionId) || !isString(row.gate) || !isString(row.identity)) return null;
    if (typeof row.filtered !== 'boolean') return null;
    if (!GATE_RUN_SOURCES.includes(row.source as GateRunSource)) return null;
    if (!GATE_RUN_OUTCOMES.includes(row.outcome as GateRunOutcome)) return null;
    if (!nullable(row.exitCode, isInteger)) return null;
    for (const field of ['treeBefore', 'treeAfter', 'startedAt', 'finishedAt'] as const) {
        if (!nullable(row[field], isString)) return null;
    }
    if (!nullable(row.mutatedSince, (v) => typeof v === 'boolean')) return null;
    if (!isInteger(row.runClaimSeq) || row.runClaimSeq < 1 || !isInteger(row.claimSeq) || row.claimSeq < 1) return null;
    return row as unknown as GateRunRecord;
}

export interface GateRunBoard {
    /**
     * Records one gate execution's row under the lease: `ok` only when the board took it. Never throws:
     * `lost` when the lease is not this attempt's, `rejected` for anything else the board did not take.
     */
    gateRun(job: BoardJob, write: GateRunWrite, signal?: AbortSignal): Promise<'ok' | 'lost' | 'rejected'>;
    /**
     * The latest row per gate of the run `runClaimSeq` started, oldest gate first. Null for any answer
     * the driver cannot fully read (non-2xx, a lost lease, a malformed row, an aborted request): an
     * unconfirmed read is never an empty one, so the caller reuses nothing.
     */
    gateRuns(job: BoardJob, runClaimSeq: number, signal?: AbortSignal): Promise<GateRunRecord[] | null>;
}

export function gateRunCalls(post: Post): GateRunBoard {
    return {
        async gateRun(job, write, signal) {
            try {
                const response = await post(
                    `/api/jobs/${job.id}/gate-run`,
                    { leaseToken: job.leaseToken, ...write },
                    true,
                    { signal }
                );
                if (response.ok) return 'ok';
                if (response.status === HTTP_NOT_FOUND) return 'lost';
                if (response.status !== HTTP_CONFLICT) return 'rejected';
                const code = ((await response.json().catch(() => ({}))) as { code?: unknown }).code;
                return code === CONFLICT_CODE ? 'rejected' : 'lost';
            } catch {
                return 'rejected';
            }
        },

        async gateRuns(job, runClaimSeq, signal) {
            try {
                const response = await post(
                    `/api/jobs/${job.id}/gate-runs`,
                    { leaseToken: job.leaseToken, runClaimSeq },
                    false,
                    { signal }
                );
                if (!response.ok) return null;
                const raw = ((await response.json()) as { runs?: unknown }).runs;
                if (!Array.isArray(raw)) return null;
                const rows = raw.map(recordOf);
                return rows.some((r) => r === null) ? null : (rows as GateRunRecord[]);
            } catch {
                return null;
            }
        },
    };
}
