import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { PulseChart } from '../charts/PulseChart.js';
import { runDuration } from '../format.js';
import { coverageNote, figure, type RunStat, TOKEN_TYPES, type TaskStats } from '../task-stats.js';

/** What a figure cell says while its run's telemetry is still being fetched. */
const LOADING = 'Loading…';

/** One run's token cell: the measured figure, "Loading…" while asked for, "—" when never measured. */
const tokenCell = (run: RunStat, key: (typeof TOKEN_TYPES)[number]['key']): string => {
    if (run.telemetry === 'loading') return LOADING;
    return figure(run.tokens === null ? null : run.tokens[key]);
};

/** The run's own label: its number, and what makes its figures provisional. */
const runLabel = (run: RunStat): string => (run.live ? `Run ${run.number} (in progress)` : `Run ${run.number}`);

/**
 * The task statistics modal (issue 530): the thread's runs, agent turns and token totals with
 * every figure the sidebar pulse leaves out. Runs and Agent turns are the board's own words —
 * a run is one board execution, an agent turn one assistant response cycle in the root
 * conversation as the executor counted it at close. Tokens are measured per run from the run's
 * own telemetry window; nothing here spreads a total over agent turns, because time buckets do
 * not say which turn produced them.
 *
 * Headless UI owns the focus trap, Escape and the return of focus to the trigger that opened
 * it; the close button is the visible way out. Props in, markup out — the page owns the data.
 */
export function TaskStatsDialog({ open, stats, onClose }: { open: boolean; stats: TaskStats; onClose: () => void }) {
    const latest = stats.runs[stats.runs.length - 1];
    const buckets = latest?.activity?.buckets ?? [];
    const notes = [
        stats.provisional ? 'A run is still going: its figures are provisional and will change.' : null,
        coverageNote('Agent turns', stats.agentTurns),
        coverageNote('Tokens', stats.tokens),
        stats.reviews > 0
            ? `Token totals include ${stats.reviews} review ${stats.reviews === 1 ? 'run' : 'runs'}, which ${
                  stats.reviews === 1 ? 'is' : 'are'
              } not listed below.`
            : null,
    ].filter((note): note is string => note !== null);
    return (
        <Dialog open={open} onClose={onClose} className="dialog-layer">
            <DialogBackdrop className="dialog-backdrop" />
            <div className="dialog-position">
                <DialogPanel className="dialog task-stats">
                    <div className="task-stats-head">
                        <DialogTitle as="h2">Task statistics</DialogTitle>
                        <button type="button" className="chat-resume" onClick={onClose}>
                            Close
                        </button>
                    </div>
                    <dl className="task-stats-totals">
                        <div>
                            <dt>Runs</dt>
                            <dd>{stats.runs.length}</dd>
                        </div>
                        <div>
                            <dt>Agent turns</dt>
                            <dd>{figure(stats.agentTurns.value)}</dd>
                        </div>
                        {TOKEN_TYPES.map((type) => (
                            <div key={type.key}>
                                <dt>{type.label} tokens</dt>
                                <dd>
                                    {stats.tokens.value === null
                                        ? stats.loading
                                            ? LOADING
                                            : '—'
                                        : figure(stats.tokens.value[type.key])}
                                </dd>
                            </div>
                        ))}
                    </dl>
                    {notes.map((note) => (
                        <p key={note} className="task-stats-note">
                            {note}
                        </p>
                    ))}
                    {latest !== undefined && buckets.length > 0 ? (
                        <section className="task-stats-pulse">
                            <h3>Latest run (Run {latest.number}): tokens over time</h3>
                            <PulseChart
                                detailed
                                buckets={buckets}
                                ariaLabel={`Tokens by type over Run ${latest.number}'s wall clock`}
                            />
                            <ul className="pulse-legend">
                                {TOKEN_TYPES.map((type) => (
                                    <li key={type.key}>
                                        <span className={`pulse-swatch ${type.line}`} aria-hidden="true" />
                                        {type.label}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ) : null}
                    <section>
                        <h3>Runs</h3>
                        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable */}
                        <section className="task-stats-runs" aria-label="Per-run breakdown" tabIndex={0}>
                            <table>
                                <thead>
                                    <tr>
                                        <th scope="col">Run</th>
                                        <th scope="col">Status</th>
                                        <th scope="col">Duration</th>
                                        <th scope="col">Agent turns</th>
                                        {TOKEN_TYPES.map((type) => (
                                            <th key={type.key} scope="col">
                                                {type.label}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {stats.runs.map((run) => (
                                        <tr key={run.id}>
                                            <th scope="row">{runLabel(run)}</th>
                                            <td>{run.status}</td>
                                            <td>{runDuration(run.startedAt, run.finishedAt)}</td>
                                            <td>{figure(run.agentTurns)}</td>
                                            {TOKEN_TYPES.map((type) => (
                                                <td key={type.key}>{tokenCell(run, type.key)}</td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    </section>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
