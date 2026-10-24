# Telemetry

OTLP ingest from the two executors, the SQL views over it, and the states the read degrades into.

| Concern | Code | Test |
| --- | --- | --- |
| OTLP parse, attribute allowlist, metric denylist | `server/src/telemetry/otlp.ts`, `server/src/telemetry/metric-map.ts` | `server/test/telemetry.otlp.test.ts` |
| Ingest routes and the branch report | `server/src/routes/ingest.ts` | `server/test/routes.ingest.test.ts` |
| Writes and dedupe | `server/src/telemetry/store.ts` | `server/test-db/telemetry.sql.test.ts` |
| Read client, `ok`/`empty`/`stale`/`disabled` | `server/src/telemetry/{postgres-client,client,errors}.ts` | `server/test/routes.telemetry.test.ts` |
| Views: `metric_point_used`, `session_source`, `session_branch_slice` | `server/migrations/002_views.repeatable.sql` | `server/test-db/telemetry.sql.test.ts` |
| Transcript discovery, parent quarantine, message dedupe, zero-preserving usage events | `server/src/backfill/transcript-discovery.ts`, `server/src/backfill/transcript-usage.ts` | `server/test/backfill.transcripts.test.ts` |
| Executor OTEL endpoint rendering | `driver/src/telemetry-config.ts` | `driver/test/telemetry-shipping.test.ts` |
| Run-activity bucketing and per-type token totals (`GET /api/jobs/:id/activity`); reduced by `reduceTokenObservations` (`core/src/token-contributions.ts`): running maximum per start-time series, pre-window readings are the baseline, unspecified temporality is never added, a series' first reading without a start time is unlocated | `server/src/telemetry/run-activity.ts` | `server/test/run-activity.test.ts`, `server/test-db/telemetry.sql.test.ts` |
| Executor emission, collector config, branch reporter | `docker/{claude,opencode}-executor/`, `docker/otel-collector.yaml`, `charts/factory/files/collector.yaml` | `docker/claude-executor/test.sh`, `driver/test/branch-reporter.test.ts` |

Aggregation: [metrics.md](metrics.md). Schema and migration rules: [persistence.md](persistence.md).
| Prometheus series, board and driver (`GET /api/metrics`, driver `GET /metrics`); hand-rolled exposition, copied to the driver | `server/src/metrics.ts`, `server/src/prometheus.ts`, `driver/src/driver-metrics.ts`, `driver/src/prometheus.ts` | `server/test/routes.prometheus.test.ts`, `server/test/prometheus.test.ts`, `server/test-db/job-store.claim-metrics.test.ts`, `driver/test/driver-metrics.test.ts` |

## Invariants

- **A cumulative counter is reduced with `max(value)` per `start_time`, never `sum(value)`** — in
  `002_views.repeatable.sql` and again in `server/src/telemetry/run-activity.ts`. Guarded by
  `server/test-db/telemetry.sql.test.ts`, whose fixture sums to 2.5× its real total.
- **Every view reads `metric_point_used`, never `metric_point`** — `session_source` picks one source
  per session, OTEL over transcript; reading the table reintroduces the double count.
- **Nanosecond timestamps divide by `1e6`, not `1e9`** (`server/src/telemetry/otlp.ts`).
- **Attribute keys are allowlisted; metric names are denylisted.** A new identity attribute is
  dropped by default; an unknown metric still lands in `metric_point` unmapped.
- **Per-user attribution is a read-side join** of `session_branch` to `job` on
  `(org_id, session_id)`; no user column exists on `metric_point` or `session_branch`.
- **No monetary field exists** — `claude_code.cost.usage` and `opencode.cost.usage` are refused at
  the collector and again at the ingest route.
- **`on conflict do nothing` on `metric_point`, never `do update`** — an update would move
  `received_at`, the only way to tell a retry from a second export.
- **The ingest route returns 5xx only for a genuine write failure** (exporters retry 5xx forever):
  an unparseable body gets 200, a malformed branch report 400.
- **A branch report's organization comes from the attempt's job id + lease token headers, never
  from the report's `repo` field** (CWE-862). A refused report is a silent no-op.
- **Both executors read `RUNNER_OTEL_ENDPOINT` from a managed-scope file the driver renders
  root-owned** (`driver/src/telemetry-config.ts`): Claude's managed settings `env` block outranks
  the container environment and any user- or repo-scope settings; opencode's file is named by
  `OPENCODE_OTEL_CONFIG_PATH`.
- **The collector exporter sets `compression: none`** — Fastify's JSON parser does not decompress,
  so gzip means a 400 on every export.
- **Transcripts carry only token usage** — no edit decisions, no active time, and `input_tokens`
  excludes cache reads (`server/src/backfill/transcripts.ts`).
- **No org, repo, job, lease, pod or user id in any metric label value**: labels come from closed vocabularies
  (route pattern, status class, verb, resource kind, docker command, outcome). A failed scrape-time read omits
  its samples, never reports zero (`server/test/routes.prometheus.test.ts`).