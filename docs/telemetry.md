# Telemetry

OTLP ingest from the two executors, the SQL views over it, and the states the read degrades into.

| Concern | Code | Test |
| --- | --- | --- |
| OTLP parse, attribute allowlist, metric denylist, `attrs.series` raw-series digest | `server/src/telemetry/otlp.ts`, `server/src/telemetry/metric-map.ts` | `server/test/telemetry.otlp.test.ts` |
| Ingest routes and the branch report | `server/src/routes/ingest.ts` | `server/test/routes.ingest.test.ts` |
| Writes and dedupe | `server/src/telemetry/store.ts`, `server/migrations/086_metric_point_identity.sql` | `server/test-db/telemetry.sql.test.ts`, `server/test-db/telemetry.ingest-identity.test.ts`, `server/test-db/migration.086-metric-point-identity.test.ts` |
| Read client, `ok`/`empty`/`stale`/`disabled` | `server/src/telemetry/{postgres-client,client,errors}.ts` | `server/test/routes.telemetry.test.ts` |
| Usage reader: one repeatable-read snapshot of board evidence (`job_execution` x `job_execution_session`), branch evidence, points, spans, field totals and users, bound to the tenant before they reach memory; rollups rebuilt from it; the test-only global reconciliation | `server/src/telemetry/usage-facts.ts`, `core/src/usage-rollups.ts`, `server/src/telemetry/usage-reconciliation.ts` | `server/test-db/token-reconciliation.test.ts`, `server/test-db/telemetry.sql.test.ts` |
| Views: `metric_point_used`, `metric_point_suppressed`, `session_source`, `session_branch_slice`, `session_field_total` (series reduction, the SQL twin of `reduceTokenObservations`) | `server/migrations/002_views.repeatable.sql` | `server/test-db/telemetry.sql.test.ts`, `server/test-db/telemetry.token-reduction.test.ts` |
| Transcript discovery, parent quarantine, message dedupe, zero-preserving usage events | `server/src/backfill/transcript-discovery.ts`, `server/src/backfill/transcript-usage.ts` | `server/test/backfill.transcripts.test.ts` |
| Executor OTEL endpoint rendering | `driver/src/telemetry-config.ts` | `driver/test/telemetry-shipping.test.ts` |
| Run activity (`GET /api/jobs/:id/activity`): one repeatable-read `readUsageFacts(tx, org, {taskIds, edits})` per request (`fetchTaskFacts`), the run's amounts from core `runContributionsOf` placed in buckets over its segment span so buckets sum to `usage`; edit decisions are read only here; the batch report reads the member roots in its own snapshot | `server/src/telemetry/run-activity.ts`, `server/src/telemetry/client.ts`, `server/src/telemetry/usage-facts.ts`, `core/src/usage-reduce.ts` | `server/test/run-activity.test.ts`, `server/test-db/token-reconciliation.test.ts` |
| Executor emission, collector config, branch reporter | `docker/{claude,opencode}-executor/`, `docker/otel-collector.yaml`, `charts/factory/files/collector.yaml` | `docker/claude-executor/test.sh`, `driver/test/branch-reporter.test.ts` |

Aggregation: [metrics.md](metrics.md). Schema and migration rules: [persistence.md](persistence.md).
| Prometheus series, board and driver (`GET /api/metrics`, driver `GET /metrics`); hand-rolled exposition, copied to the driver | `server/src/metrics.ts`, `server/src/prometheus.ts`, `driver/src/driver-metrics.ts`, `driver/src/prometheus.ts` | `server/test/routes.prometheus.test.ts`, `server/test/prometheus.test.ts`, `server/test-db/job-store.claim-metrics.test.ts`, `driver/test/driver-metrics.test.ts` |

## Invariants

- **A cumulative counter is reduced to its high-water mark per raw series, never `sum(value)`** — in
  `002_views.repeatable.sql` and again in `core/src/token-contributions.ts`; series are summed, and
  unspecified temporality is never added. Guarded by `server/test-db/telemetry.sql.test.ts` and
  `server/test-db/telemetry.token-reduction.test.ts`, which holds both to the same totals.
- **Every view reads `metric_point_used`, never `metric_point`** — `session_source` picks one source
  per session, OTEL over transcript; reading the table reintroduces the double count.
- **Nanosecond timestamps divide by `1e6`, not `1e9`** (`server/src/telemetry/otlp.ts`).
- **Attribute keys are allowlisted; metric names are denylisted.** A new identity attribute is
  dropped by default; an unknown metric still lands in `metric_point` unmapped. `attrs.series` is the
  one-way sha256 digest of the full pre-allowlist attributes; the dropped values are never stored.
- **A session key is `(agent, session id)` and has one owner, resolved before any join** (`core/src/usage-ownership.ts`):
  the tenant's board evidence (an execution's author, repo and canonical task) or its branch reports. No
  evidence, or evidence from a second organization, keeps the key out of every tenant read; two tasks or two
  repos make it unresolved, never a `min()`. `server/test-db/token-reconciliation.test.ts`.
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