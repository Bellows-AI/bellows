import { type ReactNode, useState } from 'react';
import type { ThreadActivity } from '../api/useJobActivity.js';
import type { AuthorRef, Job } from '../api/useJobs.js';
import { PulseChart } from '../charts/PulseChart.js';
import { KeyValues } from '../components/KeyValues.js';
import { RelativeTime } from '../components/RelativeTime.js';
import { TaskStatsDialog } from '../components/TaskStatsDialog.js';
import { figure, precisionMark, TOKEN_TYPE_LABELS, USAGE_TOKEN_TYPES } from '../components/usage/usage-format.js';
import { wallClock } from '../format.js';
import {
    newestTerminalExit,
    threadContextTokens,
    threadCostUsd,
    threadInterruptions,
    threadSetupMs,
    type ThreadInterruption,
} from '../task-outcome.js';
import { taskStats } from '../task-stats.js';
import { TaskSection } from './TaskSection.js';

/** `90433` reads as one number, not four; the locale is pinned so the suite can pin the markup. */
const tokenCount = new Intl.NumberFormat('en-US');
const COST_DECIMAL_PLACES = 4;

/** The task's queuer, resolved server-side from the audit rows. 'unknown' is the honest answer
 * for a pre-accounts row; the avatar renders only when the account carries one. */
function startedByNode(author: AuthorRef | null): ReactNode {
    if (author === null) return 'unknown';
    return (
        <span key="started-by" className="by-user-user">
            {author.avatarUrl !== null ? <img className="task-avatar" src={author.avatarUrl} alt="" /> : null}
            {author.name ?? author.login}
        </span>
    );
}

/**
 * The thread's execution facts: who started it, where and how it ran, what it cost. A value the
 * board does not carry omits its row entirely (a dash reads as a measurement, and nothing was
 * measured — issue 100).
 */
function executionPairs(jobs: Job[]): [string, ReactNode][] {
    const root = jobs[0]!;
    const latest = jobs[jobs.length - 1]!;
    const context = threadContextTokens(jobs);
    const cost = threadCostUsd(jobs);
    const setupMs = threadSetupMs(jobs);
    const exit = newestTerminalExit(jobs);
    const rows: [string, ReactNode][] = [
        ['Started by', startedByNode(root.author)],
        ['Repository', latest.repo],
        ['Base branch', latest.baseBranch ?? 'Default'],
        ['Executor', latest.executor ?? 'No executor selected'],
        ['Workflow', latest.workflowName],
        ['Workflow node', latest.workflowNode],
        // The thread's stored execution mode (issue 543): objective, or a workflow's graph.
        ['Mode', latest.mode],
        // The part of the wall clock environment.setup took before the agent started (issue 733).
        ['Environment setup', setupMs !== null ? wallClock(setupMs, null) : null],
        ['Exit', exit !== null ? String(exit) : null],
        ['Context', context !== null ? `${tokenCount.format(context)} tok` : null],
        ['Cost', cost !== null ? `$${cost.toFixed(COST_DECIMAL_PLACES)}` : null],
    ];
    return rows.filter(([, value]) => value !== null && value !== undefined);
}

/** Each attempt the infrastructure took (issue 796), refunded rather than counted — so an
 * interrupted task reads apart from a failed retry. Nothing when none was. */
function Interruptions({ interruptions, runs }: { interruptions: ThreadInterruption[]; runs: number }) {
    if (interruptions.length === 0) return null;
    return (
        <section>
            <h3 className="task-outcome-label">Interruptions</h3>
            <p className="muted">Lost to the infrastructure and retried — not counted as failed attempts.</p>
            <ol className="task-history">
                {interruptions.map((item) => (
                    <li key={`${item.run}-${item.claimSeq}-${item.at}`} className="task-history-item">
                        <span>
                            {runs > 1 ? `Run ${item.run}, claim ${item.claimSeq}` : `Claim ${item.claimSeq}`}:{' '}
                            {item.reason}
                        </span>
                        <RelativeTime at={item.at} />
                    </li>
                ))}
            </ol>
        </section>
    );
}

/**
 * The task activity tile: the thread's execution facts and interruptions, then (issue 530, from
 * 339's run-activity panel) a compact pulse of the latest run's recorded tokens, by type (a gap where a bucket measured none), and the thread's run
 * and agent-turn counts — all one button that opens the Task statistics modal, so the sidebar stays
 * small and the detail is a click, Enter or Space away. Props in, markup out: the fetch is the
 * page's (`useThreadActivity`) and a run the pipeline holds nothing about renders one quiet
 * sentence, never a zero line.
 */
export function TaskActivity({ jobs, activity }: { jobs: Job[]; activity: ThreadActivity }) {
    const [open, setOpen] = useState(false);
    const stats = taskStats(jobs, activity);
    const latest = stats.latest!;
    const buckets = latest.activity?.buckets ?? [];
    const scope = `Latest run (Run ${latest.number})`;
    const turns = figure(stats.agentTurns.value);
    const runCount = stats.usage?.counts.runs ?? jobs.length;
    const runs = `${runCount} ${runCount === 1 ? 'run' : 'runs'}`;
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
    const pairs = executionPairs(jobs);
    const context = threadContextTokens(jobs);
    const cost = threadCostUsd(jobs);
    const aside = [
        context !== null ? `${tokenCount.format(context)} tok` : null,
        cost !== null ? `$${cost.toFixed(COST_DECIMAL_PLACES)}` : null,
    ]
        .filter((part) => part !== null)
        .join(' · ');
    return (
        <TaskSection title="Task activity" className="task-activity" aside={aside === '' ? null : aside}>
            {pairs.length > 0 ? (
                <section>
                    <h3 className="task-outcome-label">Execution</h3>
                    <KeyValues pairs={pairs} />
                </section>
            ) : null}
            <Interruptions interruptions={threadInterruptions(jobs)} runs={jobs.length} />
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
        </TaskSection>
    );
}
