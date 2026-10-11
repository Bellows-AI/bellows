import { TASK_SORTS, TASK_STATES } from './board.js';
import type { BoardClient } from './board.js';
import { UsageError } from './input.js';

/** The `factory task list` flags; the board validates the text filters, the CLI the enums and the limit. */
export const TASK_LIST_OPTIONS = {
    state: { type: 'string' },
    q: { type: 'string' },
    author: { type: 'string' },
    repo: { type: 'string' },
    sort: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
} as const;

/** The task list's page bound, mirrored from the board so an obvious typo never round-trips. */
const TASK_LIMIT_MAX = 50;

/** A flag whose value is one of a fixed set — a typo is a usage error before any request. */
function parseChoice<T extends string>(flag: string, raw: string | undefined, allowed: readonly T[]): T | undefined {
    const choice = allowed.find((value) => value === raw);
    if (raw !== undefined && choice === undefined) {
        throw new UsageError(`--${flag} must be one of ${allowed.join(', ')}, got "${raw}"`);
    }
    return choice;
}

function parseTaskLimit(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > TASK_LIMIT_MAX) {
        throw new UsageError(`--limit must be an integer 1..${TASK_LIMIT_MAX}, got "${raw}"`);
    }
    return value;
}

/** The parsed flags as the board client's filters, refusing a bad enum or limit. */
export function taskListFilters(
    values: Partial<Record<keyof typeof TASK_LIST_OPTIONS, string>>
): Parameters<BoardClient['listTasks']>[0] {
    return {
        state: parseChoice('state', values.state, TASK_STATES),
        q: values.q,
        author: values.author,
        repo: values.repo,
        sort: parseChoice('sort', values.sort, TASK_SORTS),
        limit: parseTaskLimit(values.limit),
        cursor: values.cursor,
    };
}
