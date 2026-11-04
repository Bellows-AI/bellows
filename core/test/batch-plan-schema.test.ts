import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import {
    BATCH_BRANCH_LIMIT,
    BATCH_EXECUTOR_LIMIT,
    BATCH_KEY_LIMIT,
    BATCH_REPO_LIMIT,
    BATCH_TEXT_LIMIT,
    BATCH_TITLE_LIMIT,
    MAX_BATCH_CONCURRENCY,
    MAX_BATCH_STAGES,
    MAX_BATCH_TARGETS,
    MAX_BATCH_TIME_LIMIT_MINUTES,
    MAX_BATCH_RETRY_BUDGET,
    MAX_STAGE_TASKS,
    validateBatchPlan,
} from '../src/batch-plan.js';
import { BATCH_PLAN_JSON_SCHEMA } from '../src/batch-plan-schema.js';

/**
 * The JSON Schema is pinned to the parser in `batch-plan.ts`: for every fixture below the schema and
 * the parser agree, except the rules JSON Schema cannot state (`LIMITS`), where the schema is looser
 * and the board's parser stays the authority.
 */

const ajv = new Ajv({ strict: true, allErrors: true });
const schemaAccepts = ajv.compile(BATCH_PLAN_JSON_SCHEMA);
const parserAccepts = (raw: unknown) => validateBatchPlan(raw).ok;

const task = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    objective: `do ${key}`,
    acceptance: 'it works',
    verification: 'npm test',
    ...extra,
});

const plan = (overrides: Record<string, unknown> = {}) => ({
    planVersion: 1,
    title: 'Upgrade',
    targets: [{ key: 'web', repo: 'acme/web' }],
    defaultTarget: 'web',
    stages: [{ key: 'one', tasks: [task('a')] }],
    ...overrides,
});

const withTask = (extra: Record<string, unknown>) => plan({ stages: [{ key: 'one', tasks: [task('a', extra)] }] });
const withTarget = (extra: Record<string, unknown>) => plan({ targets: [{ key: 'web', repo: 'acme/web', ...extra }] });
const withStage = (extra: Record<string, unknown>) => plan({ stages: [{ key: 'one', tasks: [task('a')], ...extra }] });
const numbered = (count: number, make: (n: number) => unknown) => Array.from({ length: count }, (_, n) => make(n));
const key = (n: number) => `k${n}`;

const ACCEPTED: [string, unknown][] = [
    ['a minimal plan', plan()],
    [
        'every optional field set',
        plan({
            executor: 'claude',
            executorScope: 'org',
            policy: 'automerge',
            concurrency: 3,
            infraRetries: 0,
            repairs: 5,
            timeLimitMinutes: 60,
            targets: [
                { key: 'web', repo: 'acme/web', branch: 'release/1.2' },
                { key: 'api', repo: 'acme/api.v2' },
            ],
            stages: [
                {
                    key: 'one',
                    policy: 'human',
                    tasks: [
                        task('a', { target: 'api', executor: 'fast', executorScope: 'user', required: false }),
                        task('b', { completion: { kind: 'pr' } }),
                    ],
                },
                { key: 'two', tasks: [task('c', { completion: { kind: 'accepted', condition: 'a person agrees' } })] },
            ],
        }),
    ],
    ['an accepted completion', withTask({ completion: { kind: 'accepted', condition: 'ok' } })],
    [
        'a plan whose tasks span two repositories',
        plan({
            targets: [
                { key: 'web', repo: 'acme/web' },
                { key: 'api', repo: 'acme/api' },
            ],
            stages: [{ key: 'one', tasks: [task('a'), task('b', { target: 'api' })] }],
        }),
    ],
    [
        'no defaultTarget when every task names a target',
        plan({ defaultTarget: undefined, stages: [{ key: 'one', tasks: [task('a', { target: 'web' })] }] }),
    ],
    [
        'the most targets',
        plan({
            targets: numbered(MAX_BATCH_TARGETS, (n) => ({ key: key(n), repo: 'acme/web' })),
            defaultTarget: key(0),
        }),
    ],
    [
        'the most stages',
        plan({ stages: numbered(MAX_BATCH_STAGES, (n) => ({ key: `s${n}`, tasks: [task(`t${n}`)] })) }),
    ],
    ['the most tasks in a stage', withStage({ tasks: numbered(MAX_STAGE_TASKS, (n) => task(`t${n}`)) })],
    ['the longest key', plan({ title: 'Upgrade', stages: [{ key: 'a'.repeat(BATCH_KEY_LIMIT), tasks: [task('a')] }] })],
    ['the longest title', plan({ title: 'x'.repeat(BATCH_TITLE_LIMIT) })],
    ['the longest task text', withTask({ objective: 'x'.repeat(BATCH_TEXT_LIMIT) })],
    ['the longest repo', withTarget({ repo: `${'a'.repeat(100)}/${'b'.repeat(BATCH_REPO_LIMIT - 101)}` })],
    ['the longest executor', plan({ executor: 'e'.repeat(BATCH_EXECUTOR_LIMIT), executorScope: 'org' })],
    ['the longest branch', withTarget({ branch: 'b'.repeat(BATCH_BRANCH_LIMIT) })],
    ['a branch with dots, slashes and hyphens', withTarget({ branch: 'feature/a_b-c.d' })],
    ['the highest concurrency', plan({ concurrency: MAX_BATCH_CONCURRENCY })],
    ['the highest time limit', plan({ timeLimitMinutes: MAX_BATCH_TIME_LIMIT_MINUTES })],
    ['the highest retry budgets', plan({ infraRetries: MAX_BATCH_RETRY_BUDGET, repairs: MAX_BATCH_RETRY_BUDGET })],
    ['multi-line, non-ASCII task text', withTask({ objective: 'line one\n  line two — ünïcødé 日本語' })],
];

const REJECTED: [string, unknown][] = [
    ['null', null],
    ['an array', []],
    ['a string', 'plan'],
    ['an empty object', {}],
    ['an unknown plan field', plan({ extra: 1 })],
    ['dependsOn on a task', withTask({ dependsOn: ['b'] })],
    ['an unknown target field', withTarget({ extra: 1 })],
    ['an unknown stage field', withStage({ extra: 1 })],
    ['an unknown completion field', withTask({ completion: { kind: 'pr', extra: 1 } })],
    ['no planVersion', plan({ planVersion: undefined })],
    ['planVersion 2', plan({ planVersion: 2 })],
    ['planVersion "1"', plan({ planVersion: '1' })],
    ['no title', plan({ title: undefined })],
    ['an empty title', plan({ title: '' })],
    ['a blank title', plan({ title: '   ' })],
    ['a numeric title', plan({ title: 7 })],
    ['a too long title', plan({ title: 'x'.repeat(BATCH_TITLE_LIMIT + 1) })],
    ['no targets', plan({ targets: undefined })],
    ['empty targets', plan({ targets: [] })],
    ['targets that are not an array', plan({ targets: { key: 'web' } })],
    [
        'too many targets',
        plan({ targets: numbered(MAX_BATCH_TARGETS + 1, (n) => ({ key: key(n), repo: 'acme/web' })) }),
    ],
    ['a target that is not an object', plan({ targets: ['acme/web'] })],
    ['a target with no key', plan({ targets: [{ repo: 'acme/web' }] })],
    ['an uppercase key', plan({ targets: [{ key: 'Web', repo: 'acme/web' }] })],
    ['a key starting with a hyphen', plan({ targets: [{ key: '-web', repo: 'acme/web' }] })],
    ['a too long key', plan({ stages: [{ key: 'a'.repeat(BATCH_KEY_LIMIT + 1), tasks: [task('a')] }] })],
    ['a numeric key', plan({ stages: [{ key: 1, tasks: [task('a')] }] })],
    ['a target with no repo', plan({ targets: [{ key: 'web' }] })],
    ['a repo with no owner', withTarget({ repo: 'web' })],
    ['a repo with three parts', withTarget({ repo: 'a/b/c' })],
    ['a repo with a space', withTarget({ repo: 'acme/my web' })],
    ['a too long repo', withTarget({ repo: `${'a'.repeat(100)}/${'b'.repeat(BATCH_REPO_LIMIT - 100)}` })],
    ['an empty branch', withTarget({ branch: '' })],
    ['a branch with ..', withTarget({ branch: 'a..b' })],
    ['a branch starting with a hyphen', withTarget({ branch: '-x' })],
    ['a branch with a space', withTarget({ branch: 'a b' })],
    ['a branch with a newline', withTarget({ branch: 'a\nb' })],
    ['a too long branch', withTarget({ branch: 'b'.repeat(BATCH_BRANCH_LIMIT + 1) })],
    ['no stages', plan({ stages: undefined })],
    ['empty stages', plan({ stages: [] })],
    [
        'too many stages',
        plan({ stages: numbered(MAX_BATCH_STAGES + 1, (n) => ({ key: `s${n}`, tasks: [task(`t${n}`)] })) }),
    ],
    ['a stage with no tasks', withStage({ tasks: undefined })],
    ['a stage with empty tasks', withStage({ tasks: [] })],
    ['too many tasks in a stage', withStage({ tasks: numbered(MAX_STAGE_TASKS + 1, (n) => task(`t${n}`)) })],
    ['a stage policy outside the pair', withStage({ policy: 'auto' })],
    ['a plan policy outside the pair', plan({ policy: 'auto' })],
    ['a task with no objective', withTask({ objective: undefined })],
    ['a task with no acceptance', withTask({ acceptance: undefined })],
    ['a task with no verification', withTask({ verification: undefined })],
    ['an empty objective', withTask({ objective: '' })],
    ['a blank acceptance', withTask({ acceptance: ' \n ' })],
    ['a too long verification', withTask({ verification: 'x'.repeat(BATCH_TEXT_LIMIT + 1) })],
    ['a non-boolean required', withTask({ required: 'yes' })],
    ['a task target that is not a key', withTask({ target: 'Web' })],
    ['an empty executor', withTask({ executor: '' })],
    ['a too long executor', withTask({ executor: 'e'.repeat(BATCH_EXECUTOR_LIMIT + 1) })],
    ['an executorScope outside the pair', plan({ executor: 'claude', executorScope: 'team' })],
    ['a task executorScope outside the pair', withTask({ executor: 'claude', executorScope: 'team' })],
    ['a completion kind outside the pair', withTask({ completion: { kind: 'merged' } })],
    ['a completion with no kind', withTask({ completion: {} })],
    ['an accepted completion with no condition', withTask({ completion: { kind: 'accepted' } })],
    ['an accepted completion with a blank condition', withTask({ completion: { kind: 'accepted', condition: ' ' } })],
    ['a pr completion with a condition', withTask({ completion: { kind: 'pr', condition: 'ok' } })],
    ['concurrency 0', plan({ concurrency: 0 })],
    ['concurrency one past the limit', plan({ concurrency: MAX_BATCH_CONCURRENCY + 1 })],
    ['a fractional concurrency', plan({ concurrency: 1.5 })],
    ['a string concurrency', plan({ concurrency: '2' })],
    ['a negative infraRetries', plan({ infraRetries: -1 })],
    ['repairs one past the limit', plan({ repairs: MAX_BATCH_RETRY_BUDGET + 1 })],
    ['a time limit of 0', plan({ timeLimitMinutes: 0 })],
    ['a time limit one past the limit', plan({ timeLimitMinutes: MAX_BATCH_TIME_LIMIT_MINUTES + 1 })],
];

/** Rules that span fields or the whole document, which JSON Schema cannot state: the parser refuses, the schema does not. */
const LIMITS: [string, unknown][] = [
    [
        'a duplicate target key',
        plan({
            targets: [
                { key: 'web', repo: 'acme/web' },
                { key: 'web', repo: 'acme/api' },
            ],
        }),
    ],
    [
        'a duplicate stage key',
        plan({
            stages: [
                { key: 'one', tasks: [task('a')] },
                { key: 'one', tasks: [task('b')] },
            ],
        }),
    ],
    [
        'a task key repeated across stages',
        plan({
            stages: [
                { key: 'one', tasks: [task('a')] },
                { key: 'two', tasks: [task('a')] },
            ],
        }),
    ],
    ['a defaultTarget naming no target', plan({ defaultTarget: 'nope' })],
    ['a task target naming no target', withTask({ target: 'nope' })],
    ['a task with no target and no defaultTarget', plan({ defaultTarget: undefined })],
    ['an executorScope with no executor anywhere', plan({ executorScope: 'org' })],
    ['a task executorScope with no executor', withTask({ executorScope: 'org' })],
    [
        'more tasks in all than the batch holds',
        plan({
            stages: numbered(6, (s) => ({ key: `s${s}`, tasks: numbered(MAX_STAGE_TASKS, (t) => task(`t${s}-${t}`)) })),
        }),
    ],
    [
        'a title over the limit in UTF-16 units but under it in code points',
        plan({ title: '😀'.repeat(BATCH_TITLE_LIMIT / 2 + 1) }),
    ],
];

describe('BATCH_PLAN_JSON_SCHEMA', () => {
    it('is plain JSON with no reference or draft marker a client has to resolve', () => {
        expect(JSON.parse(JSON.stringify(BATCH_PLAN_JSON_SCHEMA))).toEqual(BATCH_PLAN_JSON_SCHEMA);
        expect(Object.keys(BATCH_PLAN_JSON_SCHEMA).length).toBeGreaterThan(0);
        expect(JSON.stringify(BATCH_PLAN_JSON_SCHEMA)).not.toMatch(/\$ref|\$schema|\$id/);
    });

    it.each(ACCEPTED)('accepts what the parser accepts: %s', (_name, raw) => {
        expect(parserAccepts(raw)).toBe(true);
        expect(schemaAccepts(raw), JSON.stringify(schemaAccepts.errors)).toBe(true);
    });

    it.each(REJECTED)('refuses what the parser refuses: %s', (_name, raw) => {
        expect(parserAccepts(raw)).toBe(false);
        expect(schemaAccepts(raw)).toBe(false);
    });

    it.each(LIMITS)('leaves to the parser: %s', (_name, raw) => {
        expect(parserAccepts(raw)).toBe(false);
        expect(schemaAccepts(raw), JSON.stringify(schemaAccepts.errors)).toBe(true);
    });

    it('names every limit it cannot state, so a reader does not mistake a pass for a launch', () => {
        const text = String(BATCH_PLAN_JSON_SCHEMA.description);
        for (const word of ['unique', 'defaultTarget', 'executorScope', 'tasks in all']) expect(text).toContain(word);
    });
});
