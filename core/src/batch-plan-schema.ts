import {
    BATCH_BRANCH_LIMIT,
    BATCH_COMPLETION_ACCEPTED,
    BATCH_COMPLETION_PR,
    BATCH_EXECUTOR_LIMIT,
    BATCH_KEY_LIMIT,
    BATCH_KEY_PATTERN,
    BATCH_PLAN_VERSION,
    BATCH_POLICIES,
    BATCH_REPO_LIMIT,
    BATCH_REPO_PATTERN,
    BATCH_TEXT_LIMIT,
    BATCH_TITLE_LIMIT,
    DEFAULT_BATCH_CONCURRENCY,
    DEFAULT_BATCH_INFRA_RETRIES,
    DEFAULT_BATCH_POLICY,
    DEFAULT_BATCH_REPAIRS,
    DEFAULT_BATCH_TIME_LIMIT_MINUTES,
    MAX_BATCH_CONCURRENCY,
    MAX_BATCH_RETRY_BUDGET,
    MAX_BATCH_STAGES,
    MAX_BATCH_TARGETS,
    MAX_BATCH_TASKS,
    MAX_BATCH_TIME_LIMIT_MINUTES,
    MAX_STAGE_TASKS,
    MIN_BATCH_CONCURRENCY,
    MIN_BATCH_RETRY_BUDGET,
    MIN_BATCH_TIME_LIMIT_MINUTES,
} from './batch-plan.js';
import { BRANCH_NAME_PATTERN } from './branch-name.js';
import { EXECUTOR_SCOPES } from './executors.js';

/**
 * The batch plan (`batch-plan.ts`) as a plain JSON Schema, for clients that need to write one before the board reads it.
 * Every bound and pattern comes from the constants the parser uses. `validateBatchPlan` stays the authority:
 * the schema states what JSON Schema can, and `core/test/batch-plan-schema.test.ts` pins the two together.
 */

/** A string the parser reads as text: non-empty once trimmed, at most `max` characters. */
const text = (max: number): Record<string, unknown> => ({ type: 'string', pattern: '\\S', maxLength: max });

const key: Record<string, unknown> = {
    type: 'string',
    pattern: BATCH_KEY_PATTERN.source,
    maxLength: BATCH_KEY_LIMIT,
    description: 'A stable identifier: lowercase letters, digits and hyphens, starting with a letter or digit.',
};

const scope: Record<string, unknown> = { enum: [...EXECUTOR_SCOPES] };

const bounded = (min: number, max: number, fallback: number): Record<string, unknown> => ({
    type: 'integer',
    minimum: min,
    maximum: max,
    default: fallback,
});

const target: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['key', 'repo'],
    properties: {
        key,
        repo: {
            type: 'string',
            pattern: BATCH_REPO_PATTERN.source,
            maxLength: BATCH_REPO_LIMIT,
            description: 'owner/name',
        },
        branch: {
            type: 'string',
            pattern: `^(?!.*\\.\\.)${BRANCH_NAME_PATTERN.source.slice(1)}`,
            maxLength: BATCH_BRANCH_LIMIT,
            description: "Omitted means the repository's default branch.",
        },
    },
};

const completion: Record<string, unknown> = {
    description: `Omitted means {"kind": "${BATCH_COMPLETION_PR}"}: the task's gate is its merged PR.`,
    oneOf: [
        {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: { kind: { const: BATCH_COMPLETION_PR } },
        },
        {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'condition'],
            properties: { kind: { const: BATCH_COMPLETION_ACCEPTED }, condition: text(BATCH_TEXT_LIMIT) },
        },
    ],
};

const task: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['key', 'objective', 'acceptance', 'verification'],
    properties: {
        key,
        target: { ...key, description: "A target's key; omitted means the plan's defaultTarget." },
        executor: { ...text(BATCH_EXECUTOR_LIMIT), description: "Omitted means the plan's executor." },
        executorScope: { ...scope, description: 'Whose executor profile `executor` names.' },
        objective: text(BATCH_TEXT_LIMIT),
        acceptance: text(BATCH_TEXT_LIMIT),
        verification: text(BATCH_TEXT_LIMIT),
        required: { type: 'boolean', default: true },
        completion,
    },
};

const stage: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['key', 'tasks'],
    properties: {
        key,
        policy: { enum: [...BATCH_POLICIES], description: "Omitted means the plan's policy." },
        tasks: { type: 'array', minItems: 1, maxItems: MAX_STAGE_TASKS, items: task },
    },
};

export const BATCH_PLAN_JSON_SCHEMA: Record<string, unknown> = {
    title: 'Batch plan',
    description:
        'Ordered stages of parallel tasks across one or more repository targets; stage order is the only dependency model. ' +
        'JSON Schema cannot state these rules, which the board still enforces: target, stage and task keys are unique ' +
        '(a task key across the whole batch); defaultTarget and every task target name a declared target, and a task ' +
        'with no target needs a defaultTarget; executorScope needs an executor to apply to; the plan holds at most ' +
        `${MAX_BATCH_TASKS} tasks in all; lengths count UTF-16 units.`,
    type: 'object',
    additionalProperties: false,
    required: ['planVersion', 'title', 'targets', 'stages'],
    properties: {
        planVersion: { const: BATCH_PLAN_VERSION },
        title: text(BATCH_TITLE_LIMIT),
        targets: { type: 'array', minItems: 1, maxItems: MAX_BATCH_TARGETS, items: target },
        defaultTarget: { ...key, description: 'The target of every task that names none.' },
        executor: { ...text(BATCH_EXECUTOR_LIMIT), description: 'The default executor profile of a task.' },
        executorScope: { ...scope, description: 'The default executorScope of a task.' },
        policy: { enum: [...BATCH_POLICIES], default: DEFAULT_BATCH_POLICY },
        concurrency: bounded(MIN_BATCH_CONCURRENCY, MAX_BATCH_CONCURRENCY, DEFAULT_BATCH_CONCURRENCY),
        infraRetries: bounded(MIN_BATCH_RETRY_BUDGET, MAX_BATCH_RETRY_BUDGET, DEFAULT_BATCH_INFRA_RETRIES),
        repairs: bounded(MIN_BATCH_RETRY_BUDGET, MAX_BATCH_RETRY_BUDGET, DEFAULT_BATCH_REPAIRS),
        timeLimitMinutes: bounded(
            MIN_BATCH_TIME_LIMIT_MINUTES,
            MAX_BATCH_TIME_LIMIT_MINUTES,
            DEFAULT_BATCH_TIME_LIMIT_MINUTES
        ),
        stages: { type: 'array', minItems: 1, maxItems: MAX_BATCH_STAGES, items: stage },
    },
};
