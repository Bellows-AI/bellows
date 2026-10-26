import { useState } from 'react';
import { inputTokens, type TelemetryStats, type TokenType, type Tokens, type UsageBlock } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import type { DataTableColumn } from '../components/DataTable.js';
import { DataTable } from '../components/DataTable.js';
import { UsageBreakdown } from '../components/usage/UsageBreakdown.js';
import {
    TOKEN_TYPE_LABELS,
    TOTAL_INPUT_CAPTION,
    TOTAL_INPUT_LABEL,
    USAGE_TOKEN_TYPES,
} from '../components/usage/usage-format.js';
import { tokens } from '../format.js';
import { TelemetryFrame } from './TelemetryFrame.js';

/** What the ranking bar compares: the labelled input-side sum, or one of the four types. */
export type UserMetric = 'inputSide' | TokenType;
export const DEFAULT_USER_METRIC: UserMetric = 'inputSide';
const METRIC_OPTIONS: readonly UserMetric[] = ['inputSide', ...USAGE_TOKEN_TYPES];
export const metricLabel = (metric: UserMetric): string =>
    metric === 'inputSide' ? TOTAL_INPUT_LABEL : TOKEN_TYPE_LABELS[metric];

/**
 * One user's rollup as the table renders it — the view model in front of `TelemetryStats.byUser`
 * (session counts), joined by user id to `TelemetryStats.usage.byUser` (token figures). Token
 * authors with no session row (and the unknown author, `userId` null) still get a row, with
 * `sessions` null unless the payload counts them. The four types stay apart; `inputSide` is the
 * one sanctioned sum (core's null-aware `inputTokens`) and `selected` the value the bar ranks.
 */
export interface ByUserRow {
    id: string;
    name: string;
    /** The raw author id of a user the roster does not know: tooltip only, never the label. */
    title: string | null;
    avatarUrl: string | null;
    sessions: number | null;
    tokens: Tokens;
    inputSide: number | null;
    selected: number | null;
    /**
     * The selected value as a share of the largest one IN THE RENDERED ROWS, 0–100. A measured value
     * gets at least 1 unless it is 0; null when there is nothing to compare (unmeasured, or every
     * value 0), where no track renders.
     */
    barPct: number | null;
    usage: UsageBlock | null;
}

const BAR_PCT_MULTIPLIER = 100;
/** Row key of the unknown author; a real user id is never this. */
const NO_USER_ID = '\u0000no-user';
const UNMEASURED: Tokens = { input: null, output: null, cacheRead: null, cacheCreation: null };

type Person = Pick<ByUserRow, 'id' | 'name' | 'title' | 'avatarUrl' | 'sessions'>;

function people(
    { byUser, usage, unattributedSessions }: Pick<TelemetryStats, 'byUser' | 'usage' | 'unattributedSessions'>,
    scope: 'org' | 'mine'
): Person[] {
    const out: Person[] = byUser.map(({ user, sessions }) => ({
        id: user.id,
        name: user.name ?? user.login,
        title: null,
        avatarUrl: user.avatarUrl,
        sessions,
    }));
    const known = new Set(out.map((p) => p.id));
    for (const { userId, user } of usage.byUser) {
        if (userId === null || known.has(userId)) continue;
        known.add(userId);
        out.push({
            id: userId,
            name: user ? (user.name ?? user.login) : 'Unknown user',
            title: user ? null : userId,
            avatarUrl: user?.avatarUrl ?? null,
            sessions: null,
        });
    }
    if (usage.byUser.some((u) => u.userId === null)) {
        // Sessions with no user are an organization figure; the caller's own scope has none.
        out.push({
            id: NO_USER_ID,
            name: 'No user',
            title: null,
            avatarUrl: null,
            sessions: scope === 'org' ? unattributedSessions : null,
        });
    }
    return out;
}

const selectedValue = (tokens: Tokens, inputSide: number | null, metric: UserMetric): number | null =>
    metric === 'inputSide' ? inputSide : tokens[metric];

export function byUserRows(
    telemetry: Pick<TelemetryStats, 'byUser' | 'usage' | 'unattributedSessions'>,
    metric: UserMetric = DEFAULT_USER_METRIC,
    scope: 'org' | 'mine' = 'org'
): ByUserRow[] {
    const usageOf = new Map(telemetry.usage.byUser.map((u) => [u.userId ?? NO_USER_ID, u.usage]));
    const rows = people(telemetry, scope).map((person) => {
        const usage = usageOf.get(person.id) ?? null;
        const tokens = usage?.tokens ?? UNMEASURED;
        const inputSide = inputTokens(tokens).total;
        return {
            ...person,
            tokens,
            inputSide,
            selected: selectedValue(tokens, inputSide, metric),
            barPct: null,
            usage,
        };
    });
    const max = Math.max(0, ...rows.map((row) => row.selected ?? 0));
    return rows.map((row) => ({
        ...row,
        barPct:
            row.selected === null || max === 0
                ? null
                : row.selected === 0
                  ? 0
                  : Math.max(1, Math.round((row.selected / max) * BAR_PCT_MULTIPLIER)),
    }));
}

const typeColumn = (type: TokenType): DataTableColumn<ByUserRow> => ({
    key: type,
    label: TOKEN_TYPE_LABELS[type],
    align: 'end',
    cell: (row) => tokens(row.tokens[type]),
    sortValue: (row) => row.tokens[type],
});

function columnsFor(
    metric: UserMetric,
    expanded: ReadonlySet<string>,
    toggle: (id: string) => void
): DataTableColumn<ByUserRow>[] {
    const label = metricLabel(metric);
    return [
        {
            key: 'name',
            label: 'User',
            cell: (row) => (
                <span className="by-user-user" title={row.title ?? undefined}>
                    {row.avatarUrl !== null ? <img className="task-avatar" src={row.avatarUrl} alt="" /> : null}
                    {row.name}
                    {row.usage !== null && row.usage.rows.length > 0 ? (
                        <button
                            type="button"
                            className="by-user-models-toggle"
                            aria-expanded={expanded.has(row.id)}
                            onClick={() => toggle(row.id)}
                        >
                            {expanded.has(row.id) ? `Hide models for ${row.name}` : `Show models for ${row.name}`}
                        </button>
                    ) : null}
                </span>
            ),
            sortValue: (row) => row.name,
        },
        {
            key: 'sessions',
            label: 'Sessions',
            cell: (row) => row.sessions ?? '—',
            sortValue: (row) => row.sessions,
            align: 'end',
        },
        {
            key: 'selected',
            label,
            align: 'end',
            sortValue: (row) => row.selected,
            name: (row) => (row.selected === null ? undefined : `${row.selected.toLocaleString('en-US')} ${label}`),
            cell: (row) => (
                <>
                    {tokens(row.selected)}
                    {/* Width is decoration; the exact figure is the cell's accessible name. An
                        unmeasured user gets the dash alone — no bar for a figure that does not exist. */}
                    {row.barPct !== null ? (
                        <span className="usage-track" aria-hidden="true">
                            <span className="usage-bar" style={{ width: `${row.barPct}%` }} />
                        </span>
                    ) : null}
                </>
            ),
        },
        ...USAGE_TOKEN_TYPES.map(typeColumn),
    ];
}

/** Who the agent sessions belong to, one row per user the board's audit rows resolve to. */
export function ByUserPanel({
    telemetry,
    meta,
    scope,
}: {
    telemetry: TelemetryStats;
    meta: TelemetryMeta;
    scope: 'org' | 'mine';
}) {
    const [metric, setMetric] = useState<UserMetric>(DEFAULT_USER_METRIC);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const toggle = (id: string) =>
        setExpanded((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
        });
    const rows = byUserRows(telemetry, metric, scope);
    const open = rows.filter((row) => expanded.has(row.id) && row.usage !== null);
    return (
        <TelemetryFrame
            title="Usage by user"
            titleId="usage-by-user-heading"
            blurb={
                <>
                    Sessions and tokens per user, resolved by joining each session to the board task it ran under. The
                    four token figures stay apart; {TOTAL_INPUT_LABEL} ({TOTAL_INPUT_CAPTION}) is the only sum. The bar
                    compares each user with the largest value of the selected metric shown.
                </>
            }
            meta={meta}
        >
            <label className="by-user-metric">
                Rank by{' '}
                <select value={metric} onChange={(e) => setMetric(e.target.value as UserMetric)}>
                    {METRIC_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                            {metricLabel(option)}
                        </option>
                    ))}
                </select>
            </label>
            <DataTable
                labelledBy="usage-by-user-heading"
                columns={columnsFor(metric, expanded, toggle)}
                rows={rows}
                rowKey={(row) => row.id}
                initialSort={{ key: 'selected', direction: 'descending' }}
                empty={<p className="muted">No attributed sessions in the coverage window yet.</p>}
            />
            {open.map((row) => (
                <section key={row.id} className="by-user-models" aria-label={`Models for ${row.name}`}>
                    <h3>Models · {row.name}</h3>
                    {row.usage !== null ? <UsageBreakdown usage={row.usage} /> : null}
                </section>
            ))}
        </TelemetryFrame>
    );
}
