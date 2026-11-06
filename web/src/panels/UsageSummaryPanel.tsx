import type { ReactNode } from 'react';
import { inputTokens, type TelemetryStats } from '@factory-ai/core';
import type { StatsPayload } from '../api/useStats.js';
import { Sparkline } from '../charts/Sparkline.js';
import { duration, int, num, pct, tokens } from '../format.js';
import { InfoTip } from '../components/usage/InfoTip.js';
import { ModelUsageTable } from '../components/usage/ModelUsageTable.js';
import { TokenFigures } from '../components/usage/TokenFigures.js';
import { UsageStateNote } from '../components/usage/UsageStateNote.js';
import { totalTokens } from '../components/usage/usage-format.js';

/**
 * One card of the strip: a muted label above one bold figure, an optional small visual, and at
 * most a short caption. Every card keeps the same height, so no card grows a column of figures.
 */
function MetricCard({
    label,
    value,
    info,
    visual,
    caption,
}: {
    label: string;
    value: string;
    info?: ReactNode;
    visual?: ReactNode;
    caption?: string | null;
}) {
    return (
        <div className="usage-group">
            <div className="usage-body">
                <span className="usage-label">
                    {label}
                    {info}
                </span>
                <strong className={value === '—' ? 'usage-unmeasured' : undefined}>{value}</strong>
                {visual ? <div className="usage-visual">{visual}</div> : null}
                {caption ? <span className="usage-caption">{caption}</span> : null}
            </div>
        </div>
    );
}

/** A fraction to a CSS width percent. */
const PERCENT = 100;

/** A bucket start (`YYYY-MM-DD`, UTC) as "Nov 2". */
const shortDate = (start: string): string =>
    new Date(`${start}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The sessions card's visual and caption: the series as a sparkline, captioned by its peak bucket. */
function sessionTrend(series: TelemetryStats['series']): { visual: ReactNode; caption: string | null } {
    const { points, granularity } = series;
    const weekly = granularity === 'week';
    const labels = points.map((p) => (weekly ? `Week of ${shortDate(p.start)}` : shortDate(p.start)));
    const values = points.map((p) => p.sessions);
    const peak = Math.max(0, ...values);
    const at = points[values.indexOf(peak)];
    const caption =
        peak === 0 || at === undefined
            ? null
            : `Peak ${int(peak)} ${weekly ? 'in the week of' : 'on'} ${shortDate(at.start)}`;
    return {
        visual:
            points.length < 2 ? null : (
                <Sparkline values={values} labels={labels} partialLast={points.at(-1)?.partial ?? false} />
            ),
        caption,
    };
}

/** The acceptance copy keeps the measured denominator visible and never invents one. */
function editCaption(ea: TelemetryStats['totals']['editAcceptance']): string {
    if (ea.ratio !== null) return `${int(ea.accepted)} of ${int(ea.decisions)} edits accepted`;
    if (ea.accepted === null && ea.decisions !== null)
        return `${int(ea.decisions)} edit decisions measured, accepted count not recorded`;
    if (ea.accepted !== null) return `${int(ea.decisions)} measured edit decisions`;
    return 'Not measured';
}

/**
 * The metric summary: one open strip — Sessions, Total tokens, Active time, Edit acceptance —
 * each a label, one figure, one small visual and a short caption. Total tokens is the labelled
 * sum of input and output, always shown beside both parts; the four exact token types sit in
 * its info popover. No trend comparison or cost: the payload carries none. Null is unmeasured
 * and renders an em dash with "Not measured"; a measured zero renders 0.
 */
export function UsageSummaryPanel({ telemetry, meta }: { telemetry: TelemetryStats; meta: StatsPayload['meta'] }) {
    const t = telemetry.totals;
    const ea = t.editAcceptance;
    const usage = telemetry.usage.totals;
    const tk = usage.tokens;
    const input = inputTokens(tk);
    const trend = sessionTrend(telemetry.series);
    const perSession = t.activeHours === null || t.sessions === 0 ? null : t.activeHours / t.sessions;
    return (
        <section className="usage-summary">
            <h2>
                Usage summary
                {meta.telemetry.source === 'fixture' ? <span className="badge">synthetic fixture</span> : null}
            </h2>
            <div className="usage-groups">
                <MetricCard label="Sessions" value={num(t.sessions, 0)} visual={trend.visual} caption={trend.caption} />
                <MetricCard
                    label="Total tokens"
                    value={tokens(totalTokens(tk))}
                    info={
                        <InfoTip label="Token breakdown">
                            <TokenFigures tokens={tk} precision={usage.precision} coverage={usage.coverage} inputSide />
                        </InfoTip>
                    }
                    visual={
                        <dl className="usage-pair">
                            <div>
                                <dt>Input</dt>
                                <dd>{tokens(input.total)}</dd>
                            </div>
                            <div>
                                <dt>Output</dt>
                                <dd>{tokens(tk.output)}</dd>
                            </div>
                        </dl>
                    }
                    caption={
                        input.cacheHitRatio === null
                            ? 'Cache rate not measured'
                            : `Cache rate ${pct(input.cacheHitRatio)}`
                    }
                />
                <MetricCard
                    label="Active time"
                    value={duration(t.activeHours)}
                    caption={
                        t.activeHours === null
                            ? 'Not measured'
                            : perSession === null
                              ? null
                              : `≈ ${duration(perSession)} per session`
                    }
                />
                <MetricCard
                    label="Edit acceptance"
                    value={pct(ea.ratio)}
                    visual={
                        ea.ratio === null ? null : (
                            <span className="usage-meter" aria-hidden="true">
                                <span style={{ width: `${ea.ratio * PERCENT}%` }} />
                            </span>
                        )
                    }
                    caption={editCaption(ea)}
                />
            </div>
            <UsageStateNote block={usage} />
        </section>
    );
}

/** By model: collapsed under the usage chart, so the strip and the chart read first. */
export function UsageByModel({ telemetry }: { telemetry: TelemetryStats }) {
    const usage = telemetry.usage.totals;
    if (usage.rows.length === 0) return null;
    return (
        <details className="usage-by-model chart-disclosure">
            <summary>By model</summary>
            <ModelUsageTable usage={usage} />
        </details>
    );
}
