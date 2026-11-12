import type { DateRange, OrganizationMeta, TaskUsageStats, TelemetryStats } from '@factory-ai/core';
import { usePoll } from './usePoll.js';

export interface TelemetryMeta {
    /**
     * 'empty' arrives with a real TelemetryStats so the panels can render their own
     * structure — that is how you see a pipeline that is wired but silent. The union keeps
     * 'unreachable' and 'disabled' for completeness of the API's vocabulary, but those two
     * answer 503 before a body is ever sent, so a 200 always carries a non-null `telemetry`.
     */
    status: 'ok' | 'empty' | 'unreachable' | 'disabled';
    reason: string | null;
    source: 'postgres' | 'fixture';
    fetchedAt: string | null;
    ageSeconds: number | null;
    stale: boolean;
    repoFilter: string[];
    otherRepoSessions: number;
    sessionsWithoutHook: number;
}

export interface StatsPayload {
    telemetry: TelemetryStats | null;
    /** What a task costs over the same range and scope. Null exactly when telemetry is. */
    tasks: TaskUsageStats | null;
    meta: {
        fetchedAt: string;
        ageSeconds: number;
        stale: boolean;
        /**
         * Imported from core rather than restated here, unlike TelemetryMeta above:
         * `current.id` round-trips back to the server as `?org=` and on to a database partition,
         * and a hand-copied key that drifts is a partition mismatch, not a cosmetic difference.
         */
        organization: OrganizationMeta;
        /** Every repo the figures combine. Length 1 is the common case, not a special case. */
        repos: { owner: string; name: string }[];
        /** The range the server actually aggregated over, presets already resolved. */
        range: DateRange;
        /** The scope the figures were computed under, and the member `mine` resolved to. */
        scope: 'org' | 'mine';
        scopeLogin: string | null;
        telemetry: TelemetryMeta;
    };
}

export interface FetchState {
    state: 'idle' | 'loading' | 'error';
    startedAt: string | null;
    finishedAt: string | null;
    error: { message: string; code: string } | null;
}

export interface UseStats {
    data: StatsPayload | null;
    /** True only before anything has ever rendered. */
    loading: boolean;
    progress: FetchState | null;
    error: string | null;
}

export const POLL_MS = 2000;
export const VISIBLE_REFRESH_MS = 30_000;
export const HIDDEN_REFRESH_MS = 60_000;
/** The board's "still fetching from GitHub" status — distinct from a completed 200. */
const HTTP_STATUS_ACCEPTED = 202;

/** What one request answered, as far as the next one is concerned. */
export type StatsPollOutcome = 'progress' | 'stale' | 'fresh' | 'error';

/**
 * When to ask again, or null to stop. A 200 used to end the chain, so a dashboard opened before
 * a run's telemetry landed kept showing the empty snapshot until somebody changed the range.
 * While the dashboard is open (`live`) the chain never ends: a stale snapshot is being refreshed
 * server-side, so it is asked for again at the progress pace; a fresh one or a failed read waits
 * the quiet pace, slower in a hidden tab. Off the dashboard only a cold read keeps polling — the
 * other pages read `meta`, not the figures, and a refresh nobody looks at is wasted.
 */
export function nextStatsPollDelay(outcome: StatsPollOutcome, live: boolean, hidden: boolean): number | null {
    if (outcome === 'progress') return POLL_MS;
    if (!live) return null;
    if (outcome === 'stale' && !hidden) return POLL_MS;
    return hidden ? HIDDEN_REFRESH_MS : VISIBLE_REFRESH_MS;
}

/** What `/api/stats` answers: the figures (200) or, while GitHub is still being read, the progress (202). */
type StatsBody = StatsPayload | { fetch: FetchState };

const isStatsBody = (body: unknown, status: number): body is StatsBody => {
    const candidate = body as Partial<StatsPayload> & { fetch?: unknown };
    return status === HTTP_STATUS_ACCEPTED
        ? candidate?.fetch !== undefined
        : candidate?.telemetry?.totals !== undefined && candidate.meta !== undefined;
};

function settledOutcome(body: StatsBody): StatsPollOutcome {
    return (body as StatsPayload).meta.stale ? 'stale' : 'fresh';
}

/**
 * `query` is the range query string; changing it re-polls without clearing what is on screen.
 * `live` is whether the dashboard is open: turning it on fetches immediately — opening the
 * dashboard always shows current figures — and keeps the chain running while it stays on.
 */
export function useStats(query: string, live: boolean): UseStats {
    const polled = usePoll<StatsBody>(`/api/stats?${query}`, {
        // The 202 is the board's "still fetching from GitHub": its body is the progress, not figures.
        isPartial: (status) => status === HTTP_STATUS_ACCEPTED,
        // Deliberately keeps `data` on an outage: whatever is on screen is the most accurate view available.
        guard: isStatsBody,
        malformed: 'Malformed /api/stats response',
        next: (outcome, hidden) =>
            nextStatsPollDelay(
                outcome.kind === 'partial'
                    ? 'progress'
                    : outcome.kind === 'error'
                      ? 'error'
                      : settledOutcome(outcome.value),
                live,
                hidden
            ),
        refetchOnVisible: live,
        keepOnUrlChange: true,
        restartKey: live,
    });
    return {
        data: polled.data as StatsPayload | null,
        loading: polled.loading && polled.data === null,
        progress: (polled.partial as { fetch: FetchState } | null)?.fetch ?? null,
        error: polled.error,
    };
}
