import type { TokenType } from '@factory-ai/core';
import type { JobActivityBucket } from '../api/useJobActivity.js';
import { TOKEN_TYPES } from '../task-stats.js';
import { formatTick, niceMax } from './scale.js';

/**
 * The pulse (issue 530): a static line chart of one run's recorded activity — one line per token
 * type (a null bucket is a gap in it, not a zero) over the run's wall-clock buckets, all on one
 * scale so the lines compare honestly. The compact form is the sidebar's picture, without axes; the
 * detailed form adds the scale and the run's span for the modal. Pure SVG, no animation: it shows
 * what was recorded, not that the run is alive.
 */

const COMPACT = { width: 120, height: 32, padX: 2, padY: 3 };
const DETAILED = { width: 480, height: 140, padX: 8, padY: 10 };

/** The run's span, labelled under the detailed pulse: the UTC clock of its first and last bucket. */
const ISO_CLOCK_START = 11;
const ISO_CLOCK_END = 16;
const clockOf = (iso: string): string => iso.slice(ISO_CLOCK_START, ISO_CLOCK_END);

interface Reading {
    index: number;
    value: number;
}

/** The consecutive measured readings of one type: a null bucket is a gap that splits the line, never a zero. */
function segmentsOf(buckets: readonly JobActivityBucket[], key: TokenType): Reading[][] {
    const segments: Reading[][] = [];
    let current: Reading[] = [];
    buckets.forEach((bucket, index) => {
        const value = bucket.tokens[key];
        if (value === null) {
            if (current.length > 0) segments.push(current);
            current = [];
        } else current.push({ index, value });
    });
    if (current.length > 0) segments.push(current);
    return segments;
}

export function PulseChart({
    buckets,
    ariaLabel,
    detailed = false,
}: {
    buckets: readonly JobActivityBucket[];
    ariaLabel: string;
    detailed?: boolean;
}) {
    const { width, height, padX, padY } = detailed ? DETAILED : COMPACT;
    // A type the run never measured has no line: null is not a zero reading.
    const measured = TOKEN_TYPES.filter((t) => buckets.some((bucket) => bucket.tokens[t.key] !== null));
    const peak = niceMax(Math.max(0, ...buckets.flatMap((bucket) => measured.map((t) => bucket.tokens[t.key] ?? 0))));
    const x = (i: number) =>
        buckets.length === 1 ? width / 2 : padX + (i / (buckets.length - 1)) * (width - 2 * padX);
    const y = (value: number) => height - padY - (value / peak) * (height - 2 * padY);
    return (
        <figure className={detailed ? 'pulse pulse-detailed' : 'pulse'}>
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
                <line className="pulse-axis" x1={padX} x2={width - padX} y1={height - padY} y2={height - padY} />
                {measured.map((type) => (
                    <g key={type.key} data-series={type.key} className={type.line}>
                        {segmentsOf(buckets, type.key).map((segment) => {
                            const first = segment[0]!;
                            // One reading between gaps has no line to draw: the dot is the recorded reading.
                            return segment.length === 1 ? (
                                <circle
                                    key={first.index}
                                    className="pulse-dot"
                                    cx={x(first.index)}
                                    cy={y(first.value)}
                                    r={2}
                                />
                            ) : (
                                <polyline
                                    key={first.index}
                                    className="pulse-line"
                                    points={segment.map((p) => `${x(p.index)},${y(p.value)}`).join(' ')}
                                />
                            );
                        })}
                    </g>
                ))}
            </svg>
            {detailed ? (
                <figcaption className="pulse-scale">
                    <span>Peak {formatTick(peak)} tokens per bucket</span>
                    <span>
                        {clockOf(buckets[0]!.start)}–{clockOf(buckets[buckets.length - 1]!.start)} UTC
                    </span>
                </figcaption>
            ) : null}
        </figure>
    );
}
