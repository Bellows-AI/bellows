# Aggregation invariants

Aggregation of telemetry into the dashboard's figures. Metric definitions: `../factory-stats/SPEC.md`; range
and granularity: [date-range.md](date-range.md).

| Concern | Code | Test |
| --- | --- | --- |
| Rollups, scope filter, series, `telemetryStats()` | `core/src/telemetry.ts` | `core/test/telemetry.stats.test.ts`, `core/test/telemetry.independent.test.ts` |
| `ratio`, `weekStart`, `isoWeekKey`, `dayKey` | `core/src/metrics.ts` | `core/test/metrics.invariants.test.ts` |
| Token observations reduced to contributions (delta / cumulative high-water, source selection, `[1m]` model normalization, range and UTC day/week partition) | `core/src/token-contributions.ts` | `core/test/token-contributions.test.ts` |
| Per-task distributions and percentiles | `core/src/task-usage.ts` | `core/test/task-usage.test.ts` |
| Read cache, cooldown, stale snapshots | `server/src/stats-service.ts`, `server/src/cache.ts` | `server/test/routes.stats.get.test.ts` |
| TTL parsing and its floor | `server/src/config.ts` | `server/test/config.persistence.test.ts` |

## Turn terminology

The definition of record: **a payload field, UI label, or doc sentence that says a bare "turns" is
a bug in wording**.

| term | meaning | counted from |
| --- | --- | --- |
| **job turn** (product word: **run**) | one job row in a task thread — the first run or a follow-up | the board's own rows |
| **agent turn** | one assistant response cycle in the run's ROOT conversation; subagent conversations never count | the session's own records, read at run close (docs/jobs.md) |

The two are never summed, compared, or averaged into one another. An unmeasured count is stored
null — never zero. Pinned by `core/test/docs.terminology.test.ts`.

## Invariants

- **`ratio()` returns `null`, never `0`, on a zero denominator** (`core/test/metrics.invariants.test.ts`),
  **and `sum()` in `core/src/telemetry.ts` returns `null` only when nothing was measured.**
- **The four token types are never summed into one figure.** The one sanctioned input-side sum is
  `inputTokens()` = `input` + `cacheRead` + `cacheCreation`; hit rate is `cacheRead` over that.
- **Every bucket in the window is seeded, including empty ones** — `bucketSeries()`; a series that
  closes its own gaps overstates activity. Week and day bucketing stay in `core/src/metrics.ts`,
  never `time_bucket()`.
- **Scope (`org` / `mine`) is a read-time filter over the cached input, exactly like the range**,
  so a scope switch never re-fetches — `server/test/routes.stats.scope.test.ts`.
- **Repo scoping buckets, it never drops.** `otherRepoSessions`, `sessionsWithoutHook` and
  `unattributedSessions` keep four states distinguishable, and none of them feeds `totals`.
- **Per-task distributions exclude, they never zero**, and percentiles are nearest-rank so the
  independent suites can recompute them by hand — `core/src/task-usage.ts`.
- **`telemetryStats()` takes an injectable `now`** — tests pin a frozen date; keep the injection point.
- **No field named `cost`/`usd`/`price` exists in `TelemetryStats` or the task statistics**, and
  `core/test/telemetry.stats.test.ts` and `core/test/task-usage.test.ts` assert their absence.
- **`TELEMETRY_TTL_SECONDS` (default 30, floor 5) is the only cache floor** (`server/src/config.ts`). A
  failed read serves the last good snapshot with 200 and cools down 30s, with no bypass
  (`server/src/stats-service.ts`).
