import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    reduceUsage,
    rollupsFromFacts,
    seriesGranularity,
    telemetryStats,
    usageRangeOf,
    type DateRange,
    type TelemetryInput,
    type TelemetryStats,
    type UsageInput,
    type UsageReport,
    type UserRef,
} from '@factory-ai/core';

/**
 * The committed synthetic usage facts, reduced the way the server does at read time: session
 * figures over the per-session rollups, token figures over the facts under the same range, repos
 * and user. The panels' suites render this payload, so a shape drift shows here first.
 */
interface FixtureFile extends Omit<UsageInput, 'foreignSessionIds'> {
    foreignSessionIds: string[];
    users: UserRef[];
    fields: { agent: string; sessionId: string; field: string; value: number }[];
}

// A path, not a URL object: under jsdom the global URL is jsdom's, which node:fs refuses.
const raw = JSON.parse(
    readFileSync(fileURLToPath(`${import.meta.url}/../../../core/test/fixtures/telemetry-usage.json`), 'utf8')
) as FixtureFile;
const facts = { ...raw, foreignSessionIds: new Set(raw.foreignSessionIds) };

/** The fixture's per-session rollups (sessions, lines, edits, active time). */
export const fixtureRollups: TelemetryInput = rollupsFromFacts(facts);

/** A usage report over no facts: for stats built from hand-made sessions that carry no tokens. */
export const emptyUsage = (now: Date): UsageReport =>
    reduceUsage(
        { orgId: 'empty', board: [], branch: [], foreignSessionIds: new Set(), contributions: [], spans: [] },
        { range: null, now }
    );

export function fixtureStats(options: {
    repos?: string[];
    now: Date;
    range?: DateRange;
    user?: { id: string };
}): TelemetryStats {
    const { repos, now, range, user } = options;
    const usage = reduceUsage(facts, {
        range: range ? usageRangeOf(range) : null,
        now,
        granularity: seriesGranularity(range, fixtureRollups, now),
        ...(repos ? { repos } : {}),
        ...(user ? { userId: user.id } : {}),
    });
    return telemetryStats(fixtureRollups, { ...options, usage });
}
