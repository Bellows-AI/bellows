/**
 * The gate-run record's and the finish-pass record's board calls. Split out of `board.ts` for its line budget;
 * `createBoard` is the only importer. Neither throws: a write the board did not take and a read it
 * did not answer are both "nothing confirmed" — the write's caller refuses or goes on as its policy
 * says, and a read that is not fully readable reuses nothing.
 */

import type { BoardJob } from './board.js';
import { leasedWriter, type Post } from './board-lease-write.js';

const CONFLICT_CODE = 'GATE_RUN_CONFLICT';
const HTTP_NOT_FOUND = 404;

/** Where a gate run came from: the agent's ad-hoc call, the end-of-run gates pass, or a finish pass inside the run. */
export const GATE_RUN_SOURCES = ['adhoc', 'completion', 'finish'] as const;
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

/** One answered finish pass as the driver records it (copied from the board's). */
export interface FinishPassWrite {
    passId: string;
    runClaimSeq: number;
    verdict: 'passed' | 'failed';
    /** The first gate that failed; null on a passed pass. */
    gate: string | null;
}

/** What the job row holds for one pass id (copied from the board's): a failed one carries the round it spent. */
export type RecordedPass = { verdict: 'passed' } | { verdict: 'failed'; round: number };

/** One round read: the job row's failed rounds, and what it holds for the asked pass id (null: nothing). */
export interface FinishRead {
    failedRounds: number;
    pass: RecordedPass | null;
}

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

/** The asked pass as the board holds it: null when it holds none, undefined when the answer is not readable. */
function recordedPassOf(raw: unknown): RecordedPass | null | undefined {
    if (raw === null) return null;
    const pass = raw as { verdict?: unknown; round?: unknown } | undefined;
    if (typeof pass !== 'object') return undefined;
    if (pass.verdict === 'passed') return { verdict: 'passed' };
    if (pass.verdict === 'failed' && isInteger(pass.round) && pass.round >= 1) {
        return { verdict: 'failed', round: pass.round };
    }
    return undefined;
}

export interface GateRunBoard {
    /**
     * Records one gate execution's row under the lease: `ok` only when the board took it. Never throws:
     * `lost` when the lease is not this attempt's, `rejected` for anything else the board did not take.
     */
    gateRun(job: BoardJob, write: GateRunWrite, signal?: AbortSignal): Promise<'ok' | 'lost' | 'rejected'>;
    /**
     * The latest row per gate of the task's thread (every run of it), oldest gate first. Null for any answer
     * the driver cannot fully read (non-2xx, a lost lease, a malformed row, an aborted request): an
     * unconfirmed read is never an empty one, so the caller reuses nothing.
     */
    gateRuns(job: BoardJob, signal?: AbortSignal): Promise<GateRunRecord[] | null>;
    /**
     * One recorded run's whole output, the log stream the driver stored for it (`gate-<name>-<execution id>`), read
     * under the lease from the thread's rows. Null when the board holds none; throws on any other answer, so an
     * unreadable log is never read as a missing one.
     */
    gateLog(
        job: BoardJob,
        executionId: string,
        signal?: AbortSignal
    ): Promise<{ text: string; truncated: boolean; cause: string | null } | null>;
    /**
     * Records one answered finish pass under the lease: `ok` only when the board took it. Never throws:
     * `lost` when the lease is not this attempt's, `rejected` for anything else the board did not take.
     */
    finishPass(job: BoardJob, write: FinishPassWrite, signal?: AbortSignal): Promise<'ok' | 'lost' | 'rejected'>;
    /**
     * The failed finish passes of the job row, every claim of it, and what the row holds for `passId`. Null for any
     * answer the driver cannot read in full (non-2xx, a lost lease, a missing or malformed count or pass, an aborted
     * request): unknown rounds are never zero rounds, and an unread pass is never "not recorded".
     */
    finishRounds(job: BoardJob, passId: string, signal?: AbortSignal): Promise<FinishRead | null>;
}

export function gateRunCalls(post: Post): GateRunBoard {
    const leased = leasedWriter(post, CONFLICT_CODE);
    return {
        async gateRun(job, write, signal) {
            return leased(`/api/jobs/${job.id}/gate-run`, job, write, signal);
        },

        async gateRuns(job, signal) {
            try {
                const response = await post(`/api/jobs/${job.id}/gate-runs`, { leaseToken: job.leaseToken }, false, {
                    signal,
                });
                if (!response.ok) return null;
                const raw = ((await response.json()) as { runs?: unknown }).runs;
                if (!Array.isArray(raw)) return null;
                const rows = raw.map(recordOf);
                return rows.some((r) => r === null) ? null : (rows as GateRunRecord[]);
            } catch {
                return null;
            }
        },

        async gateLog(job, executionId, signal) {
            const response = await post(
                `/api/jobs/${job.id}/gate-log`,
                { leaseToken: job.leaseToken, executionId },
                true,
                {
                    signal,
                }
            );
            if (response.status === HTTP_NOT_FOUND) return null;
            const body = (await response.json().catch(() => null)) as {
                text?: unknown;
                truncated?: unknown;
                cause?: unknown;
            } | null;
            if (typeof body?.text !== 'string') throw new Error(`job ${job.id}: the gate log answer is unreadable`);
            return {
                text: body.text,
                truncated: body.truncated === true,
                cause: typeof body.cause === 'string' ? body.cause : null,
            };
        },

        async finishPass(job, write, signal) {
            return leased(`/api/jobs/${job.id}/finish-passes`, job, write, signal);
        },

        async finishRounds(job, passId, signal) {
            try {
                const response = await post(
                    `/api/jobs/${job.id}/finish-passes/read`,
                    { leaseToken: job.leaseToken, passId },
                    false,
                    { signal }
                );
                if (!response.ok) return null;
                const body = (await response.json()) as { failedRounds?: unknown; pass?: unknown } | null;
                const rounds = body?.failedRounds;
                if (!isInteger(rounds) || rounds < 0) return null;
                const pass = recordedPassOf(body?.pass);
                return pass === undefined ? null : { failedRounds: rounds, pass };
            } catch {
                return null;
            }
        },
    };
}
