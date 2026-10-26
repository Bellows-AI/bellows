import { useState } from 'react';
import { inputTokens, type TelemetryStats, type Tokens } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import { BarChart } from '../charts/BarChart.js';
import { PAD } from '../charts/scale.js';
import { TOKEN_TYPE_LABELS, USAGE_TOKEN_TYPES, figure } from '../components/usage/usage-format.js';
import { TelemetryFrame } from './TelemetryFrame.js';

/** One bucket: the compact treatment keeps a real bar — never one bar stretched across the full plot. */
const COMPACT = { width: 480, height: 200 };
/** The main chart's plot height, excluding the axis padding. */
const MAIN_PLOT_HEIGHT = 360;
/** The full-width chart: 1120 is roughly the panel's content box at 1440 (sidebar, page and panel
 * padding removed), so the SVG draws near 1:1 there and the plot reads at its 360px. */
const MAIN = { width: 1120, height: MAIN_PLOT_HEIGHT + PAD.top + PAD.bottom };
/** Where `MM-DD` starts within a `YYYY-MM-DD` bucket start — the axis label drops the year. */
const MONTH_DAY_START_INDEX = 5;
/** The X-axis's target label count — roughly one label every N/12 bars, whatever N is. */
const CHART_LABEL_TARGET_COUNT = 12;

export interface ChartPoint {
    start: string;
    partial: boolean;
    sessions: number;
    /** Null: the bucket holds no token figure at all (no usage was observed in it). */
    tokens: Tokens | null;
}

/**
 * Tokens bucket by the instant a point was observed, sessions by when the session began, so the
 * two series come as separate lists on one granularity; the chart reads their union by bucket
 * start. A bucket only one list carries keeps the other side unmeasured (tokens) or zero
 * (sessions: none began there).
 */
export function chartPoints({ series, usage }: Pick<TelemetryStats, 'series' | 'usage'>): ChartPoint[] {
    const byStart = new Map<string, ChartPoint>();
    for (const p of series.points) {
        byStart.set(p.start, { start: p.start, partial: p.partial, sessions: p.sessions, tokens: null });
    }
    for (const p of usage.series.points) {
        const existing = byStart.get(p.start) ?? { start: p.start, partial: false, sessions: 0, tokens: null };
        byStart.set(p.start, {
            ...existing,
            partial: existing.partial || p.partial,
            tokens: p.usage.state === 'unmeasured' ? null : p.usage.tokens,
        });
    }
    return [...byStart.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/** The four types of a bucket for its tooltip; an unmeasured type reads as a dash, never zero. */
const readoutOf = (t: Tokens | null): string[] =>
    USAGE_TOKEN_TYPES.map((type) => `${TOKEN_TYPE_LABELS[type]} ${figure(t?.[type] ?? null)}`);

/**
 * The usage chart. The bucket size is the server's decision — daily up to 92 days of window,
 * weekly beyond — and the payload NAMES it, so the caption and disclosure describe what is
 * actually rendered. A chart that said "per ISO week" over daily bars (or the reverse) would
 * be a lie with correct numbers.
 */
export function TokenUsagePanel({ telemetry, meta }: { telemetry: TelemetryStats; meta: TelemetryMeta }) {
    const { granularity } = telemetry.series;
    const points = chartPoints(telemetry);
    const daily = granularity === 'day';
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    const toggle = (id: string) =>
        setHidden((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const caption = daily
        ? 'Input and output tokens by day; sessions use the right axis.'
        : 'Input and output tokens by ISO week; sessions use the right axis.';
    const hasPartial = points.some((p) => p.partial);
    const dims = points.length === 1 ? COMPACT : MAIN;

    return (
        <TelemetryFrame title="AI token usage" meta={meta}>
            {points.length === 0 ? (
                <p className="muted">
                    No sessions in the coverage window yet. Start a Claude Code session in{' '}
                    <code>{meta.repoFilter}</code>.
                </p>
            ) : (
                <>
                    {/* Toggles, not decoration: pressed state names what is on, the swatch + text
                        keep each series identifiable without color alone. */}
                    <div className="legend">
                        <button
                            type="button"
                            className="legend-button"
                            aria-pressed={!hidden.has('input')}
                            onClick={() => toggle('input')}
                        >
                            <span className="swatch swatch-primary" aria-hidden="true" />
                            Total input
                        </button>
                        <button
                            type="button"
                            className="legend-button"
                            aria-pressed={!hidden.has('output')}
                            onClick={() => toggle('output')}
                        >
                            <span className="swatch swatch-ok" aria-hidden="true" />
                            Output
                        </button>
                        <button
                            type="button"
                            className="legend-button"
                            aria-pressed={!hidden.has('sessions')}
                            onClick={() => toggle('sessions')}
                        >
                            <span className="swatch swatch-warn" aria-hidden="true" />
                            Sessions
                        </button>
                    </div>
                    <div className="chart-wrap">
                        <BarChart
                            ariaLabel={daily ? 'Tokens and sessions by day' : 'Tokens and sessions by ISO week'}
                            labels={points.map((p) => p.start.slice(MONTH_DAY_START_INDEX))}
                            bucketLabels={points.map((p) => (daily ? p.start : `Week of ${p.start}`))}
                            partial={points.map((p) => p.partial)}
                            series={[
                                {
                                    id: 'input',
                                    label: 'Total input',
                                    // Raw, uncoerced: an unmeasured bucket reads as a dash in the
                                    // exact readout, never as a fabricated zero. Geometry coerces.
                                    values: points.map((p) => (p.tokens === null ? null : inputTokens(p.tokens).total)),
                                    className: 'bar-primary',
                                },
                                {
                                    id: 'output',
                                    label: 'Output',
                                    values: points.map((p) => p.tokens?.output ?? null),
                                    className: 'bar-ok',
                                },
                            ]}
                            readoutExtra={points.map((p) => readoutOf(p.tokens))}
                            line={{ id: 'sessions', label: 'Sessions', values: points.map((p) => p.sessions) }}
                            hiddenSeries={hidden}
                            leftAxisLabel="Tokens"
                            width={dims.width}
                            height={dims.height}
                            // 92 daily points ÷ 12 labels ≈ one label every 8 bars: still legible.
                            labelEvery={Math.ceil(points.length / CHART_LABEL_TARGET_COUNT)}
                        />
                    </div>
                    <p className="chart-caption">
                        {caption}
                        {hasPartial ? ' The hatched bucket is a partial period.' : null}
                    </p>
                    <details className="chart-disclosure">
                        <summary>How this is calculated</summary>
                        <p>
                            Bars stack Total input over Output on the left Tokens axis; the Sessions line reads the
                            right Sessions axis. Total input counts uncached input plus cache reads and writes — every
                            prompt token the model processed, so a long cached conversation counts its context on every
                            request. Quiet buckets are kept, never closed. A window through 92 days renders daily
                            buckets; longer windows render ISO weeks. The hatched bucket is the current day or week,
                            still partial.
                        </p>
                    </details>
                </>
            )}
        </TelemetryFrame>
    );
}
