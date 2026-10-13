import type { BatchPlan } from '@factory-ai/core';
import { KeyValues } from '../components/KeyValues.js';
import {
    executorLabel,
    stagePolicyOf,
    taskExecutorOf,
    taskTargetOf,
    targetLabel,
    type Inherited,
} from '../batch-model.js';

/** One effective value with where it came from: the board's default for the batch, or the author's override. */
export function Origin({ of }: { of: Inherited }) {
    return (
        <>
            {of.value} <span className="batch-origin">{of.source}</span>
        </>
    );
}

/**
 * The plan as start will freeze it: the batch settings, then per stage its policy and per task its
 * target and executor, each marked inherited or overridden — so nothing a launch applies is a
 * surprise (docs/design-system/batches.md). Read-only; the draft editor above it is where values change.
 */
export function BatchPlanReview({ plan }: { plan: BatchPlan }) {
    return (
        <section className="panel" aria-labelledby="batch-review-title">
            <h2 id="batch-review-title">Before launch</h2>
            <KeyValues
                pairs={[
                    ['Concurrency', `${plan.concurrency} at a time`],
                    ['Policy', `${plan.policy} (a stage may override it)`],
                    ['Executor', executorLabel(plan.executor, plan.executorScope, 'each task’s default')],
                    ...plan.targets.map((target): [string, string] => [
                        `Target ${target.key}`,
                        targetLabel(plan, target.key),
                    ]),
                ]}
            />
            <ol className="batch-review-stages">
                {plan.stages.map((stage) => (
                    <li key={stage.key}>
                        <strong>{stage.key}</strong> — policy <Origin of={stagePolicyOf(plan, stage)} />
                        <ul>
                            {stage.tasks.map((task) => (
                                <li key={task.key}>
                                    {task.key}: target <Origin of={taskTargetOf(plan, task)} />, executor{' '}
                                    <Origin of={taskExecutorOf(plan, task)} />
                                    {task.required ? '' : ', optional'}
                                </li>
                            ))}
                        </ul>
                    </li>
                ))}
            </ol>
        </section>
    );
}
