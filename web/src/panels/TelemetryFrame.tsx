import type { ReactNode } from 'react';
import type { TelemetryMeta } from '../api/useStats.js';

/**
 * The shared shell for every telemetry panel, so all four degrade identically.
 *
 * 'unreachable' renders the frame with a reason and no numbers, rather than dashes: a dash
 * means "measured, unavailable", and nothing was measured here. The 'fixture' badge is loud
 * because synthetic token counts sitting beside real PR numbers is precisely the
 * invented-number problem. `blurb` is optional: a panel may lead with its chart or table and
 * put its explanation after it (caption, disclosure) instead of a paragraph up top. `actions`
 * sit on the heading's row (a legend, a selector, an info popover); `compact` shrinks the heading
 * for a panel that is a band under the summary rather than a section of its own.
 */
export function TelemetryFrame({
    title,
    titleId,
    blurb,
    actions,
    compact,
    meta,
    children,
}: {
    title: string;
    /** The heading's id, so a table inside the frame can point its labelled region at it. */
    titleId?: string;
    blurb?: ReactNode;
    actions?: ReactNode;
    compact?: boolean;
    meta: TelemetryMeta;
    children: ReactNode;
}) {
    const broken = meta.status === 'unreachable';
    return (
        <section
            className={['panel', compact ? 'panel-compact' : null, broken ? 'bad' : null].filter(Boolean).join(' ')}
        >
            <div className="panel-head">
                <h2 id={titleId}>
                    {title}
                    {meta.source === 'fixture' ? <span className="badge">synthetic fixture</span> : null}
                </h2>
                {actions && !broken ? <div className="panel-head-actions">{actions}</div> : null}
            </div>
            {blurb ? <p className="muted">{blurb}</p> : null}
            {broken ? (
                <p className="alert">
                    Telemetry unavailable — {meta.reason ?? 'the telemetry store could not be read'}.
                </p>
            ) : (
                children
            )}
        </section>
    );
}
