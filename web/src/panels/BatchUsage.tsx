import type { UsageBlock } from '@factory-ai/core';
import { CoverageNote, ObservedUsageNote } from '../components/usage/CoverageNote.js';
import { TokenFigures } from '../components/usage/TokenFigures.js';
import { UsageBreakdown } from '../components/usage/UsageBreakdown.js';
import { UsageDiagnostics } from '../components/usage/UsageDiagnostics.js';
import { UsageStateNote } from '../components/usage/UsageStateNote.js';
import { timestamp } from '../format.js';
import { batchUsageState, type BatchReportView, type BatchUsageUnavailable } from '../batch-model.js';

/**
 * Token usage of a batch: the four types side by side, from the report's one snapshot. The unavailable,
 * unmeasured and measured-zero states read apart, and none of them touches the scheduling UI around it.
 */

const REMOVED_TEXT = 'Usage is unavailable: the task was removed after the batch started.';

const plural = (count: number) => (count === 1 ? '1 task was' : `${count} tasks were`);

function Figures({ block }: { block: UsageBlock }) {
    return (
        <>
            <TokenFigures tokens={block.tokens} precision={block.precision} coverage={block.coverage} />
            <CoverageNote coverage={block.coverage} />
            {block.rows.length === 0 ? null : (
                <details className="batch-usage-more">
                    <summary>Usage by model</summary>
                    <UsageBreakdown usage={block} />
                </details>
            )}
            <UsageDiagnostics usage={block} />
        </>
    );
}

/** The batch's usage section. `report` null with `reportFailed` is an outage, not a zero. */
export function BatchUsage({ report, reportFailed }: { report: BatchReportView | null; reportFailed: boolean }) {
    const view = batchUsageState(report, reportFailed);
    const block = report?.totals.tokenUsage;
    return (
        <section className="panel batch-usage" aria-labelledby="batch-usage-title" data-usage-state={view.state}>
            <h2 id="batch-usage-title">Token usage</h2>
            {view.state === 'loading' ? <UsageStateNote loading /> : null}
            {view.state === 'unavailable' || view.state === 'unmeasured' ? (
                <UsageStateNote block={{ state: view.state, provisional: false }} />
            ) : null}
            {view.state === 'measured' && block !== undefined ? (
                <>
                    {view.provisional && report !== null ? (
                        <p className="usage-state-note" role="status">
                            Live: provisional as of {timestamp(report.usageSnapshotAt)} UTC.
                        </p>
                    ) : null}
                    <Figures block={block} />
                    <ObservedUsageNote />
                </>
            ) : null}
            {view.unavailableTasks > 0 ? (
                <p className="usage-state-note" role="status" data-partial="true">
                    Partial: usage of {plural(view.unavailableTasks)} removed after the batch started and is not in the
                    figures.
                </p>
            ) : null}
        </section>
    );
}

/** A task card's usage: four figures in one compact block, the model rows behind a disclosure. */
export function TaskUsage({
    usage,
}: {
    usage: { tokenUsage: UsageBlock; tokenUsageUnavailable: BatchUsageUnavailable | null };
}) {
    const { tokenUsage: block, tokenUsageUnavailable } = usage;
    if (tokenUsageUnavailable === 'task-removed') {
        return <p className="usage-state-note batch-task-usage">{REMOVED_TEXT}</p>;
    }
    if (block.state !== 'measured') {
        return (
            <div className="batch-task-usage">
                <UsageStateNote block={{ state: block.state, provisional: false }} />
            </div>
        );
    }
    return (
        <div className="batch-task-usage" data-usage-state="measured">
            <Figures block={block} />
        </div>
    );
}
