import { describe, expect, it } from 'vitest';
import {
    BATCH_KEY_LIMIT,
    BATCH_TEXT_LIMIT,
    BATCH_TITLE_LIMIT,
    batchExecutionCapability,
    MAX_BATCH_CONCURRENCY,
    MAX_BATCH_STAGES,
    MAX_BATCH_TARGETS,
    MAX_BATCH_TASKS,
    MAX_STAGE_TASKS,
    resolveBatchPlan,
    validateBatchPlan,
} from '../src/batch-plan.js';

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

const issuesOf = (raw: unknown) => {
    const result = validateBatchPlan(raw);
    return result.ok ? [] : result.issues;
};

const paths = (raw: unknown) => issuesOf(raw).map((issue) => issue.path);

const keyOf = (n: number) => `k${n}`;

describe('validateBatchPlan', () => {
    it('normalizes defaults and round-trips a minimal plan', () => {
        const result = validateBatchPlan(plan());
        expect(result).toEqual({
            ok: true,
            plan: {
                planVersion: 1,
                title: 'Upgrade',
                targets: [{ key: 'web', repo: 'acme/web' }],
                defaultTarget: 'web',
                policy: 'human',
                concurrency: 1,
                infraRetries: 2,
                repairs: 2,
                timeLimitMinutes: 720,
                stages: [
                    {
                        key: 'one',
                        tasks: [
                            {
                                key: 'a',
                                objective: 'do a',
                                acceptance: 'it works',
                                verification: 'npm test',
                                required: true,
                                completion: { kind: 'pr' },
                            },
                        ],
                    },
                ],
            },
        });
        if (result.ok) expect(validateBatchPlan(result.plan)).toEqual(result);
    });

    it('accepts a plan whose tasks span two repositories', () => {
        const result = validateBatchPlan(
            plan({
                targets: [
                    { key: 'web', repo: 'acme/web', branch: 'release' },
                    { key: 'api', repo: 'acme/api' },
                ],
                stages: [{ key: 'one', tasks: [task('a'), task('b', { target: 'api' })] }],
            })
        );
        expect(result.ok).toBe(true);
    });

    it('accepts an accepted completion with its condition, and policies', () => {
        const result = validateBatchPlan(
            plan({
                policy: 'automerge',
                stages: [
                    {
                        key: 'one',
                        policy: 'human',
                        tasks: [task('a', { required: false, completion: { kind: 'accepted', condition: 'ask QA' } })],
                    },
                ],
            })
        );
        expect(result.ok).toBe(true);
    });

    const { defaultTarget: _omitted, ...noDefault } = plan();

    it.each([
        ['a bad batch policy', plan({ policy: 'yolo' }), ['policy']],
        [
            'a bad stage policy',
            plan({ stages: [{ key: 'one', policy: 'x', tasks: [task('a')] }] }),
            ['stages[0].policy'],
        ],
        [
            'a bad completion kind',
            plan({ stages: [{ key: 'one', tasks: [task('a', { completion: { kind: 'auto' } })] }] }),
            ['stages[0].tasks[0].completion.kind'],
        ],
        [
            'an accepted completion without its condition',
            plan({ stages: [{ key: 'one', tasks: [task('a', { completion: { kind: 'accepted' } })] }] }),
            ['stages[0].tasks[0].completion.condition'],
        ],
        ['an unknown top-level field', plan({ extra: 1 }), ['extra']],
        ['an unknown target field', plan({ targets: [{ key: 'web', repo: 'acme/web', x: 1 }] }), ['targets[0].x']],
        [
            'a stage dependsOn',
            plan({ stages: [{ key: 'one', dependsOn: ['x'], tasks: [task('a')] }] }),
            ['stages[0].dependsOn'],
        ],
        [
            'a task dependsOn',
            plan({ stages: [{ key: 'one', tasks: [task('a', { dependsOn: ['b'] })] }] }),
            ['stages[0].tasks[0].dependsOn'],
        ],
        [
            'an unresolved task target',
            plan({ stages: [{ key: 'one', tasks: [task('a', { target: 'nope' })] }] }),
            ['stages[0].tasks[0].target'],
        ],
        ['a missing default target', noDefault, ['stages[0].tasks[0].target']],
        [
            'a duplicate target key',
            plan({
                targets: [
                    { key: 'web', repo: 'acme/web' },
                    { key: 'web', repo: 'acme/api' },
                ],
            }),
            ['targets[1].key'],
        ],
        [
            'a duplicate stage key',
            plan({
                stages: [
                    { key: 'one', tasks: [task('a')] },
                    { key: 'one', tasks: [task('b')] },
                ],
            }),
            ['stages[1].key'],
        ],
        [
            'a task key repeated across stages',
            plan({
                stages: [
                    { key: 'one', tasks: [task('a')] },
                    { key: 'two', tasks: [task('a')] },
                ],
            }),
            ['stages[1].tasks[0].key'],
        ],
        ['empty stages', plan({ stages: [] }), ['stages']],
        ['an empty stage', plan({ stages: [{ key: 'one', tasks: [] }] }), ['stages[0].tasks']],
        [
            'a blank objective',
            plan({ stages: [{ key: 'one', tasks: [task('a', { objective: '  ' })] }] }),
            ['stages[0].tasks[0].objective'],
        ],
        ['a non-object plan', 'nope', ['']],
        ['an unknown planVersion', plan({ planVersion: 2 }), ['planVersion']],
    ])('refuses %s at exactly its path', (_label, raw, expected) => {
        expect(paths(raw)).toEqual(expected);
    });

    it.each([
        ['an unknown default target', plan({ defaultTarget: 'nope' }), 'defaultTarget'],
        ['empty targets', plan({ targets: [] }), 'targets'],
        ['a malformed key', plan({ targets: [{ key: 'Web', repo: 'acme/web' }] }), 'targets[0].key'],
        ['a malformed repo', plan({ targets: [{ key: 'web', repo: 'acme' }] }), 'targets[0].repo'],
    ])('refuses %s, among its paths', (_label, raw, expected) => {
        expect(paths(raw)).toContain(expected);
    });

    describe('bounds, at the limit and one past it', () => {
        const stageOf = (n: number, tasks = 1) => ({
            key: keyOf(n),
            tasks: Array.from({ length: tasks }, (_, i) => task(`t${n}-${i}`)),
        });

        it('targets', () => {
            const targets = (n: number) => Array.from({ length: n }, (_, i) => ({ key: keyOf(i), repo: `a/r${i}` }));
            expect(issuesOf(plan({ targets: targets(MAX_BATCH_TARGETS), defaultTarget: 'k0' }))).toEqual([]);
            expect(paths(plan({ targets: targets(MAX_BATCH_TARGETS + 1), defaultTarget: 'k0' }))).toEqual(['targets']);
        });

        it('stages', () => {
            const stages = (n: number) => Array.from({ length: n }, (_, i) => stageOf(i));
            expect(issuesOf(plan({ stages: stages(MAX_BATCH_STAGES) }))).toEqual([]);
            expect(paths(plan({ stages: stages(MAX_BATCH_STAGES + 1) }))).toEqual(['stages']);
        });

        it('tasks per stage', () => {
            expect(issuesOf(plan({ stages: [stageOf(0, MAX_STAGE_TASKS)] }))).toEqual([]);
            expect(paths(plan({ stages: [stageOf(0, MAX_STAGE_TASKS + 1)] }))).toEqual(['stages[0].tasks']);
        });

        it('tasks per batch', () => {
            const stages = (tasks: number) => {
                const full = Math.floor(tasks / MAX_STAGE_TASKS);
                const out = Array.from({ length: full }, (_, i) => stageOf(i, MAX_STAGE_TASKS));
                if (tasks % MAX_STAGE_TASKS) out.push(stageOf(full, tasks % MAX_STAGE_TASKS));
                return out;
            };
            expect(issuesOf(plan({ stages: stages(MAX_BATCH_TASKS) }))).toEqual([]);
            expect(paths(plan({ stages: stages(MAX_BATCH_TASKS + 1) }))).toEqual(['stages']);
        });

        it('key length', () => {
            expect(issuesOf(plan({ stages: [{ key: 'a'.repeat(BATCH_KEY_LIMIT), tasks: [task('a')] }] }))).toEqual([]);
            expect(paths(plan({ stages: [{ key: 'a'.repeat(BATCH_KEY_LIMIT + 1), tasks: [task('a')] }] }))).toEqual([
                'stages[0].key',
            ]);
        });

        it('title and text length', () => {
            expect(issuesOf(plan({ title: 'x'.repeat(BATCH_TITLE_LIMIT) }))).toEqual([]);
            expect(paths(plan({ title: 'x'.repeat(BATCH_TITLE_LIMIT + 1) }))).toEqual(['title']);
            const longTask = (n: number) => ({ key: 'one', tasks: [task('a', { acceptance: 'x'.repeat(n) })] });
            expect(issuesOf(plan({ stages: [longTask(BATCH_TEXT_LIMIT)] }))).toEqual([]);
            expect(paths(plan({ stages: [longTask(BATCH_TEXT_LIMIT + 1)] }))).toEqual([
                'stages[0].tasks[0].acceptance',
            ]);
        });

        it('concurrency', () => {
            expect(issuesOf(plan({ concurrency: MAX_BATCH_CONCURRENCY }))).toEqual([]);
            expect(issuesOf(plan({ concurrency: 1 }))).toEqual([]);
            expect(paths(plan({ concurrency: MAX_BATCH_CONCURRENCY + 1 }))).toEqual(['concurrency']);
            expect(paths(plan({ concurrency: 0 }))).toEqual(['concurrency']);
            expect(paths(plan({ concurrency: 1.5 }))).toEqual(['concurrency']);
        });

        it('recovery budgets and the time limit', () => {
            expect(issuesOf(plan({ infraRetries: 0, repairs: 5, timeLimitMinutes: 1440 }))).toEqual([]);
            expect(paths(plan({ infraRetries: 6 }))).toEqual(['infraRetries']);
            expect(paths(plan({ repairs: -1 }))).toEqual(['repairs']);
            expect(paths(plan({ repairs: 1.5 }))).toEqual(['repairs']);
            expect(paths(plan({ timeLimitMinutes: 0 }))).toEqual(['timeLimitMinutes']);
            expect(paths(plan({ timeLimitMinutes: 1441 }))).toEqual(['timeLimitMinutes']);
        });
    });
});

describe('executorScope', () => {
    it('accepts user and org beside an executor, at the plan and the task', () => {
        expect(issuesOf(plan({ executor: 'Main ORG', executorScope: 'org' }))).toEqual([]);
        expect(
            issuesOf(
                plan({ stages: [{ key: 'one', tasks: [task('a', { executor: 'mine', executorScope: 'user' })] }] })
            )
        ).toEqual([]);
    });

    it('refuses a value outside the pair, at either level', () => {
        expect(paths(plan({ executor: 'x', executorScope: 'team' }))).toEqual(['executorScope']);
        expect(
            paths(plan({ stages: [{ key: 'one', tasks: [task('a', { executor: 'x', executorScope: 'ORG' })] }] }))
        ).toEqual(['stages[0].tasks[0].executorScope']);
    });

    it('refuses a scope with no executor anywhere to apply to', () => {
        expect(paths(plan({ executorScope: 'org' }))).toEqual(['executorScope']);
        expect(paths(plan({ stages: [{ key: 'one', tasks: [task('a', { executorScope: 'org' })] }] }))).toEqual([
            'stages[0].tasks[0].executorScope',
        ]);
        // A plan scope with no plan executor still applies to a task that names one.
        expect(
            issuesOf(plan({ executorScope: 'org', stages: [{ key: 'one', tasks: [task('a', { executor: 'x' })] }] }))
        ).toEqual([]);
    });
});

const parsed = (raw: unknown) => {
    const result = validateBatchPlan(raw);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.plan;
};

describe('resolveBatchPlan and batchExecutionCapability', () => {
    const defaults = { 'acme/web': 'main', 'acme/api': 'trunk' };
    const CAN_MERGE = { canMerge: true };

    it('resolves branches, targets, stage policies and executors', () => {
        const resolved = resolveBatchPlan(
            parsed(plan({ executor: 'claude', policy: 'automerge', stages: [{ key: 'one', tasks: [task('a')] }] })),
            defaults
        );
        expect(resolved.targets).toEqual([{ key: 'web', repo: 'acme/web', branch: 'main' }]);
        expect(resolved.stages[0]!.policy).toBe('automerge');
        expect(resolved.stages[0]!.tasks[0]).toMatchObject({ target: 'web', executor: 'claude' });
    });

    it('resolves each task’s executor scope: its own, else the plan’s, else user', () => {
        const resolved = resolveBatchPlan(
            parsed(
                plan({
                    executor: 'Main ORG',
                    executorScope: 'org',
                    stages: [
                        {
                            key: 'one',
                            tasks: [task('a'), task('b', { executor: 'mine', executorScope: 'user' }), task('c')],
                        },
                    ],
                })
            ),
            defaults
        );
        expect(resolved.stages[0]!.tasks.map((t) => [t.executor, t.executorScope])).toEqual([
            ['Main ORG', 'org'],
            ['mine', 'user'],
            ['Main ORG', 'org'],
        ]);
        expect(resolveBatchPlan(parsed(plan()), defaults).stages[0]!.tasks[0]).toMatchObject({
            executor: null,
            executorScope: 'user',
        });
    });

    it('passes a single-target plan on the default branch', () => {
        const resolved = resolveBatchPlan(parsed(plan()), defaults);
        expect(batchExecutionCapability(resolved, CAN_MERGE)).toEqual({ ok: true });
        const explicit = resolveBatchPlan(
            parsed(plan({ targets: [{ key: 'web', repo: 'acme/web', branch: 'main' }] })),
            defaults
        );
        expect(batchExecutionCapability(explicit, CAN_MERGE)).toEqual({ ok: true });
    });

    it('refuses more than one (repo, branch) pair', () => {
        const resolved = resolveBatchPlan(
            parsed(
                plan({
                    targets: [
                        { key: 'web', repo: 'acme/web' },
                        { key: 'api', repo: 'acme/api' },
                    ],
                    stages: [{ key: 'one', tasks: [task('a'), task('b', { target: 'api' })] }],
                })
            ),
            defaults
        );
        expect(batchExecutionCapability(resolved, CAN_MERGE)).toMatchObject({
            ok: false,
            reason: 'multi_target',
        });
    });

    it('accepts a branch other than the repository default', () => {
        const resolved = resolveBatchPlan(
            parsed(plan({ targets: [{ key: 'web', repo: 'acme/web', branch: 'release' }] })),
            defaults
        );
        expect(batchExecutionCapability(resolved, CAN_MERGE)).toEqual({ ok: true });
    });

    it('accepts automerge, set on the batch or the stage, only on a board that can merge', () => {
        const cannot = { canMerge: false };
        const batchWide = resolveBatchPlan(parsed(plan({ policy: 'automerge' })), defaults);
        expect(batchExecutionCapability(batchWide, cannot)).toMatchObject({ ok: false, reason: 'automerge' });
        expect(batchExecutionCapability(batchWide, CAN_MERGE)).toEqual({ ok: true });
        const oneStage = resolveBatchPlan(
            parsed(plan({ stages: [{ key: 'one', policy: 'automerge', tasks: [task('a')] }] })),
            defaults
        );
        expect(batchExecutionCapability(oneStage, cannot)).toMatchObject({ ok: false, reason: 'automerge' });
        expect(batchExecutionCapability(oneStage, CAN_MERGE)).toEqual({ ok: true });
        const human = resolveBatchPlan(parsed(plan({ policy: 'human' })), defaults);
        expect(batchExecutionCapability(human, cannot)).toEqual({ ok: true });
    });

    it('ignores a declared target no task uses', () => {
        const resolved = resolveBatchPlan(
            parsed(
                plan({
                    targets: [
                        { key: 'web', repo: 'acme/web' },
                        { key: 'api', repo: 'acme/api', branch: 'release' },
                    ],
                })
            ),
            defaults
        );
        expect(batchExecutionCapability(resolved, CAN_MERGE)).toEqual({ ok: true });
    });
});
