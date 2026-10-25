import type { TokenType, UnassignedReason, UsagePrecision, UsageRow } from '@factory-ai/core';
import { UNKNOWN_BUCKET } from '@factory-ai/core';

/** Display order of the four token types; none of them is ever combined with another. */
export const USAGE_TOKEN_TYPES: readonly TokenType[] = ['input', 'cacheRead', 'cacheCreation', 'output'];

export const TOKEN_TYPE_LABELS: Record<TokenType, string> = {
    input: 'Uncached input',
    cacheRead: 'Cache read',
    cacheCreation: 'Cache write',
    output: 'Output',
};

/** The one sanctioned sum: uncached input + cache read + cache write, never with output. */
export const TOTAL_INPUT_LABEL = 'Total input';
export const TOTAL_INPUT_CAPTION = 'uncached input + cache read + cache write';

export const OBSERVED_USAGE_NOTE = 'Figures describe observed usage, not guaranteed complete consumption';

/** Why an eligible amount has no run, in the words every surface shares. */
export const UNASSIGNED_SENTENCES: Record<UnassignedReason, string> = {
    'no-task': 'usage not tied to any task',
    'no-segment': 'usage between runs of this task',
    overlap: 'usage while more than one run was active',
    'unconfirmed-launch': 'usage from a run whose launch was never confirmed',
    'refused-launch': 'usage from a run whose launch was refused',
    'unknown-boundary': 'usage from a run whose start is unknown',
    'cumulative-spans-runs': 'a running counter that spans several runs',
};

export const UNLOCATED_SENTENCE = 'usage whose time is unknown';
export const UNRESOLVED_TEMPORALITY_SENTENCE = 'observations whose counting mode is unresolved';

/** Null is "not measured" and renders a dash; a measured zero renders 0. */
export function figure(value: number | null): string {
    if (value === null) return '—';
    return value.toLocaleString('en-US');
}

export function precisionMark(precision: UsagePrecision | null): string {
    return precision === 'estimated' || precision === 'mixed' ? '~' : '';
}

export function precisionLabel(precision: UsagePrecision | null): string {
    if (precision === 'estimated') return 'estimated';
    if (precision === 'mixed') return 'mixed estimated and exact';
    return '';
}

export function coverageLabel(coverage: { measured: number; contributors: number }): string | null {
    if (coverage.measured >= coverage.contributors) return null;
    return `${coverage.measured} of ${coverage.contributors} sessions measured`;
}

export function rowKey(row: UsageRow): string {
    return row.querySource === null ? row.model : `${row.model}\u0000${row.querySource}`;
}

export const isUnknownBucket = (key: string | null): boolean => key === UNKNOWN_BUCKET;
