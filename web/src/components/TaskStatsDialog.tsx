import { useId, useState } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import type { UsageBlock } from '@factory-ai/core';
import type { GateActivity, PrActivity } from '../api/useJobActivity.js';
import { PulseChart } from '../charts/PulseChart.js';
import { runDuration } from '../format.js';
import { coverageNote, gateFigures, prFigures, type RunStat, TOKEN_TYPES, type TaskStats } from '../task-stats.js';
import { ObservedUsageNote } from './usage/CoverageNote.js';
import { PrecisionBadge } from './usage/PrecisionBadge.js';
import { TokenFigures } from './usage/TokenFigures.js';
import { UsageBreakdown } from './usage/UsageBreakdown.js';
import { UsageDiagnostics } from './usage/UsageDiagnostics.js';
import { UsageStateNote } from './usage/UsageStateNote.js';
import { figure, TOKEN_TYPE_LABELS, UNASSIGNED_SENTENCES, USAGE_TOKEN_TYPES } from './usage/usage-format.js';

/** What a figure cell says while its run's telemetry is still being fetched. */
const LOADING = 'Loading…';

/** Run, Status, Duration and Agent turns precede the four token columns. */
const LEADING_COLUMNS = 4;

const UNAVAILABLE_BLOCK = { state: 'unavailable', provisional: false } as const;
const UNMEASURED_BLOCK = { state: 'unmeasured', provisional: false } as const;

/** One run's token cell: the measured figure with its precision mark, "Loading…" while asked for, "—" when never measured. */
function TokenCell({ run, type }: { run: RunStat; type: (typeof USAGE_TOKEN_TYPES)[number] }) {
    if (run.telemetry === 'loading') return <td>{LOADING}</td>;
    return (
        <td>
            {figure(run.usage === null ? null : run.usage.tokens[type])}
            <PrecisionBadge precision={run.usage?.precision[type] ?? null} />
        </td>
    );
}

/** What makes a run's figures provisional or its row unusual, in words. */
function runNotes(run: RunStat): string[] {
    return [run.live ? 'in progress' : null, run.operational ? null : 'run no longer on the board'].filter(
        (note): note is string => note !== null
    );
}

/** One run's row, and (once expanded) the models and diagnostics behind its four figures. */
function RunRows({ run }: { run: RunStat }) {
    const [expanded, setExpanded] = useState(false);
    const detailId = useId();
    const notes = runNotes(run);
    const detail = run.usage !== null && (run.usage.rows.length > 0 || run.usage.unassigned.length > 0);
    return (
        <>
            <tr data-kind={run.kind}>
                <th scope="row">
                    {run.label}
                    {notes.length === 0 ? null : <small className="task-stats-run-note"> ({notes.join(', ')})</small>}
                    {detail ? (
                        <button
                            type="button"
                            className="task-stats-toggle"
                            aria-expanded={expanded}
                            aria-controls={expanded ? detailId : undefined}
                            aria-label={`${expanded ? 'Hide' : 'Show'} usage details for ${run.label}`}
                            onClick={() => setExpanded(!expanded)}
                        >
                            {expanded ? 'Hide' : 'Details'}
                        </button>
                    ) : null}
                </th>
                <td>{run.status ?? '—'}</td>
                <td>{runDuration(run.startedAt, run.finishedAt)}</td>
                <td>{figure(run.agentTurns)}</td>
                {USAGE_TOKEN_TYPES.map((type) => (
                    <TokenCell key={type} run={run} type={type} />
                ))}
            </tr>
            {expanded && run.usage !== null ? (
                <tr id={detailId} className="task-stats-detail">
                    <td colSpan={LEADING_COLUMNS + USAGE_TOKEN_TYPES.length}>
                        <UsageBreakdown usage={run.usage} />
                        <UsageDiagnostics usage={run.usage} />
                    </td>
                </tr>
            ) : null}
        </>
    );
}

/** The task-owned amount as its own row: tokens no run owns, each with the reason it has no run. */
function TaskOwned({ block }: { block: UsageBlock }) {
    return (
        <section className="task-stats-owned" aria-label="Task-owned, not assigned to a run">
            <h3>Task-owned, not assigned to a run</h3>
            <TokenFigures tokens={block.tokens} precision={block.precision} coverage={block.coverage} />
            <ul>
                {block.unassigned.map((entry) => (
                    <li key={entry.reason} data-reason={entry.reason}>
                        {UNASSIGNED_SENTENCES[entry.reason]}
                        <TokenFigures tokens={entry.tokens} />
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** The block whose state the note words: the task's with the thread's provisional mark, else why there is none. */
function stateBlockOf(stats: TaskStats): Pick<UsageBlock, 'state' | 'provisional'> | null {
    if (stats.telemetry === 'unavailable') return UNAVAILABLE_BLOCK;
    if (stats.usage !== null) return { state: stats.usage.state, provisional: stats.provisional };
    return stats.telemetry === 'none' ? UNMEASURED_BLOCK : null;
}

/** Task usage: the canonical `task.usage` figures, their state and the standing notes. */
function UsageSection({ stats }: { stats: TaskStats }) {
    const usage = stats.usage;
    const stateBlock = stateBlockOf(stats);
    const turnsNote = coverageNote('Agent turns', stats.agentTurns);
    return (
        <section className="task-stats-usage" aria-label="Task usage">
            <h3>Task usage</h3>
            <dl className="task-stats-totals">
                <div>
                    <dt>Runs</dt>
                    <dd>{usage === null ? stats.runs.length : usage.counts.runs}</dd>
                </div>
                <div>
                    <dt>Agent turns</dt>
                    <dd>{figure(stats.agentTurns.value)}</dd>
                </div>
            </dl>
            {usage === null ? null : (
                <TokenFigures tokens={usage.tokens} precision={usage.precision} coverage={usage.coverage} inputSide />
            )}
            {stats.telemetry === 'loading' ? (
                <UsageStateNote loading />
            ) : stateBlock === null ? null : (
                <UsageStateNote block={stateBlock} />
            )}
            {turnsNote === null ? null : <p className="task-stats-note">{turnsNote}</p>}
            {stats.reviews > 0 ? (
                <p className="task-stats-note">
                    Includes {stats.reviews} review {stats.reviews === 1 ? 'run' : 'runs'}.
                </p>
            ) : null}
            <ObservedUsageNote />
        </section>
    );
}

/** Gate executions of the task by outcome and measured duration; "—" and a note where the board recorded less. */
function GatesSection({ gates }: { gates: GateActivity }) {
    const figures = gateFigures(gates);
    return (
        <section className="task-stats-usage" aria-label="Gates">
            <h3>Gates</h3>
            <dl className="task-stats-totals">
                <div>
                    <dt>Executions</dt>
                    <dd>{figures.executions}</dd>
                </div>
                {figures.outcomes.map((outcome) => (
                    <div key={outcome.key}>
                        <dt>{outcome.label}</dt>
                        <dd>{outcome.count}</dd>
                    </div>
                ))}
                <div>
                    <dt>Duration</dt>
                    <dd>{figures.duration}</dd>
                </div>
            </dl>
            {figures.durationNote === null ? null : <p className="task-stats-note">{figures.durationNote}</p>}
            {figures.reused.length === 0 ? null : (
                <ul className="task-stats-note">
                    {figures.reused.map((r) => (
                        <li key={`${r.gate}-${r.text}`}>
                            {r.gate} <span className="badge">reused</span> {r.text}
                        </li>
                    ))}
                </ul>
            )}
            {figures.observed === null ? null : <p className="task-stats-note">{figures.observed}</p>}
            {figures.partial ? (
                <p className="task-stats-note">Coverage is partial: some executions are unmeasured or unconfirmed.</p>
            ) : null}
        </section>
    );
}

/** The PRs the task's runs created or reused: operation and distinct-PR counts apart, each PR linked once. */
function PullRequestsSection({ prs }: { prs: PrActivity }) {
    const figures = prFigures(prs);
    return (
        <section className="task-stats-usage" aria-label="Pull requests">
            <h3>Pull requests</h3>
            <dl className="task-stats-totals">
                <div>
                    <dt>Operations</dt>
                    <dd>{figures.operations}</dd>
                </div>
                <div>
                    <dt>Distinct PRs</dt>
                    <dd>{figures.distinct}</dd>
                </div>
                {figures.byKind.map((kind) => (
                    <div key={kind.label}>
                        <dt>{kind.label}</dt>
                        <dd>{kind.count}</dd>
                    </div>
                ))}
            </dl>
            {figures.links.length === 0 ? null : (
                <ul className="task-stats-note">
                    {figures.links.map((link) => (
                        <li key={link.url}>
                            <a href={link.url} target="_blank" rel="noreferrer">
                                {link.label}
                            </a>
                        </li>
                    ))}
                </ul>
            )}
            {figures.partial ? (
                <p className="task-stats-note">Coverage is partial: some pull-request calls were not confirmed.</p>
            ) : null}
        </section>
    );
}

/**
 * The task statistics modal (issues 530, 848): the canonical task's usage - review runs and
 * run-unassigned amounts included - then one row per run, the task-owned row, what the figures
 * leave out, and the models. Every figure is `task.usage` or a `task.runs[]` entry; nothing is
 * summed here, and the four token types are never combined.
 *
 * Headless UI owns the focus trap, Escape and the return of focus to the trigger that opened
 * it; the close button is the visible way out. Props in, markup out — the page owns the data.
 */
export function TaskStatsDialog({ open, stats, onClose }: { open: boolean; stats: TaskStats; onClose: () => void }) {
    const latest = stats.latest;
    const buckets = latest?.activity?.buckets ?? [];
    const usage = stats.usage;
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
                    <UsageSection stats={stats} />
                    {stats.gates === null ? null : <GatesSection gates={stats.gates} />}
                    {stats.prs === null ? null : <PullRequestsSection prs={stats.prs} />}
                    {latest !== null && buckets.length > 0 ? (
                        <section className="task-stats-pulse">
                            <h3>Latest run ({latest.label}): tokens over time</h3>
                            <PulseChart
                                detailed
                                buckets={buckets}
                                ariaLabel={`Tokens by type over ${latest.label}'s wall clock`}
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
                                        {USAGE_TOKEN_TYPES.map((type) => (
                                            <th key={type} scope="col">
                                                {TOKEN_TYPE_LABELS[type]}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {stats.runs.map((run) => (
                                        <RunRows key={run.id} run={run} />
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    </section>
                    {stats.taskOwned === null ? null : <TaskOwned block={stats.taskOwned} />}
                    {usage === null ? null : (
                        <UsageDiagnostics
                            usage={{ ...usage, unassigned: stats.taskOwned === null ? usage.unassigned : [] }}
                        />
                    )}
                    {usage === null || usage.rows.length === 0 ? null : (
                        <section className="task-stats-models" aria-label="Models">
                            <h3>Models</h3>
                            <UsageBreakdown usage={usage} />
                        </section>
                    )}
                </DialogPanel>
            </div>
        </Dialog>
    );
}
