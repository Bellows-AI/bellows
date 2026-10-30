import type { GateReport } from '../../db/jobs/job-store-types.js';
import { UUID } from '../../identifiers.js';
import { body } from '../helpers.js';
import { GATE_NAME_LIMIT, nullableTimestamp, OUTPUT_LIMIT } from './job-limits.js';

/** The longest reason a reused gate entry may carry. */
const REUSED_REASON_LIMIT = 512;

/** A gate entry's own fields, or the reason it is refused. */
function gateEntryCore(entry: Record<string, unknown>): Pick<GateReport, 'name' | 'status' | 'exitCode'> | string {
    const { name, status, exitCode } = entry;
    if (typeof name !== 'string' || !name.trim() || name.length > GATE_NAME_LIMIT) {
        return `every gate needs a name of at most ${GATE_NAME_LIMIT} characters`;
    }
    if (status !== 'pending' && status !== 'running' && status !== 'passed' && status !== 'failed') {
        return "gate status must be 'pending', 'running', 'passed' or 'failed'";
    }
    if (exitCode !== undefined && exitCode !== null && !Number.isInteger(exitCode)) {
        return 'gate exitCode must be an integer or null';
    }
    return { name, status, exitCode: (exitCode as number | undefined) ?? null };
}

/** The execution a gate entry is, and, for a gate not launched, the pass it is served from (issue #983). */
function gateEntryRecord(entry: Record<string, unknown>): Pick<GateReport, 'executionId' | 'reused'> | string {
    const { executionId, reused } = entry;
    if (executionId !== undefined && (typeof executionId !== 'string' || !UUID.test(executionId))) {
        return 'gate executionId must be a uuid';
    }
    const reusedFrom = reused === undefined ? undefined : reusedOf(reused);
    if (typeof reusedFrom === 'string') return reusedFrom;
    return {
        ...(executionId === undefined ? {} : { executionId }),
        ...(reusedFrom === undefined ? {} : { reused: reusedFrom }),
    };
}

function validateGateEntry(raw: unknown): GateReport | string {
    const entry = body(raw);
    const core = gateEntryCore(entry);
    if (typeof core === 'string') return core;
    const { output } = entry;
    if (output !== undefined && output !== null && typeof output !== 'string') {
        return 'gate output must be a string or null';
    }
    const { startedAt } = entry;
    if (startedAt !== undefined && (typeof startedAt !== 'string' || !nullableTimestamp(startedAt))) {
        return 'gate startedAt must be a timestamp';
    }
    const record = gateEntryRecord(entry);
    if (typeof record === 'string') return record;
    return {
        ...core,
        output: typeof output === 'string' ? output.slice(0, OUTPUT_LIMIT) : null,
        ...(startedAt === undefined ? {} : { startedAt }),
        ...record,
    };
}

/** A gate entry's `reused` attribution, or the reason it is refused. */
function reusedOf(raw: unknown): NonNullable<GateReport['reused']> | string {
    const { executionId, finishedAt, reason } = body(raw);
    if (typeof executionId !== 'string' || !UUID.test(executionId)) return 'gate reused.executionId must be a uuid';
    if (finishedAt !== null && typeof finishedAt !== 'string') return 'gate reused.finishedAt must be a string or null';
    if (typeof reason !== 'string' || reason.length > REUSED_REASON_LIMIT) {
        return `gate reused.reason must be a string of at most ${REUSED_REASON_LIMIT} characters`;
    }
    return { executionId, finishedAt, reason };
}

export function validateGates(raw: unknown): { ok: true; value: GateReport[] } | { ok: false; message: string } {
    if (!Array.isArray(raw)) return { ok: false, message: 'gates must be an array' };
    const results: GateReport[] = [];
    for (const item of raw) {
        const one = validateGateEntry(item);
        if (typeof one === 'string') return { ok: false, message: one };
        results.push(one);
    }
    return { ok: true, value: results };
}
