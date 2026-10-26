import type { ReactNode } from 'react';
import { inputTokens, type TelemetryStats } from '@factory-ai/core';
import type { StatsPayload } from '../api/useStats.js';
import { duration, int, num, pct, tokens } from '../format.js';
import { selectionText } from '../dashboardSummary.js';
import { Icon, type IconName } from '../components/Icon.js';
import { TokenFigures } from '../components/usage/TokenFigures.js';
import { UsageBreakdown } from '../components/usage/UsageBreakdown.js';
import { UsageDiagnostics } from '../components/usage/UsageDiagnostics.js';
import { UsageStateNote } from '../components/usage/UsageStateNote.js';

/** The glyph inside a card's 40px disc. */
const DISC_ICON_SIZE = 24;

/** One metric card: the icon disc, then the figure, its label and its captions. */
function MetricCard({
    icon,
    value,
    label,
    ok = false,
    children,
}: {
    icon: IconName;
    value: string;
    label: string;
    /** Edit acceptance's disc sits on the ok wash; every other disc on the accent wash. */
    ok?: boolean;
    children: ReactNode;
}) {
    return (
        <div className="usage-group">
            <span className={ok ? 'usage-disc usage-disc-ok' : 'usage-disc'} aria-hidden="true">
                <Icon name={icon} size={DISC_ICON_SIZE} />
            </span>
            <div className="usage-body">
                <strong>{value}</strong>
                <span className="usage-label">{label}</span>
                {children}
            </div>
        </div>
    );
}

/** The wording of each attribution readout, in one place; every count stays a separate sentence. */
const ATTRIBUTION_READOUTS = {
    unresolvedOwnership: (n: number) => `${n} sessions whose task or repo could not be resolved`,
    excludedRepo: (n: number) => `${n} sessions attributed to a repo outside this selection`,
    sessionsWithoutHook: (n: number) => `${n} sessions with no hook report`,
    otherRepoSessions: (n: number) => `${n} sessions the hook attributed to another repo`,
} as const;

/** Tenant-safe counts only: never a session id, repo name or user. Nothing is rendered at zero. */
function AttributionReadouts({ telemetry }: { telemetry: TelemetryStats }) {
    const { unresolvedOwnership, excludedRepo } = telemetry.usage.diagnostics;
    const readouts = (
        [
            ['unresolvedOwnership', unresolvedOwnership.sessions],
            ['excludedRepo', excludedRepo.sessions],
            ['sessionsWithoutHook', telemetry.sessionsWithoutHook],
            ['otherRepoSessions', telemetry.otherRepoSessions],
        ] as const
    )
        .filter(([, count]) => count > 0)
        .map(([key, count]) => ATTRIBUTION_READOUTS[key](count));
    if (readouts.length === 0) return null;
    return (
        <ul className="usage-attribution">
            {readouts.map((text) => (
                <li key={text}>{text}</li>
            ))}
        </ul>
    );
}

/**
 * The metric summary: four cards — Sessions, Tokens, Active time, Edit acceptance — each an icon
 * disc beside its figure. The Tokens card headlines total input (the four token types are never
 * summed into one figure) with output, cache hit rate and the input parts in its captions. No
 * trend, comparison or cost: the payload carries none. Every figure speaks for the
 * payload it rendered from: the Sessions line names the rendered selection, never the
 * requested one, and never repeats the repository names the page header already carries.
 *
 * Null is unmeasured: the value renders as an em dash with a short Not measured note. A
 * measured zero is a real value and renders as 0.
 */
export function UsageSummaryPanel({ telemetry, meta }: { telemetry: TelemetryStats; meta: StatsPayload['meta'] }) {
    const t = telemetry.totals;
    const ea = t.editAcceptance;
    const usage = telemetry.usage.totals;
    const tk = usage.tokens;
    const input = inputTokens(tk);
    // The acceptance copy keeps the measured denominator visible and never invents one:
    // ratio present → "A of D measured..."; acceptances unmeasured with decisions measured →
    // name the decisions without a fabricated count; nothing measured → Not measured.
    const editNote =
        ea.ratio !== null
            ? `${int(ea.accepted)} of ${int(ea.decisions)} measured edit decisions accepted`
            : ea.accepted === null && ea.decisions !== null
              ? `${int(ea.decisions)} edit decisions measured, accepted count not recorded`
              : ea.accepted !== null
                ? `${int(ea.decisions)} measured edit decisions`
                : 'Not measured';
    return (
        <section className="usage-summary">
            <h2>
                Usage summary
                {meta.telemetry.source === 'fixture' ? <span className="badge">synthetic fixture</span> : null}
            </h2>
            <div className="usage-groups">
                <MetricCard icon="users" value={num(t.sessions, 0)} label="Sessions">
                    <span className="usage-caption">{selectionText(meta.range, meta.scope)}</span>
                </MetricCard>
                <MetricCard icon="layers" value={tokens(input.total)} label="Total input tokens">
                    <span className="usage-caption">
                        {input.cacheHitRatio === null
                            ? 'Cache hit rate not measured'
                            : `${pct(input.cacheHitRatio)} cache hit rate`}
                    </span>
                    <TokenFigures tokens={tk} precision={usage.precision} coverage={usage.coverage} />
                </MetricCard>
                <MetricCard icon="clock" value={duration(t.activeHours)} label="Active time">
                    <span className="usage-caption">
                        {t.activeHours === null
                            ? 'Not measured'
                            : `Across ${num(t.sessions, 0)} sessions · idle time excluded`}
                    </span>
                </MetricCard>
                <MetricCard icon="check" value={pct(ea.ratio)} label="Edit acceptance" ok>
                    <span className="usage-caption">{editNote}</span>
                </MetricCard>
            </div>
            <UsageStateNote block={usage} />
            {usage.rows.length > 0 ? (
                <details className="usage-by-model chart-disclosure">
                    <summary>By model</summary>
                    <UsageBreakdown usage={usage} />
                </details>
            ) : null}
            <UsageDiagnostics usage={usage}>
                <AttributionReadouts telemetry={telemetry} />
            </UsageDiagnostics>
        </section>
    );
}
