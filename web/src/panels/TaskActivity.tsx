import { useState } from 'react';
import type { ThreadActivity } from '../api/useJobActivity.js';
import type { Job } from '../api/useJobs.js';
import { PulseChart } from '../charts/PulseChart.js';
import { TaskStatsDialog } from '../components/TaskStatsDialog.js';
import { figure, precisionMark, TOKEN_TYPE_LABELS, USAGE_TOKEN_TYPES } from '../components/usage/usage-format.js';
import { taskStats } from '../task-stats.js';

/**
 * The task activity summary (issue 530, from 339's run-activity panel): a compact pulse of the
 * latest run's recorded tokens, by type (a gap where a bucket measured none), and the thread's run and agent-turn counts — all one
 * button that opens the Task statistics modal, so the sidebar stays small and the detail is a
 * click, Enter or Space away. Props in, markup out: the fetch is the page's (`useThreadActivity`)
 * and a run the pipeline holds nothing about renders one quiet sentence, never a zero line.
 */
export function TaskActivity({ jobs, activity }: { jobs: readonly Job[]; activity: ThreadActivity }) {
    const [open, setOpen] = useState(false);
    const stats = taskStats(jobs, activity);
    const latest = stats.runs[jobs.length - 1]!;
    const buckets = latest.activity?.buckets ?? [];
    const scope = `Latest run (Run ${latest.number})`;
    const turns = figure(stats.agentTurns.value);
    const runs = `${jobs.length} ${jobs.length === 1 ? 'run' : 'runs'}`;
    let pulse = <span className="muted">No telemetry for this run.</span>;
    if (latest.telemetry === 'loading') pulse = <span className="muted">Loading telemetry…</span>;
    else if (buckets.length > 0) {
        pulse = (
            <PulseChart
                buckets={buckets}
                ariaLabel={`Tokens by type over the latest run's wall clock: input, output, cache read and cache creation`}
            />
        );
    }
    return (
        <section className="panel task-activity">
            <div className="panel-head">
                <h2>Task activity</h2>
            </div>
            <button
                type="button"
                className="task-stats-trigger"
                aria-haspopup="dialog"
                aria-label={`Open task statistics: ${runs}, ${turns} agent turns`}
                onClick={() => setOpen(true)}
            >
                <span className="task-stats-scope">{scope}</span>
                {pulse}
                {latest.usage?.state === 'measured' ? (
                    <span className="task-stats-line">
                        {USAGE_TOKEN_TYPES.map((type) => (
                            <span key={type} data-type={type}>
                                {TOKEN_TYPE_LABELS[type]} {figure(latest.usage!.tokens[type])}
                                {precisionMark(latest.usage!.precision[type])}
                            </span>
                        ))}
                    </span>
                ) : null}
                <span className="task-stats-summary">
                    {runs} · {turns} agent turns
                </span>
            </button>
            <TaskStatsDialog open={open} stats={stats} onClose={() => setOpen(false)} />
        </section>
    );
}
