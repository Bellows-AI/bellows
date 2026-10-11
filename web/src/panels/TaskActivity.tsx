import { useState } from 'react';
import type { ThreadActivity } from '../api/useJobActivity.js';
import type { Job } from '../api/useJobs.js';
import { PulseChart } from '../charts/PulseChart.js';
import { TaskStatsDialog } from '../components/TaskStatsDialog.js';
import { figure, taskStats } from '../task-stats.js';

/**
 * The task activity summary (issue 530, from 339's run-activity panel): a compact pulse of the
 * latest run's recorded tokens, by type, and the thread's run and agent-turn counts — all one
 * button that opens the Task statistics modal, so the sidebar stays small and the detail is a
 * click, Enter or Space away. Props in, markup out: the fetch is the page's (`useThreadActivity`)
 * and a run the pipeline holds nothing about renders one quiet sentence, never a zero line.
 */
export function TaskActivity({ jobs, activity }: { jobs: readonly Job[]; activity: ThreadActivity }) {
    const [open, setOpen] = useState(false);
    const stats = taskStats(jobs, activity);
    const latest = stats.runs[stats.runs.length - 1]!;
    const buckets = latest.activity?.buckets ?? [];
    const scope = `Latest run (Run ${latest.number})`;
    const turns = figure(stats.agentTurns.value);
    const runs = `${stats.runs.length} ${stats.runs.length === 1 ? 'run' : 'runs'}`;
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
                <span className="task-stats-summary">
                    {runs} · {turns} agent turns
                </span>
            </button>
            <TaskStatsDialog open={open} stats={stats} onClose={() => setOpen(false)} />
        </section>
    );
}
