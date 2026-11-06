import { useState } from 'react';
import type { TaskUsageDistribution, TaskUsageStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import { duration, num, tokens } from '../format.js';
import { ObservedUsageNote } from '../components/usage/CoverageNote.js';
import { InfoTip } from '../components/usage/InfoTip.js';
import { isUnknownBucket } from '../components/usage/usage-format.js';
import { TelemetryFrame } from './TelemetryFrame.js';

const MS_PER_HOUR = 3_600_000;

type Unit = 'tokens' | 'count' | 'duration';

const FORMATS: Record<Unit, (value: number | null) => string> = {
    tokens: (value) => tokens(value),
    count: (value) => num(value, 1),
    duration: (value) => (value === null ? '—' : duration(value / MS_PER_HOUR)),
};

const ALL_MODELS = '';
const modelLabel = (model: string): string => (isUnknownBucket(model) ? 'Unknown model' : model);

/**
 * One distribution as a card: the median (the payload's `p50`) as the figure, average and P95
 * beneath, beside the task count it was computed over — a P95 over five tasks must never pass
 * for a settled statistic.
 */
function DistributionCard({
    label,
    unit,
    d,
    partial = 0,
}: {
    label: string;
    unit: Unit;
    d: TaskUsageDistribution;
    /** Token cards only: contributors that measured the type in part of their sessions. */
    partial?: number;
}) {
    const f = FORMATS[unit];
    const median = f(d.p50);
    return (
        <div className="usage-group">
            <div className="usage-body">
                <span className="usage-label">{label}</span>
                <strong className={median === '—' ? 'usage-unmeasured' : undefined}>{median}</strong>
                <span className="usage-caption">
                    {d.tasks === 0
                        ? 'Not measured'
                        : `avg ${f(d.avg)} · P95 ${f(d.p95)} · ${d.tasks} ${d.tasks === 1 ? 'task' : 'tasks'}${partial > 0 ? ` (${partial} partial)` : ''}`}
                </span>
            </div>
        </div>
    );
}

/**
 * What a task costs, as a strip in the summary's grammar: output tokens, board runs, agent turns
 * and wall clock per task, median first. Token types are distributed separately and medians do
 * not add, so the strip shows Output alone rather than a sum.
 */
export function TaskUsagePanel({ tasks, meta }: { tasks: TaskUsageStats | null; meta: TelemetryMeta }) {
    const [model, setModel] = useState(ALL_MODELS);
    if (tasks === null) return null;
    const group = tasks.tokens.byModel.find((g) => g.model === model);
    const output = (group?.dist ?? tasks.tokens.all).output;
    // The task set is what runs-per-task counts — every in-scope task, measured or not. Empty
    // means the range holds no attributed tasks at all: one message, not four dash cards.
    const empty = [
        tasks.tokens.all.output.tasks,
        tasks.jobTurnsPerTask.tasks,
        tasks.agentTurnsPerTask.tasks,
        tasks.wallClockPerTask.tasks,
    ].every((n) => n === 0);
    const variants = group?.rawModels.filter((raw) => raw !== group.model) ?? [];
    return (
        <TelemetryFrame
            title="Per-task usage"
            titleId="per-task-usage-heading"
            meta={meta}
            actions={
                <>
                    {!empty && tasks.tokens.byModel.length > 0 ? (
                        <label className="task-usage-model">
                            Model{' '}
                            <select value={model} onChange={(e) => setModel(e.target.value)}>
                                <option value={ALL_MODELS}>All models</option>
                                {tasks.tokens.byModel.map((g) => (
                                    <option key={g.model} value={g.model}>
                                        {modelLabel(g.model)}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}
                    <InfoTip label="How per-task usage is calculated" glyph="?">
                        A task is one board thread, first run and follow-ups together. The figure is the median; average
                        and 95th percentile sit beneath it. Runs count the task's board runs; agent turns count
                        assistant responses in each run's own conversation; wall clock is the execution time the board
                        banked. Agent turns and wall clock use fully measured tasks only: a task with any unmeasured run
                        is left out, never counted as zero.
                    </InfoTip>
                </>
            }
        >
            {empty ? (
                <p className="muted">No attributed tasks in this range yet.</p>
            ) : (
                <div className="usage-groups usage-groups-compact">
                    <DistributionCard label="Output per task" unit="tokens" d={output} partial={output.partial} />
                    <DistributionCard label="Runs per task" unit="count" d={tasks.jobTurnsPerTask} />
                    <DistributionCard label="Agent turns per task" unit="count" d={tasks.agentTurnsPerTask} />
                    <DistributionCard label="Wall clock per task" unit="duration" d={tasks.wallClockPerTask} />
                </div>
            )}
            {variants.length > 0 ? <p className="muted">Includes {variants.join(', ')}.</p> : null}
            {output.partial > 0 ? <ObservedUsageNote /> : null}
        </TelemetryFrame>
    );
}
