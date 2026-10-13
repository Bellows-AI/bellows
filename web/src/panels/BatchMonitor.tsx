import { BATCH_COMPLETION_ACCEPTED, TASK_NO_PR, isAccepted, type BatchPlan } from '@factory-ai/core';
import { Link } from 'react-router-dom';
import {
    GATE_RESUMES_AUTOMATICALLY,
    canRetry,
    effectivePolicy,
    gateInstruction,
    morningReport,
    needsPerson,
    retryLabel,
    stagePolicyOf,
    stageViews,
    targetLabel,
    taskExecutorOf,
    taskStateLabel,
    taskTargetOf,
    type BatchRecord,
    type BatchTaskState,
    type StageView,
    verificationFailed,
    verificationPending,
} from '../batch-model.js';
import { Origin } from './BatchPlanReview.js';

/**
 * A started batch, as the board's read model says it stands: the stages in order, each one's
 * tasks as parallel cards with their state, PR, thread and what waits on a person. Every control
 * here is a request the board judges (retry, accept); nothing is decided in the browser, and a
 * human gate says outright that it resumes by itself (docs/design-system/batches.md).
 */

/** What a controls handler answers with: the refusal sentence, or null once the board accepted. */
export type TaskAction = (taskKey: string) => Promise<string | null>;

const PR_URL = /^https?:\/\//;
const SHA_LENGTH = 8;

function TaskCard({
    batch,
    view,
    onRetry,
    onAccept,
    pending,
}: {
    batch: BatchRecord;
    view: StageView['tasks'][number];
    onRetry: TaskAction;
    onAccept: TaskAction;
    pending: string | null;
}) {
    const { task, state } = view;
    const plan: BatchPlan = batch.plan;
    if (!state) return null;
    const { label, tone } = taskStateLabel(state);
    const instruction = gateInstruction(task, state);
    const acceptable =
        task.completion.kind === BATCH_COMPLETION_ACCEPTED &&
        state.stage === batch.activeStage &&
        state.execution === 'succeeded' &&
        !isAccepted(state) &&
        batch.cancelledAt === null;
    const busy = pending === state.key;
    return (
        <li className="batch-task" data-task={state.key}>
            <div className="batch-task-head">
                <strong>{state.key}</strong>
                <span className={`pill pill-${tone}`}>{label}</span>
                {task.required ? null : <span className="pill">Optional</span>}
                {state.attempt > 1 ? <span className="pill">Attempt {state.attempt}</span> : null}
            </div>
            <p className="batch-objective">{task.objective}</p>
            <p className="muted">
                {targetLabel(plan, taskTargetOf(plan, task).value)} · executor{' '}
                <Origin of={taskExecutorOf(plan, task)} />
            </p>
            <p className="batch-links">
                {state.rootJobId ? <Link to={`/tasks/${state.rootJobId}`}>Open task</Link> : null}
                {state.pr !== TASK_NO_PR ? (
                    PR_URL.test(state.pr) ? (
                        <a href={state.pr} target="_blank" rel="noreferrer">
                            Pull request
                        </a>
                    ) : (
                        <span>{state.pr}</span>
                    )
                ) : null}
            </p>
            {state.waitReason !== null ? <p className="batch-wait">Waiting: {state.waitReason}</p> : null}
            {instruction ? <p className="batch-gate">{instruction}</p> : null}
            <div className="batch-actions">
                {canRetry(batch, state) ? (
                    <button type="button" disabled={busy} onClick={() => void onRetry(state.key)}>
                        {retryLabel(state)} {state.key}
                    </button>
                ) : null}
                {acceptable ? (
                    <button type="button" className="primary" disabled={busy} onClick={() => void onAccept(state.key)}>
                        Accept {state.key}
                    </button>
                ) : null}
            </div>
        </li>
    );
}

function StageRow({
    batch,
    view,
    index,
    ...actions
}: {
    batch: BatchRecord;
    view: StageView;
    index: number;
    onRetry: TaskAction;
    onAccept: TaskAction;
    pending: string | null;
}) {
    const { stage, tasks } = view;
    const done = tasks.filter(({ state }) => state && isAccepted(state)).length;
    const active = batch.activeStage === stage.key && batch.cancelledAt === null;
    const humanGate = effectivePolicy(batch.plan, stage) === 'human';
    const waiting = tasks.some(({ state }) => state?.waitReason != null);
    const verification = batch.verification.find((row) => row.stage === stage.key);
    return (
        <section
            className={`panel batch-stage${active ? ' is-active' : ''}`}
            aria-label={`Stage ${index + 1}`}
            data-stage={stage.key}
        >
            <div className="batch-stage-head">
                <h3>
                    Stage {index + 1} <span className="muted">({stage.key})</span>
                </h3>
                <span className="pill">
                    {done}/{tasks.length} accepted
                </span>
                <span className="muted">
                    policy <Origin of={stagePolicyOf(batch.plan, stage)} />
                </span>
                {active ? <span className="pill pill-ok">Active</span> : null}
            </div>
            {humanGate && (active || waiting) ? (
                <p className="batch-gate" role="note">
                    Human review gate. {GATE_RESUMES_AUTOMATICALLY}
                </p>
            ) : null}
            {verification && verificationFailed(verification) ? (
                <p className="batch-gate" role="note" data-verification="failed">
                    Needs you: verification of {stage.key} failed on the target after its merges, so the next stage is
                    held. Fix or re-run them on GitHub; nothing to retry here.{' '}
                    <span className="muted">
                        {verification.detail ?? 'No detail recorded.'}
                        {verification.headSha ? ` Checked at ${verification.headSha.slice(0, SHA_LENGTH)}.` : ''}
                    </span>
                </p>
            ) : null}
            {verification && verificationPending(verification) ? (
                <p className="batch-wait" data-verification="pending">
                    The board is still checking the target after this stage merged.
                </p>
            ) : null}
            <ul className="batch-tasks">
                {tasks.map((view) => (
                    <TaskCard key={view.task.key} batch={batch} view={view} {...actions} />
                ))}
            </ul>
        </section>
    );
}

/** What landed, what waits on you, what has not begun, and the pull requests merged so far. */
export function BatchReport({ batch }: { batch: BatchRecord }) {
    const report = morningReport(batch);
    const merged = batch.tasks.filter(
        (task): task is BatchTaskState => isAccepted(task) && task.pr !== TASK_NO_PR && PR_URL.test(task.pr)
    );
    const waiting = batch.tasks.filter((task) => !isAccepted(task) && needsPerson(task));
    const failedStages = batch.verification.filter(verificationFailed);
    return (
        <section className="panel" aria-labelledby="batch-report-title">
            <h2 id="batch-report-title">Report</h2>
            <p>
                {report.accepted} of {report.total} tasks accepted · {report.needsYou} need you · {report.notStarted}{' '}
                not started
            </p>
            {waiting.length > 0 || failedStages.length > 0 ? (
                <>
                    <h3>Needs you</h3>
                    <ul>
                        {failedStages.map((row) => (
                            <li key={row.stage}>
                                {row.stage}: verification failed. {row.detail ?? ''}
                            </li>
                        ))}
                        {waiting.map((task) => (
                            <li key={task.key}>
                                {task.key}: {task.waitReason ?? taskStateLabel(task).label}
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
            {merged.length > 0 ? (
                <>
                    <h3>Merged so far</h3>
                    <ul>
                        {merged.map((task) => (
                            <li key={task.key}>
                                {task.key}:{' '}
                                <a href={task.pr} target="_blank" rel="noreferrer">
                                    {task.pr}
                                </a>
                                {task.attempt > 1 ? ` (repaired, attempt ${task.attempt})` : ''}
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
        </section>
    );
}

export function BatchMonitor({
    batch,
    onRetry,
    onAccept,
    pending,
}: {
    batch: BatchRecord;
    onRetry: TaskAction;
    onAccept: TaskAction;
    pending: string | null;
}) {
    return (
        <>
            <BatchReport batch={batch} />
            {stageViews(batch).map((view, index) => (
                <StageRow
                    key={view.stage.key}
                    batch={batch}
                    view={view}
                    index={index}
                    onRetry={onRetry}
                    onAccept={onAccept}
                    pending={pending}
                />
            ))}
        </>
    );
}
