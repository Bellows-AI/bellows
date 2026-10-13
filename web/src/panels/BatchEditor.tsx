import {
    BATCH_COMPLETION_ACCEPTED,
    BATCH_COMPLETION_PR,
    BATCH_POLICIES,
    EXECUTOR_SCOPES,
    MAX_BATCH_CONCURRENCY,
    MAX_BATCH_STAGES,
    MAX_STAGE_TASKS,
    MIN_BATCH_CONCURRENCY,
    USER_SCOPE,
    type BatchPlan,
    type BatchPlanIssue,
    type BatchPolicy,
    type BatchStage,
    type BatchTask,
    type ExecutorScope,
} from '@factory-ai/core';
import { Children, isValidElement, useId, type ReactNode } from 'react';
import {
    addStage,
    addTask,
    moveStage,
    removeStage,
    removeTask,
    updateStage,
    updateTask,
    withOptional,
} from '../batch-model.js';

/**
 * The draft composer: a controlled form over the plan, one stage after another with its parallel
 * tasks. It edits the plan document the CLI edits and invents no field — `validateBatchPlan` (the
 * caller runs it) is the only judge, and its issues come back addressed by path to the field they
 * name. Stage order is the only dependency model, so a stage's controls are move up and move
 * down, never a graph. A target the draft names beyond the first is edited here too, but a
 * target is added or removed through the CLI.
 */

const INHERIT = '';
/** Whose executor profile a name selects: a member's own, or one the organization manages. */
const SCOPE_LABEL: Record<ExecutorScope, string> = { user: 'Personal', org: 'Organization' };

interface EditorProps {
    plan: BatchPlan;
    onChange: (plan: BatchPlan) => void;
    issues: BatchPlanIssue[];
    repos: readonly string[];
    disabled: boolean;
}

/** The issue addressed to exactly this field, as the sentence under it. */
function Problem({ issues, path }: { issues: BatchPlanIssue[]; path: string }) {
    const found = issues.filter((issue) => issue.path === path);
    if (found.length === 0) return null;
    return (
        <p className="error batch-problem" id={problemId(path)}>
            {found.map((issue) => issue.message).join('; ')}
        </p>
    );
}

const problemId = (path: string) => `batch-problem-${path.replace(/[^a-z0-9]+/gi, '-')}`;

/** The attributes that tie a control to its problem sentence. */
const invalid = (issues: BatchPlanIssue[], path: string) =>
    issues.some((issue) => issue.path === path)
        ? ({ 'aria-invalid': true, 'aria-describedby': problemId(path) } as const)
        : {};

/**
 * A label above its control. A `Problem` among the children renders beside the label rather than
 * inside it — a sentence in the label would become part of the control's accessible name, and a
 * paragraph is not phrasing content — and still names the control through `aria-describedby`.
 */
function Field({ label, children }: { label: string; children: ReactNode }) {
    const parts = Children.toArray(children);
    const isProblem = (part: ReactNode) => isValidElement(part) && part.type === Problem;
    return (
        <div className="batch-field">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is the child this label wraps */}
            <label>
                <span>{label}</span>
                {parts.filter((part) => !isProblem(part))}
            </label>
            {parts.filter(isProblem)}
        </div>
    );
}

function TaskEditor({
    plan,
    stageIndex,
    taskIndex,
    task,
    onChange,
    issues,
    disabled,
}: EditorProps & { stageIndex: number; taskIndex: number; task: BatchTask }) {
    const path = `stages[${stageIndex}].tasks[${taskIndex}]`;
    const set = (change: (task: BatchTask) => BatchTask) => onChange(updateTask(plan, task.key, change));
    const text = (field: 'objective' | 'acceptance' | 'verification', label: string, hint: string) => (
        <Field label={label}>
            <textarea
                className="field"
                rows={3}
                value={task[field]}
                placeholder={hint}
                disabled={disabled}
                onChange={(e) => set((t) => ({ ...t, [field]: e.target.value }))}
                {...invalid(issues, `${path}.${field}`)}
            />
            <Problem issues={issues} path={`${path}.${field}`} />
        </Field>
    );
    return (
        <fieldset className="batch-task-edit" disabled={disabled}>
            <legend>
                Task {taskIndex + 1} <span className="muted">({task.key})</span>
            </legend>
            {text('objective', 'Instructions', 'What the agent should do')}
            {text('acceptance', 'Acceptance', 'What must be true when it is done')}
            {text('verification', 'Verification', 'How to check it, e.g. the command to run')}
            <div className="batch-field-row">
                <Field label="Executor (optional)">
                    <input
                        className="field"
                        value={task.executor ?? ''}
                        placeholder={plan.executor ?? 'default executor'}
                        onChange={(e) => set((t) => withOptional(t, 'executor', e.target.value))}
                        {...invalid(issues, `${path}.executor`)}
                    />
                    <Problem issues={issues} path={`${path}.executor`} />
                </Field>
                <Field label="Executor scope">
                    <select
                        className="field"
                        value={task.executorScope ?? INHERIT}
                        onChange={(e) => set((t) => withOptional(t, 'executorScope', e.target.value))}
                        {...invalid(issues, `${path}.executorScope`)}
                    >
                        <option value={INHERIT}>Inherit ({SCOPE_LABEL[plan.executorScope ?? USER_SCOPE]})</option>
                        {EXECUTOR_SCOPES.map((scope) => (
                            <option key={scope} value={scope}>
                                {SCOPE_LABEL[scope]}
                            </option>
                        ))}
                    </select>
                    <Problem issues={issues} path={`${path}.executorScope`} />
                </Field>
                {plan.targets.length > 1 ? (
                    <Field label="Target">
                        <select
                            className="field"
                            value={task.target ?? INHERIT}
                            onChange={(e) => set((t) => withOptional(t, 'target', e.target.value))}
                        >
                            <option value={INHERIT}>Inherit ({plan.defaultTarget ?? 'none'})</option>
                            {plan.targets.map((target) => (
                                <option key={target.key} value={target.key}>
                                    {target.key}
                                </option>
                            ))}
                        </select>
                        <Problem issues={issues} path={`${path}.target`} />
                    </Field>
                ) : null}
                <Field label="Done when">
                    <select
                        className="field"
                        value={task.completion.kind}
                        onChange={(e) =>
                            set((t) => ({
                                ...t,
                                completion:
                                    e.target.value === BATCH_COMPLETION_ACCEPTED
                                        ? { kind: BATCH_COMPLETION_ACCEPTED, condition: '' }
                                        : { kind: BATCH_COMPLETION_PR },
                            }))
                        }
                    >
                        <option value={BATCH_COMPLETION_PR}>Its pull request is merged</option>
                        <option value={BATCH_COMPLETION_ACCEPTED}>A person accepts it (no PR)</option>
                    </select>
                </Field>
            </div>
            {task.completion.kind === BATCH_COMPLETION_ACCEPTED ? (
                <Field label="Acceptance condition">
                    <input
                        className="field"
                        value={task.completion.condition}
                        onChange={(e) =>
                            set((t) => ({
                                ...t,
                                completion: { kind: BATCH_COMPLETION_ACCEPTED, condition: e.target.value },
                            }))
                        }
                        {...invalid(issues, `${path}.completion.condition`)}
                    />
                    <Problem issues={issues} path={`${path}.completion.condition`} />
                </Field>
            ) : null}
            <label className="batch-check">
                <input
                    type="checkbox"
                    checked={task.required}
                    onChange={(e) => set((t) => ({ ...t, required: e.target.checked }))}
                />{' '}
                Required — the next stage waits for it
            </label>
            <div className="batch-actions">
                <button type="button" onClick={() => onChange(removeTask(plan, task.key))}>
                    Remove task {taskIndex + 1}
                </button>
            </div>
        </fieldset>
    );
}

function StageEditor({ plan, stage, stageIndex, ...rest }: EditorProps & { stage: BatchStage; stageIndex: number }) {
    const { onChange, issues, disabled } = rest;
    const path = `stages[${stageIndex}]`;
    const policyId = useId();
    return (
        <section className="panel batch-stage" aria-label={`Stage ${stageIndex + 1}`}>
            <div className="batch-stage-head">
                <h3>
                    Stage {stageIndex + 1} <span className="muted">({stage.key})</span>
                </h3>
                <div className="batch-actions">
                    <label htmlFor={policyId} className="visually-hidden">
                        Stage {stageIndex + 1} policy
                    </label>
                    <select
                        id={policyId}
                        className="field"
                        disabled={disabled}
                        value={stage.policy ?? INHERIT}
                        onChange={(e) =>
                            onChange(updateStage(plan, stage.key, (s) => withOptional(s, 'policy', e.target.value)))
                        }
                    >
                        <option value={INHERIT}>Inherit ({plan.policy})</option>
                        {BATCH_POLICIES.map((policy: BatchPolicy) => (
                            <option key={policy} value={policy}>
                                {policy}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        disabled={disabled || stageIndex === 0}
                        onClick={() => onChange(moveStage(plan, stage.key, -1))}
                    >
                        Move stage {stageIndex + 1} up
                    </button>
                    <button
                        type="button"
                        disabled={disabled || stageIndex === plan.stages.length - 1}
                        onClick={() => onChange(moveStage(plan, stage.key, 1))}
                    >
                        Move stage {stageIndex + 1} down
                    </button>
                    <button type="button" disabled={disabled} onClick={() => onChange(removeStage(plan, stage.key))}>
                        Remove stage {stageIndex + 1}
                    </button>
                </div>
            </div>
            <Problem issues={issues} path={`${path}.policy`} />
            <Problem issues={issues} path={`${path}.tasks`} />
            <p className="muted">These tasks run in parallel; the next stage starts when they are all accepted.</p>
            {stage.tasks.map((task, taskIndex) => (
                <TaskEditor
                    key={task.key}
                    plan={plan}
                    stageIndex={stageIndex}
                    taskIndex={taskIndex}
                    task={task}
                    {...rest}
                />
            ))}
            <div className="batch-actions">
                <button
                    type="button"
                    disabled={disabled || stage.tasks.length >= MAX_STAGE_TASKS}
                    onClick={() => onChange(addTask(plan, stage.key))}
                >
                    Add task to stage {stageIndex + 1}
                </button>
            </div>
        </section>
    );
}

export function BatchEditor(props: EditorProps) {
    const { plan, onChange, issues, repos, disabled } = props;
    const reposId = useId();
    return (
        <div className="batch-editor">
            <section className="panel" aria-labelledby="batch-settings-title">
                <h2 id="batch-settings-title">Batch</h2>
                <div className="batch-form">
                    <Field label="Title">
                        <input
                            className="field"
                            value={plan.title}
                            disabled={disabled}
                            onChange={(e) => onChange({ ...plan, title: e.target.value })}
                            {...invalid(issues, 'title')}
                        />
                        <Problem issues={issues} path="title" />
                    </Field>
                    <Field label="Concurrency">
                        <input
                            className="field"
                            type="number"
                            min={MIN_BATCH_CONCURRENCY}
                            max={MAX_BATCH_CONCURRENCY}
                            value={plan.concurrency}
                            disabled={disabled}
                            onChange={(e) => onChange({ ...plan, concurrency: Number(e.target.value) })}
                            {...invalid(issues, 'concurrency')}
                        />
                        <Problem issues={issues} path="concurrency" />
                    </Field>
                    <Field label="Default policy">
                        <select
                            className="field"
                            value={plan.policy}
                            disabled={disabled}
                            onChange={(e) => onChange({ ...plan, policy: e.target.value as BatchPolicy })}
                        >
                            {BATCH_POLICIES.map((policy) => (
                                <option key={policy} value={policy}>
                                    {policy}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <Field label="Default executor (optional)">
                        <input
                            className="field"
                            value={plan.executor ?? ''}
                            disabled={disabled}
                            onChange={(e) => onChange(withOptional(plan, 'executor', e.target.value))}
                            {...invalid(issues, 'executor')}
                        />
                        <Problem issues={issues} path="executor" />
                    </Field>
                    <Field label="Default executor scope">
                        <select
                            className="field"
                            value={plan.executorScope ?? USER_SCOPE}
                            disabled={disabled}
                            onChange={(e) =>
                                onChange(
                                    withOptional(
                                        plan,
                                        'executorScope',
                                        e.target.value === USER_SCOPE ? '' : e.target.value
                                    )
                                )
                            }
                            {...invalid(issues, 'executorScope')}
                        >
                            {EXECUTOR_SCOPES.map((scope) => (
                                <option key={scope} value={scope}>
                                    {SCOPE_LABEL[scope]}
                                </option>
                            ))}
                        </select>
                        <Problem issues={issues} path="executorScope" />
                    </Field>
                </div>
                <datalist id={reposId}>
                    {repos.map((repo) => (
                        <option key={repo} value={repo} />
                    ))}
                </datalist>
                {plan.targets.map((target, index) => (
                    <div key={target.key} className="batch-form">
                        <Field label={`Repository (${target.key})`}>
                            <input
                                className="field"
                                list={reposId}
                                value={target.repo}
                                placeholder="owner/name"
                                disabled={disabled}
                                onChange={(e) =>
                                    onChange({
                                        ...plan,
                                        targets: plan.targets.map((t, i) =>
                                            i === index ? { ...t, repo: e.target.value } : t
                                        ),
                                    })
                                }
                                {...invalid(issues, `targets[${index}].repo`)}
                            />
                            <Problem issues={issues} path={`targets[${index}].repo`} />
                        </Field>
                        <Field label={`Branch (${target.key})`}>
                            <input
                                className="field"
                                value={target.branch ?? ''}
                                placeholder="default branch"
                                disabled={disabled}
                                onChange={(e) =>
                                    onChange({
                                        ...plan,
                                        targets: plan.targets.map((t, i) =>
                                            i === index ? withOptional(t, 'branch', e.target.value) : t
                                        ),
                                    })
                                }
                                {...invalid(issues, `targets[${index}].branch`)}
                            />
                            <Problem issues={issues} path={`targets[${index}].branch`} />
                        </Field>
                    </div>
                ))}
                <Problem issues={issues} path="targets" />
                <Problem issues={issues} path="stages" />
            </section>
            {plan.stages.map((stage, stageIndex) => (
                <StageEditor key={stage.key} stage={stage} stageIndex={stageIndex} {...props} />
            ))}
            <div className="batch-actions">
                <button
                    type="button"
                    disabled={disabled || plan.stages.length >= MAX_BATCH_STAGES}
                    onClick={() => onChange(addStage(plan))}
                >
                    Add stage
                </button>
            </div>
        </div>
    );
}
