import type { PreflightSelection } from './diagnostics.js';
import { UsageError } from './input.js';
import { USAGE } from './usage.js';

/**
 * The scope an executor selection names (issue 391). Absent sends nothing — the board defaults to
 * the author's personal profiles — and anything outside the pair is a usage error before any
 * request, the way a misspelled flag is.
 */
function parseExecutorScope(raw: string | undefined): 'user' | 'org' | undefined {
    if (raw === undefined) return undefined;
    if (raw !== 'user' && raw !== 'org') {
        throw new UsageError(`--executor-scope must be "user" or "org", got "${raw}"\n\n${USAGE}`);
    }
    return raw;
}

/** The selection flags a create and its preflight share: what to run against, never what to run. */
export const SELECTION_OPTIONS = {
    repo: { type: 'string' },
    executor: { type: 'string' },
    'executor-scope': { type: 'string' },
    skill: { type: 'string', multiple: true },
    connection: { type: 'string', multiple: true },
} as const;

export function selectionOf(values: {
    repo?: string | undefined;
    executor?: string | undefined;
    'executor-scope'?: string | undefined;
    skill?: string[] | undefined;
    connection?: string[] | undefined;
}): PreflightSelection {
    return {
        repo: values.repo,
        executor: values.executor,
        executorScope: parseExecutorScope(values['executor-scope']),
        skills: values.skill,
        // The board authorizes each against the author; a connection that is not theirs is its 403.
        connections: values.connection,
    };
}
