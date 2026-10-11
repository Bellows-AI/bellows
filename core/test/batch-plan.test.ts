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

    it('refuses a bad policy at the batch and the stage, and a bad completion', () => {
        expect(paths(plan({ policy: 'yolo' }))).toEqual(['policy']);
        expect(paths(plan({ stages: [{ key: 'one', policy: 'x', tasks: [task('a')] }] }))).toEqual([
            'stages[0].policy',
        ]);
        expect(paths(plan({ stages: [{ key: 'one', tasks: [task('a', { completion: { kind: 'auto' } })] }] }))).toEqual(
            ['stages[0].tasks[0].completion.kind']
        );
        expect(
            paths(plan({ stages: [{ key: 'one', tasks: [task('a', { completion: { kind: 'accepted' } })] }] }))
        ).toEqual(['stages[0].tasks[0].completion.condition']);
    });

    it('refuses dependsOn and every other unknown field, at every level', () => {
        expect(paths(plan({ extra: 1 }))).toEqual(['extra']);
        expect(paths(plan({ targets: [{ key: 'web', repo: 'acme/web', x: 1 }] }))).toEqual(['targets[0].x']);
        expect(paths(plan({ stages: [{ key: 'one', dependsOn: ['x'], tasks: [task('a')] }] }))).toEqual([
            'stages[0].dependsOn',
        ]);
        expect(paths(plan({ stages: [{ key: 'one', tasks: [task('a', { dependsOn: ['b'] })] }] }))).toEqual([
            'stages[0].tasks[0].dependsOn',
        ]);
    });

    it('refuses an unresolved task target, an unknown default target and a missing one', () => {
        expect(paths(plan({ stages: [{ key: 'one', tasks: [task('a', { target: 'nope' })] }] }))).toEqual([
            'stages[0].tasks[0].target',
        ]);
        expect(paths(plan({ defaultTarget: 'nope' }))).toContain('defaultTarget');
        const { defaultTarget: _omitted, ...noDefault } = plan();
        expect(paths(noDefault)).toEqual(['stages[0].tasks[0].target']);
    });

    it('refuses duplicate keys, task keys across stages included', () => {
        expect(
            paths(
                plan({
                    targets: [
                        { key: 'web', repo: 'acme/web' },
                        { key: 'web', repo: 'acme/api' },
                    ],
                })
            )
        ).toEqual(['targets[1].key']);
        expect(
            paths(
                plan({
                    stages: [
                        { key: 'one', tasks: [task('a')] },
                        { key: 'one', tasks: [task('b')] },
                    ],
                })
            )
        ).toEqual(['stages[1].key']);
        expect(
            paths(
                plan({
                    stages: [
                        { key: 'one', tasks: [task('a')] },
                        { key: 'two', tasks: [task('a')] },
                    ],
                })
            )
        ).toEqual(['stages[1].tasks[0].key']);
    });

    it('refuses empty stages, tasks and targets', () => {
        expect(paths(plan({ stages: [] }))).toEqual(['stages']);
        expect(paths(plan({ stages: [{ key: 'one', tasks: [] }] }))).toEqual(['stages[0].tasks']);
        expect(paths(plan({ targets: [] }))).toContain('targets');
    });

    it('refuses a malformed key, repo and objective', () => {
        expect(paths(plan({ targets: [{ key: 'Web', repo: 'acme/web' }] }))).toContain('targets[0].key');
        expect(paths(plan({ targets: [{ key: 'web', repo: 'acme' }] }))).toContain('targets[0].repo');
        expect(paths(plan({ stages: [{ key: 'one', tasks: [task('a', { objective: '  ' })] }] }))).toEqual([
            'stages[0].tasks[0].objective',
        ]);
        expect(paths('nope')).toEqual(['']);
        expect(paths(plan({ planVersion: 2 }))).toEqual(['planVersion']);
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
    });
});

const parsed = (raw: unknown) => {
    const result = validateBatchPlan(raw);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.plan;
};

describe('resolveBatchPlan and batchExecutionCapability', () => {
    const defaults = { 'acme/web': 'main', 'acme/api': 'trunk' };

    it('resolves branches, targets, stage policies and executors', () => {
        const resolved = resolveBatchPlan(
            parsed(plan({ executor: 'claude', policy: 'automerge', stages: [{ key: 'one', tasks: [task('a')] }] })),
            defaults
        );
        expect(resolved.targets).toEqual([{ key: 'web', repo: 'acme/web', branch: 'main' }]);
        expect(resolved.stages[0]!.policy).toBe('automerge');
        expect(resolved.stages[0]!.tasks[0]).toMatchObject({ target: 'web', executor: 'claude' });
    });

    it('passes a single-target plan on the default branch', () => {
        const resolved = resolveBatchPlan(parsed(plan()), defaults);
        expect(batchExecutionCapability(resolved, defaults)).toEqual({ ok: true });
        const explicit = resolveBatchPlan(
            parsed(plan({ targets: [{ key: 'web', repo: 'acme/web', branch: 'main' }] })),
            defaults
        );
        expect(batchExecutionCapability(explicit, defaults)).toEqual({ ok: true });
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
        expect(batchExecutionCapability(resolved, defaults)).toMatchObject({ ok: false, reason: 'multi_target' });
    });

    it('refuses a branch other than the repository default', () => {
        const resolved = resolveBatchPlan(
            parsed(plan({ targets: [{ key: 'web', repo: 'acme/web', branch: 'release' }] })),
            defaults
        );
        expect(batchExecutionCapability(resolved, defaults)).toMatchObject({
            ok: false,
            reason: 'non_default_branch',
        });
    });

    it('refuses a stage whose resolved policy is automerge, whether set on the batch or the stage', () => {
        const batchWide = resolveBatchPlan(parsed(plan({ policy: 'automerge' })), defaults);
        expect(batchExecutionCapability(batchWide, defaults)).toMatchObject({ ok: false, reason: 'automerge' });
        const oneStage = resolveBatchPlan(
            parsed(plan({ stages: [{ key: 'one', policy: 'automerge', tasks: [task('a')] }] })),
            defaults
        );
        expect(batchExecutionCapability(oneStage, defaults)).toMatchObject({ ok: false, reason: 'automerge' });
        const human = resolveBatchPlan(parsed(plan({ policy: 'human' })), defaults);
        expect(batchExecutionCapability(human, defaults)).toEqual({ ok: true });
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
        expect(batchExecutionCapability(resolved, defaults)).toEqual({ ok: true });
    });
});
