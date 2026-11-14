# Commerce

Optional link to an external commerce service, off by default: the service pushes each org's plan with its limits, the board enforces them and reports every closed execution claim; the board holds no price.

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| `COMMERCE_ENABLED`, `COMMERCE_URL`, `COMMERCE_TOKEN` ([configuration.md](configuration.md)) | `server/src/config-commerce.ts` | `server/test/config.commerce.test.ts` |
| `org_plan` and the usage outbox `commerce_usage_report` | `server/migrations/095_commerce.sql` | `server/test-db/commerce-store.test.ts` |
| Outbox: enqueue closed claims, token-checked lease and settle, member read | `server/src/db/commerce-store.ts` | `server/test-db/commerce-store.test.ts` |
| Plan push write: one guarded upsert, org existence decided by the write | `server/src/db/commerce-plan-writer.ts` | `server/test-db/commerce-plan-writer.test.ts` |
| Plan limits (`max_running`, `max_queued`, `max_wall_seconds`), each null or missing one from `PLAN_DEFAULT_MAX_*` (the Free plan); enforced by admission, create and heartbeat ([jobs.md](jobs.md)) | `server/src/db/plan-limits.ts`, `server/migrations/139_plan_limits.sql`, `server/src/config.ts` | `server/test-db/job-store.plan-limits.test.ts`, `server/test/config.plan-defaults.test.ts` |
| Allowances (`max_tokens` per period, `max_storage_bytes`): a task or batch create past the tokens is refused, an attachment upload past the storage too, a log chunk recorded `org_quota`; the `org_token_usage` rollup the ingest keeps | `server/src/db/plan-allowances.ts`, `server/migrations/149_plan_allowances.sql`, `server/src/telemetry/store.ts`, `server/src/routes/plan-limit.ts` | `server/test-db/plan-allowances.test.ts`, `server/test/routes.jobs-plan-limits.test.ts` |
| Outbound `POST {COMMERCE_URL}/v1/orgs/{orgId}/usage` | `server/src/commerce/commerce-client.ts` | `server/test/commerce-client.test.ts` |
| Delivery loop, every replica, `commerce_usage` pass | `server/src/commerce/commerce-loop.ts`, `server/src/interval-loop.ts`, `server/src/main.ts` | `server/test/commerce-loop.test.ts`, `server/test/interval-loop.test.ts` |
| `GET /api/commerce`, `PUT /api/commerce/orgs/:orgId/plan` | `server/src/routes/commerce.ts`, `server/src/app.ts` | `server/test/routes.commerce.test.ts` |
| The `commerce` credential class | `server/src/auth/plugin.ts` | `server/test/auth.enforcement.test.ts` |

The wire shapes are `server/src/commerce/commerce-client.ts` (outbound) and `server/src/routes/commerce.ts` (inbound); both carry the one bearer `COMMERCE_TOKEN`.

## Invariants

- **Reported usage is a raw fact.** Every closed `origin = 'claim'` claim is reported with its `launch`; `backfill` and open claims never are. Minutes are read from `job_execution` at lease time, never copied.
- **Only echoed keys are acknowledged.** Any other outcome (status, timeout, malformed or partial answer) leaves the rows to retry with backoff; the token never appears in a result or log.
- **A settle applies only while its lease token stands**, so a replica whose lease lapsed changes nothing.
- **The outbox schedules on the store's clock**: `next_attempt_at` and `claimed_until` are written and compared with the injected `now`, never the database's. `server/src/db/commerce-store.ts`, `server/test-db/commerce-store.test.ts`.
- **The push answers 200 only after commit**; a retry of a lost 200 is `replayed`. A database failure is 503, never an empty plan or a 200.
- **The push credential is its own class**, enforced in both `AUTH_MODE`s, with no session, personal or worker fallback.
- **One token in both directions**: a leak lets the holder write any org's plan; rotation is a redeploy of both sides.
- **No cloud organization is unlimited**: cloud refuses to boot without every `PLAN_DEFAULT_MAX_*`, and the chart to render without them or the admission caps. An unreachable service changes nothing (the last push stands); a failed plan read fails that org's claim or create, never admits. `scripts/test-k8s.sh`.

- **An allowance is read, never guessed**: a failed usage or bytes read fails the create or upload (5xx), never admits it and never refuses it as over. Tokens are a primary-key range over `org_token_usage`, never an aggregate over `metric_point`; storage uploads take turns on a per-org lock, so concurrent uploads never pass the allowance. Running tasks are never stopped for tokens. `server/src/db/plan-allowances.ts`, `server/test-db/plan-allowances.test.ts`.

## Stated limits

- No UI, no pull: a lost or refused push is the service's to retry.
- Token usage counts the delta token points (all four types) an org's runs report, by the day the board received them: no cumulative point (no runner exports one), no point stored before `149_plan_allowances.sql`. Tasks running or queued when the allowance is reached may spend past it; a period starting mid-day counts that whole day.
- A log chunk is not serialized with other chunks, so the chunks in flight at once (each within the stream cap) may pass the storage allowance; follow-ups and retries are not refused for tokens. `server/src/artifacts/artifact-store.ts`, `server/src/db/jobs/job-store-thread-actions.ts`.
- A claim's `launch` moving `unknown` to `observed` after it was reported is not re-reported.
