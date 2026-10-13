/**
 * The batch plan contract (v1): ordered stages of parallel tasks across one or more repository
 * targets, and the pure, side-effect-free validation, resolution and capability checks the board and its clients
 * share. Structural validity is independent of what the executors can run today — a plan with
 * tasks in two repositories is valid, persists and round-trips; `batchExecutionCapability` is the
 * separate, narrower question of what start accepts. Stage order is the only dependency model, so
 * an unknown field (a `dependsOn` above all) is refused rather than ignored.
 */

import { EXECUTOR_SCOPES, type ExecutorScope, USER_SCOPE } from './executors.js';

export const BATCH_PLAN_VERSION = 1;

export const BATCH_POLICIES = ['automerge', 'human'] as const;
export type BatchPolicy = (typeof BATCH_POLICIES)[number];
export const DEFAULT_BATCH_POLICY: BatchPolicy = 'human';

export const BATCH_COMPLETION_PR = 'pr';
export const BATCH_COMPLETION_ACCEPTED = 'accepted';

/** Stable identifiers: targets, stages and tasks are addressed by these, never by position. */
export const BATCH_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const BATCH_KEY_LIMIT = 40;
export const BATCH_TITLE_LIMIT = 200;
export const BATCH_TEXT_LIMIT = 4000;
export const BATCH_REPO_LIMIT = 201;
export const BATCH_BRANCH_LIMIT = 255;
export const BATCH_EXECUTOR_LIMIT = 100;
export const MAX_BATCH_TARGETS = 10;
export const MAX_BATCH_STAGES = 20;
export const MAX_STAGE_TASKS = 20;
export const MAX_BATCH_TASKS = 100;
export const MIN_BATCH_CONCURRENCY = 1;
export const MAX_BATCH_CONCURRENCY = 20;
export const DEFAULT_BATCH_CONCURRENCY = 1;
/** Recovery budgets (docs/batches.md): automatic infrastructure retries and agent repairs per task, and the batch's elapsed-time limit. */
export const MIN_BATCH_RETRY_BUDGET = 0;
export const MAX_BATCH_RETRY_BUDGET = 5;
export const DEFAULT_BATCH_INFRA_RETRIES = 2;
export const DEFAULT_BATCH_REPAIRS = 2;
export const MIN_BATCH_TIME_LIMIT_MINUTES = 1;
export const MAX_BATCH_TIME_LIMIT_MINUTES = 1440;
export const DEFAULT_BATCH_TIME_LIMIT_MINUTES = 720;

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export type BatchCompletion =
    | { kind: typeof BATCH_COMPLETION_PR }
    | { kind: typeof BATCH_COMPLETION_ACCEPTED; condition: string };

export interface BatchTarget {
    key: string;
    repo: string;
    /** Omitted means the repository's default branch, resolved to a name at freeze. */
    branch?: string;
}

export interface BatchTask {
    key: string;
    /** Omitted means the batch's `defaultTarget`. */
    target?: string;
    executor?: string;
    /** Whose executor profile `executor` names; omitted means the batch's, else `user`. */
    executorScope?: ExecutorScope;
    objective: string;
    acceptance: string;
    verification: string;
    required: boolean;
    completion: BatchCompletion;
}

export interface BatchStage {
    key: string;
    policy?: BatchPolicy;
    tasks: BatchTask[];
}

export interface BatchPlan {
    planVersion: typeof BATCH_PLAN_VERSION;
    title: string;
    targets: BatchTarget[];
    defaultTarget?: string;
    /** The task default. */
    executor?: string;
    /** The task default for `executorScope`. */
    executorScope?: ExecutorScope;
    policy: BatchPolicy;
    concurrency: number;
    /** Automatic retries per task after an infrastructure failure. */
    infraRetries: number;
    /** Automatic agent repairs per task after a failed check, stale branch or conflict. */
    repairs: number;
    /** Elapsed minutes from start after which nothing new dispatches. */
    timeLimitMinutes: number;
    stages: BatchStage[];
}

/** A plan at freeze: every target names its branch, every task its target, stage, executor and scope. */
export interface ResolvedBatchPlan extends Omit<BatchPlan, 'targets' | 'stages'> {
    targets: (BatchTarget & { branch: string })[];
    stages: (Omit<BatchStage, 'policy' | 'tasks'> & {
        policy: BatchPolicy;
        tasks: (Omit<BatchTask, 'target' | 'executor' | 'executorScope'> & {
            target: string;
            executor: string | null;
            executorScope: ExecutorScope;
        })[];
    })[];
}

export interface BatchPlanIssue {
    /** Where in the document, e.g. `stages[0].tasks[1].target`. Empty for the document itself. */
    path: string;
    message: string;
}

export type BatchPlanResult = { ok: true; plan: BatchPlan } | { ok: false; issues: BatchPlanIssue[] };

/*
 * The reader below records every problem it finds and keeps going, so one call reports them all;
 * it builds values optimistically and `validateBatchPlan` only hands them out when no issue was
 * recorded. A `!` on a field therefore reads "refused already, never observed".
 */

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

class Issues {
    readonly list: BatchPlanIssue[] = [];
    add(path: string, message: string): void {
        this.list.push({ path, message });
    }
}

/** The keys seen so far in one namespace, refusing a repeat. */
class UniqueKeys {
    private readonly seen = new Set<string>();
    constructor(
        private readonly what: string,
        private readonly issues: Issues
    ) {}
    track(value: string | undefined, path: string): void {
        if (value === undefined) return;
        if (this.seen.has(value)) this.issues.add(path, `duplicate ${this.what} key "${value}"`);
        this.seen.add(value);
    }
}

function refuseUnknown(raw: Raw, known: readonly string[], path: string, issues: Issues): void {
    for (const field of Object.keys(raw)) {
        if (!known.includes(field)) {
            issues.add(path ? `${path}.${field}` : field, `unknown field "${field}"`);
        }
    }
}

function text(raw: unknown, path: string, limit: number, issues: Issues): string | undefined {
    if (typeof raw !== 'string' || raw.trim() === '') {
        issues.add(path, 'must be a non-empty string');
        return undefined;
    }
    if (raw.length > limit) {
        issues.add(path, `must be at most ${limit} characters`);
        return undefined;
    }
    return raw;
}

function optionalText(raw: unknown, path: string, limit: number, issues: Issues): string | undefined {
    return raw === undefined ? undefined : text(raw, path, limit, issues);
}

function key(raw: unknown, path: string, issues: Issues): string | undefined {
    if (typeof raw !== 'string' || raw.length > BATCH_KEY_LIMIT || !BATCH_KEY_PATTERN.test(raw)) {
        issues.add(
            path,
            `must be a key of at most ${BATCH_KEY_LIMIT} lowercase letters, digits and hyphens, starting with a letter or digit`
        );
        return undefined;
    }
    return raw;
}

function optionalKey(raw: unknown, path: string, issues: Issues): string | undefined {
    return raw === undefined ? undefined : key(raw, path, issues);
}

function optionalScope(raw: unknown, path: string, issues: Issues): ExecutorScope | undefined {
    if (raw === undefined) return undefined;
    if (EXECUTOR_SCOPES.includes(raw as ExecutorScope)) return raw as ExecutorScope;
    issues.add(path, `must be one of: ${EXECUTOR_SCOPES.join(', ')}`);
    return undefined;
}

function policy(raw: unknown, path: string, issues: Issues): BatchPolicy | undefined {
    if (!BATCH_POLICIES.includes(raw as BatchPolicy)) {
        issues.add(path, `must be one of: ${BATCH_POLICIES.join(', ')}`);
        return undefined;
    }
    return raw as BatchPolicy;
}

/** An array within bounds, or empty once refused. Empty is refused: a plan has no empty parts. */
function list(raw: unknown, path: string, max: number, issues: Issues): unknown[] {
    if (!Array.isArray(raw)) {
        issues.add(path, 'must be an array');
        return [];
    }
    if (raw.length === 0) {
        issues.add(path, 'must not be empty');
        return [];
    }
    if (raw.length > max) {
        issues.add(path, `must hold at most ${max} entries`);
        return [];
    }
    return raw;
}

/** The object at `path`, with its unknown fields refused; undefined (and refused) for anything else. */
function objectAt(raw: unknown, known: readonly string[], path: string, issues: Issues): Raw | undefined {
    if (!isObject(raw)) {
        issues.add(path, 'must be an object');
        return undefined;
    }
    refuseUnknown(raw, known, path, issues);
    return raw;
}

const TARGET_FIELDS = ['key', 'repo', 'branch'];
const COMPLETION_FIELDS = ['kind', 'condition'];
const TASK_FIELDS = [
    'key',
    'target',
    'executor',
    'executorScope',
    'objective',
    'acceptance',
    'verification',
    'required',
    'completion',
];
const STAGE_FIELDS = ['key', 'policy', 'tasks'];
const PLAN_FIELDS = [
    'planVersion',
    'title',
    'targets',
    'defaultTarget',
    'executor',
    'executorScope',
    'policy',
    'concurrency',
    'infraRetries',
    'repairs',
    'timeLimitMinutes',
    'stages',
];

function parseTarget(raw: unknown, path: string, issues: Issues): BatchTarget | undefined {
    const fields = objectAt(raw, TARGET_FIELDS, path, issues);
    if (!fields) return undefined;
    const targetKey = key(fields.key, `${path}.key`, issues);
    if (typeof fields.repo !== 'string' || fields.repo.length > BATCH_REPO_LIMIT || !REPO_PATTERN.test(fields.repo)) {
        issues.add(`${path}.repo`, 'must be owner/name');
    }
    const branch = optionalText(fields.branch, `${path}.branch`, BATCH_BRANCH_LIMIT, issues);
    return { key: targetKey!, repo: fields.repo as string, ...(branch === undefined ? {} : { branch }) };
}

function parseCompletion(raw: unknown, path: string, issues: Issues): BatchCompletion {
    if (raw === undefined) return { kind: BATCH_COMPLETION_PR };
    const fields = objectAt(raw, COMPLETION_FIELDS, path, issues);
    if (fields?.kind === BATCH_COMPLETION_ACCEPTED) {
        const condition = text(fields.condition, `${path}.condition`, BATCH_TEXT_LIMIT, issues);
        return { kind: BATCH_COMPLETION_ACCEPTED, condition: condition! };
    }
    if (fields?.kind === BATCH_COMPLETION_PR) {
        if (fields.condition !== undefined) issues.add(`${path}.condition`, 'only an "accepted" completion has one');
    } else if (fields) {
        issues.add(`${path}.kind`, `must be "${BATCH_COMPLETION_PR}" or "${BATCH_COMPLETION_ACCEPTED}"`);
    }
    return { kind: BATCH_COMPLETION_PR };
}

function parseRequired(raw: unknown, path: string, issues: Issues): boolean {
    if (raw === undefined) return true;
    if (typeof raw === 'boolean') return raw;
    issues.add(path, 'must be a boolean');
    return true;
}

function parseTask(raw: unknown, path: string, issues: Issues): BatchTask | undefined {
    const fields = objectAt(raw, TASK_FIELDS, path, issues);
    if (!fields) return undefined;
    const target = optionalKey(fields.target, `${path}.target`, issues);
    const executor = optionalText(fields.executor, `${path}.executor`, BATCH_EXECUTOR_LIMIT, issues);
    const executorScope = optionalScope(fields.executorScope, `${path}.executorScope`, issues);
    return {
        key: key(fields.key, `${path}.key`, issues)!,
        ...(target === undefined ? {} : { target }),
        ...(executor === undefined ? {} : { executor }),
        ...(executorScope === undefined ? {} : { executorScope }),
        objective: text(fields.objective, `${path}.objective`, BATCH_TEXT_LIMIT, issues)!,
        acceptance: text(fields.acceptance, `${path}.acceptance`, BATCH_TEXT_LIMIT, issues)!,
        verification: text(fields.verification, `${path}.verification`, BATCH_TEXT_LIMIT, issues)!,
        required: parseRequired(fields.required, `${path}.required`, issues),
        completion: parseCompletion(fields.completion, `${path}.completion`, issues),
    };
}

function parseStage(raw: unknown, path: string, taskKeys: UniqueKeys, issues: Issues): BatchStage | undefined {
    const fields = objectAt(raw, STAGE_FIELDS, path, issues);
    if (!fields) return undefined;
    const stagePolicy = fields.policy === undefined ? undefined : policy(fields.policy, `${path}.policy`, issues);
    const tasks: BatchTask[] = [];
    for (const [index, rawTask] of list(fields.tasks, `${path}.tasks`, MAX_STAGE_TASKS, issues).entries()) {
        const task = parseTask(rawTask, `${path}.tasks[${index}]`, issues);
        // The key is unique across the whole batch, not only the stage.
        taskKeys.track(task?.key, `${path}.tasks[${index}].key`);
        if (task) tasks.push(task);
    }
    return {
        key: key(fields.key, `${path}.key`, issues)!,
        ...(stagePolicy === undefined ? {} : { policy: stagePolicy }),
        tasks,
    };
}

function parseTargets(raw: unknown, issues: Issues): BatchTarget[] {
    const keys = new UniqueKeys('target', issues);
    const targets: BatchTarget[] = [];
    for (const [index, rawTarget] of list(raw, 'targets', MAX_BATCH_TARGETS, issues).entries()) {
        const target = parseTarget(rawTarget, `targets[${index}]`, issues);
        keys.track(target?.key, `targets[${index}].key`);
        if (target) targets.push(target);
    }
    return targets;
}

function parseStages(raw: unknown, issues: Issues): BatchStage[] {
    const stageKeys = new UniqueKeys('stage', issues);
    const taskKeys = new UniqueKeys('task', issues);
    const stages: BatchStage[] = [];
    for (const [index, rawStage] of list(raw, 'stages', MAX_BATCH_STAGES, issues).entries()) {
        const stage = parseStage(rawStage, `stages[${index}]`, taskKeys, issues);
        stageKeys.track(stage?.key, `stages[${index}].key`);
        if (stage) stages.push(stage);
    }
    if (stages.reduce((count, stage) => count + stage.tasks.length, 0) > MAX_BATCH_TASKS) {
        issues.add('stages', `must hold at most ${MAX_BATCH_TASKS} tasks in all`);
    }
    return stages;
}

/** A whole number within bounds, or the default once omitted or refused. */
function boundedInt(
    raw: unknown,
    field: { path: string; min: number; max: number; fallback: number },
    issues: Issues
): number {
    if (raw === undefined) return field.fallback;
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= field.min && raw <= field.max) return raw;
    issues.add(field.path, `must be a whole number from ${field.min} to ${field.max}`);
    return field.fallback;
}

/** Targets referenced by the plan, checked once the whole document has been read. */
function checkTargetReferences(plan: BatchPlan, issues: Issues): void {
    // No targets means the list itself was refused; naming one of them would only echo that.
    if (plan.targets.length === 0) return;
    const keys = new Set(plan.targets.map((target) => target.key));
    if (plan.defaultTarget !== undefined && !keys.has(plan.defaultTarget)) {
        issues.add('defaultTarget', `names no target: "${plan.defaultTarget}"`);
    }
    for (const [stageIndex, stage] of plan.stages.entries()) {
        for (const [taskIndex, task] of stage.tasks.entries()) {
            const path = `stages[${stageIndex}].tasks[${taskIndex}].target`;
            const named = task.target ?? plan.defaultTarget;
            if (named === undefined) issues.add(path, 'is required when the batch has no defaultTarget');
            else if (task.target !== undefined && !keys.has(named)) issues.add(path, `names no target: "${named}"`);
        }
    }
}

/** A scope names whose profile an executor is: one with no executor anywhere to apply to is refused. */
function checkExecutorScopes(plan: BatchPlan, issues: Issues): void {
    const tasks = plan.stages.flatMap((stage, stageIndex) =>
        stage.tasks.map((task, taskIndex) => ({ task, path: `stages[${stageIndex}].tasks[${taskIndex}]` }))
    );
    if (plan.executorScope !== undefined && plan.executor === undefined && !tasks.some(({ task }) => task.executor)) {
        issues.add('executorScope', 'names a scope, but no executor in the plan names a profile');
    }
    for (const { task, path } of tasks) {
        if (task.executorScope !== undefined && task.executor === undefined && plan.executor === undefined) {
            issues.add(`${path}.executorScope`, 'names a scope, but neither the task nor the batch names an executor');
        }
    }
}

/**
 * Reads a plan document. On success the plan is normalized — defaults filled in (`policy`,
 * `concurrency`, `required`, `completion`) — so what is stored and echoed back is one shape.
 * Never throws: every problem is a path-addressed issue.
 */
export function validateBatchPlan(raw: unknown): BatchPlanResult {
    const issues = new Issues();
    const fields = objectAt(raw, PLAN_FIELDS, '', issues);
    if (!fields) return { ok: false, issues: [{ path: '', message: 'a plan must be a JSON object' }] };
    if (fields.planVersion !== BATCH_PLAN_VERSION) issues.add('planVersion', `must be ${BATCH_PLAN_VERSION}`);
    const defaultTarget = optionalKey(fields.defaultTarget, 'defaultTarget', issues);
    const executor = optionalText(fields.executor, 'executor', BATCH_EXECUTOR_LIMIT, issues);
    const executorScope = optionalScope(fields.executorScope, 'executorScope', issues);
    const plan: BatchPlan = {
        planVersion: BATCH_PLAN_VERSION,
        title: text(fields.title, 'title', BATCH_TITLE_LIMIT, issues)!,
        targets: parseTargets(fields.targets, issues),
        ...(defaultTarget === undefined ? {} : { defaultTarget }),
        ...(executor === undefined ? {} : { executor }),
        ...(executorScope === undefined ? {} : { executorScope }),
        policy: fields.policy === undefined ? DEFAULT_BATCH_POLICY : policy(fields.policy, 'policy', issues)!,
        concurrency: boundedInt(
            fields.concurrency,
            {
                path: 'concurrency',
                min: MIN_BATCH_CONCURRENCY,
                max: MAX_BATCH_CONCURRENCY,
                fallback: DEFAULT_BATCH_CONCURRENCY,
            },
            issues
        ),
        infraRetries: boundedInt(
            fields.infraRetries,
            {
                path: 'infraRetries',
                min: MIN_BATCH_RETRY_BUDGET,
                max: MAX_BATCH_RETRY_BUDGET,
                fallback: DEFAULT_BATCH_INFRA_RETRIES,
            },
            issues
        ),
        repairs: boundedInt(
            fields.repairs,
            {
                path: 'repairs',
                min: MIN_BATCH_RETRY_BUDGET,
                max: MAX_BATCH_RETRY_BUDGET,
                fallback: DEFAULT_BATCH_REPAIRS,
            },
            issues
        ),
        timeLimitMinutes: boundedInt(
            fields.timeLimitMinutes,
            {
                path: 'timeLimitMinutes',
                min: MIN_BATCH_TIME_LIMIT_MINUTES,
                max: MAX_BATCH_TIME_LIMIT_MINUTES,
                fallback: DEFAULT_BATCH_TIME_LIMIT_MINUTES,
            },
            issues
        ),
        stages: parseStages(fields.stages, issues),
    };
    checkTargetReferences(plan, issues);
    checkExecutorScopes(plan, issues);
    return issues.list.length > 0 ? { ok: false, issues: issues.list } : { ok: true, plan };
}

/** `owner/name` → the default branch the repository answers with, for the repos the plan names. */
export type DefaultBranches = Readonly<Record<string, string>>;

/**
 * The plan as freeze writes it: an omitted branch becomes the repository's default, an omitted
 * task target the `defaultTarget`, a stage without a policy the batch's, a task without an
 * executor the batch's (or null — the claim's own default), and its scope the task's, else the
 * batch's, else `user` (always `user` beside a null executor). `defaults` must hold every target's
 * repository; the caller refuses a repository with no default branch before getting here.
 */
export function resolveBatchPlan(plan: BatchPlan, defaults: DefaultBranches): ResolvedBatchPlan {
    return {
        ...plan,
        targets: plan.targets.map((target) => ({ ...target, branch: target.branch ?? defaults[target.repo]! })),
        stages: plan.stages.map((stage) => ({
            ...stage,
            policy: stage.policy ?? plan.policy,
            tasks: stage.tasks.map((task) => {
                const executor = task.executor ?? plan.executor ?? null;
                return {
                    ...task,
                    target: task.target ?? plan.defaultTarget!,
                    executor,
                    executorScope:
                        executor === null ? USER_SCOPE : (task.executorScope ?? plan.executorScope ?? USER_SCOPE),
                };
            }),
        })),
    };
}

export const MULTI_TARGET = 'multi_target';
export const NON_DEFAULT_BRANCH = 'non_default_branch';
export const AUTOMERGE = 'automerge';
export const BATCH_UNSUPPORTED_REASONS = [MULTI_TARGET, NON_DEFAULT_BRANCH, AUTOMERGE] as const;
export type BatchUnsupportedReason = (typeof BATCH_UNSUPPORTED_REASONS)[number];

export type BatchCapability = { ok: true } | { ok: false; reason: BatchUnsupportedReason; message: string };

/** What the board running the batch can do beyond running tasks. */
export interface BoardCapabilities {
    /** The board holds a GitHub installation it can merge through; offline it cannot. */
    canMerge: boolean;
}

/**
 * What the executors and the board can run today, separate from whether a plan is valid: one
 * (repo, branch) pair across the targets the tasks use, and that branch the repository's default
 * — executors base every job on `origin/HEAD`. Takes a resolved plan, so the branches are names;
 * `defaults` is what decides whether one of them is the default. An automerge stage needs a board
 * that can merge.
 */
export function batchExecutionCapability(
    plan: ResolvedBatchPlan,
    defaults: DefaultBranches,
    board: BoardCapabilities
): BatchCapability {
    const used = new Set(plan.stages.flatMap((stage) => stage.tasks.map((task) => task.target)));
    const pairs = new Set(
        plan.targets.filter((target) => used.has(target.key)).map((target) => `${target.repo}\u0000${target.branch}`)
    );
    if (pairs.size > 1) {
        return {
            ok: false,
            reason: MULTI_TARGET,
            message: 'A batch runs against one repository and branch for now; this plan uses more than one',
        };
    }
    const offDefault = plan.targets.find((target) => used.has(target.key) && defaults[target.repo] !== target.branch);
    if (offDefault) {
        return {
            ok: false,
            reason: NON_DEFAULT_BRANCH,
            message: `Tasks run on the repository's default branch for now; "${offDefault.key}" names ${offDefault.branch}`,
        };
    }
    if (!board.canMerge && plan.stages.some((stage) => stage.policy === AUTOMERGE)) {
        return {
            ok: false,
            reason: AUTOMERGE,
            message: 'This board has no GitHub installation to merge through; every stage must use the "human" policy',
        };
    }
    return { ok: true };
}
