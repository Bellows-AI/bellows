import { DEFAULT_GATE_FIX_ROUNDS, ERROR_CODES, EXECUTOR_TYPES, MAX_GATE_FIX_ROUNDS } from '@factory-ai/core';
import type { ErrorCode } from '@factory-ai/core';

/**
 * A ceiling on how many executors one person can configure, and (issue 391) on how many
 * organization profiles one organization can hold. Like MAX_REPOS_PER_USER, not a policy about
 * what anybody needs — just the bound that keeps one pasted list from growing without limit.
 */
export const MAX_EXECUTORS_PER_USER = 10;

export const MAX_EXECUTORS_PER_ORG = 10;

/**
 * The one validated executor entry both the personal whole-list PUT and the organization CRUD
 * routes accept (issue 391). Scope and ownership are NOT fields here — they are decided by the
 * route that parses them: the personal PUT writes the caller's rows, the org routes write the
 * organization's, and an entry pretending otherwise is refused before storage, not rewritten.
 */
export interface ExecutorFields {
    name: string;
    type: string;
    config: Record<string, unknown>;
    gateFixRounds: number;
    /** The runner class the profile runs in; null is the driver's default. Checked against the board's classes by the route. */
    runnerClass: string | null;
}

/** A runner-class refusal answers 422: the body is well formed, the class is not one this board offers. */
export const HTTP_UNPROCESSABLE = 422;

/** The refusal codes a `parseExecutorFields` message can name, in one map for both routes. */
export function executorFieldRefusal(message: string): ErrorCode {
    if (message.startsWith('at most')) return ERROR_CODES.TOO_MANY_EXECUTORS;
    if (message.startsWith('unknown executor type')) return ERROR_CODES.BAD_EXECUTOR_TYPE;
    if (message.startsWith('gateFixRounds')) return ERROR_CODES.BAD_EXECUTOR_ROUNDS;
    if (message.startsWith('runnerClass')) return ERROR_CODES.BAD_RUNNER_CLASS;
    return ERROR_CODES.BAD_BODY;
}

/**
 * One entry's gate-repair round limit: optional, a whole number in 0..10, the code
 * default when absent. A refusal message starts with `gateFixRounds` so the code mapping can name
 * it — the same prefix convention the executor-type refusal uses.
 */
function parseGateFixRounds(item: { name?: unknown; gateFixRounds?: unknown }): number | string {
    if (item.gateFixRounds === undefined) return DEFAULT_GATE_FIX_ROUNDS;
    const rounds = item.gateFixRounds;
    if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 0 || rounds > MAX_GATE_FIX_ROUNDS) {
        return `gateFixRounds for "${item.name}" must be a whole number between 0 and ${MAX_GATE_FIX_ROUNDS}`;
    }
    return rounds;
}

/** The status a `parseExecutorFields` refusal answers with: 422 for a runner class, 400 otherwise. */
export function executorFieldStatus(message: string): number | undefined {
    return message.startsWith('runnerClass') ? HTTP_UNPROCESSABLE : undefined;
}

/**
 * The org routes' runner-class rule: null, or a class this board declares (RUNNER_CLASSES). A refusal
 * names the field and the declared classes; a board declaring none refuses every class.
 */
export function orgRunnerClassRefusal(
    runnerClass: string | null,
    declared: readonly { name: string }[]
): string | null {
    if (runnerClass === null || declared.some((option) => option.name === runnerClass)) return null;
    const names = declared.map((option) => option.name).join(', ');
    return `runnerClass "${runnerClass}" is not a runner class this board declares (${names ? `declared: ${names}` : 'it declares none'})`;
}

/** The personal route's rule: a runner class is an organization admin's choice, on organization profiles only. */
export function personalRunnerClassRefusal(runnerClass: string | null): string | null {
    return runnerClass === null
        ? null
        : 'runnerClass is set on organization profiles only, by an organization admin; a personal profile runs in the default class';
}

/**
 * The fields every executor payload entry carries: the name/type/config shape, the known type and
 * the round limit. A string return is the refusal message; the caller stops at the first.
 */
export function parseExecutorFields(entry: unknown): ExecutorFields | string {
    const item = entry as {
        name?: unknown;
        type?: unknown;
        config?: unknown;
        gateFixRounds?: unknown;
        runnerClass?: unknown;
    };
    if (typeof item?.name !== 'string' || typeof item?.type !== 'string') {
        return 'each entry must be { name: string, type: string, config: object }';
    }
    if (typeof item.config !== 'object' || item.config === null || Array.isArray(item.config)) {
        return `config for "${item.name}" must be a JSON object`;
    }
    if (!(EXECUTOR_TYPES as readonly string[]).includes(item.type)) {
        return `unknown executor type "${item.type}" (known: ${EXECUTOR_TYPES.join(', ')})`;
    }
    const gateFixRounds = parseGateFixRounds(item);
    if (typeof gateFixRounds === 'string') return gateFixRounds;
    // Optional, absent meaning null: the driver's default class. The route decides which names it takes.
    const runnerClass = item.runnerClass ?? null;
    if (runnerClass !== null && typeof runnerClass !== 'string') {
        return `runnerClass for "${item.name}" must be a runner class name or null`;
    }
    return {
        name: item.name,
        type: item.type,
        config: item.config as Record<string, unknown>,
        gateFixRounds,
        runnerClass,
    };
}
