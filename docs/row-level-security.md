# Row-level security

How the organization reaches PostgreSQL once policies bind the org-owned tables: decided and measured, not yet enforced,
so each store's own `org_id` predicate is still the only guard.

| Concern | Code | Test |
| --- | --- | --- |
| Tables a policy will cover: every registered `org_id` table | `server/src/db/org-tables.ts` | `server/test-db/org-tables.test.ts` |
| The board's pools, one statement timeout each; the cross-org pool joins them | `server/src/db/pool.ts`, `server/src/main.ts` | `server/test-db/statement-timeout.test.ts` |
| Views that must run as the requester, dropped and recreated every boot | `server/migrations/002_views.repeatable.sql` | `server/test-db/telemetry.sql.test.ts` |
| Connection budget split across replicas and pools | `charts/factory/values.yaml` (`dbConnections`), `charts/factory/templates/validate.yaml` | `scripts/test-k8s.sh` |

## Decision

- **A transaction-local setting per store call:** `sql.begin` + `set_config('app.org_id', <org>, true)`, policy `org_id = current_setting('app.org_id', true)`. The setting dies with the transaction, so a pooled connection never carries one org into the next borrower, and the connection count stays the pool's whatever the number of orgs.
- **Rejected:** one pool per org through a startup parameter (connections grow with orgs x replicas x pools and never close, against a fixed `dbConnections`); `reserve()` with a session setting (a missed reset hands the next borrower the previous org, a wrong-org read rather than an empty one, and it costs more than the transaction).
- **Cross-org paths run on a second pool as a `bypassrls` role**, keeping their explicit `org_id` predicates; migrations stay on the owner. A cross-org fact inside a single-org snapshot is a narrow `security definer` function owned by the cross-org role, answering only for the ids it is given.

## Measured

Measured 2026-11-14 on one macOS laptop (4-core Intel, 16 GB), PostgreSQL 17.11 in Docker, postgres.js 3.4.9, the real
`readUsageFacts` plus run rows (`fetchRollups`) over 8 orgs x 400 sessions, 51,200 `metric_point` rows, 3,200 jobs; two
replicas = two pools (`DB_POOL_MAX` 50) driven at once; "small" is `health()`'s one statement. One host's sample, not a
bound. Milliseconds p50/p99, connections loaded/serial:

| Run | Stats, 2 in flight per replica | Small, 16 in flight per replica | Small, serial | Connections, 8 orgs |
| --- | --- | --- | --- | --- |
| Today, no RLS | 459 / 629 | 7.9 / 55 | 1.8 / 3.2 | 32 / 2 |
| (a) transaction setting, RLS | 443 / 503 | 17.0 / 68 | 4.9 / 8.2 | 32 / 2 |
| (b) pool per org, RLS | 439 / 483 | 7.5 / 61 | 1.8 / 3.4 | 83 / 16 |
| (c) `reserve()`, RLS | 443 / 524 | 14.2 / 58 | 3.7 / 7.7 | 46 / 2 |
| Views `security_invoker`, no policies | 442 / 521 | 7.2 / 44 | 1.9 / 3.8 | 32 / 2 |

The stats read is unchanged by mechanism, policies and `security_invoker`: it is one transaction already and its cost is
the query. As a non-owner role with policies forced, a view owned by a bypassing role returned 12,800 rows of 8 orgs with
no setting; with `security_invoker = true` it returned 0, and 1,600 rows of one org with the setting.

## Cross-org paths (the `bypassrls` role)

A missing setting reads 0 rows, so each path that reads other orgs, or reads "none" as a fact, runs cross-org:

- Owner: migrations, the `AUTH_MODE=none` seed, the boot reaps `server/src/db/migrate.ts:84`, `:117`, `:128`, `:269`.
- Credential to org: `server/src/db/jobs/job-store-org-resolvers.ts:42`, `:74`, `:104`, `:120`; `server/src/db/attempt-of-lease.ts:64`, `:125`; `server/src/auth/driver-credentials.ts:141` (lookup), `:221` (bootstrap); `server/src/attachments/upload-capability-store.ts:120`.
- Sign-in and sessions: `server/src/auth/store.ts:337`, `:429`, `:461`, `:490`, `:606`, `:659`, `:838`; `server/src/auth/membership-guard.ts:110`; `server/src/auth/oauth-store.ts:319`, `:383`, `:644`.
- Deletes decided by absence: `server/src/attachments/attachment-collector.ts:74`, `:90`; `server/src/skills/skill-collector.ts:27`; `server/src/db/org-purge.ts:322`; `server/src/integrations/integration-recovery.ts:150`; `server/src/telemetry/org-backfill.ts:57`.
- Definer function, a cross-org fact in a single-org path: global admission `server/src/db/jobs/job-store-admission.ts:79` (0 = cap unenforced) and occupancy `:251`; ingest's bound-elsewhere `server/src/telemetry/store.ts:85` (0 = another org's session accepted); the stats read's foreign sessions `server/src/telemetry/usage-facts.ts:188` (0 = counted twice).

Single-org, the setting is enough: the stores `server/src/orgs.ts:388` builds, so the per-board claim and lease retirement
`server/src/db/jobs/job-store-claim.ts:610`, the outbox loops `server/src/commerce/commerce-loop.ts:59` and
`server/src/notifications/delivery-loop.ts:88`, the batch loops, ingest's write, export and the plan writer. `organization`,
`app_user`, the secret tables and `driver_credential` hold no `org_id` and get no policy.

## Invariants

- **Every view is `security_invoker` and the request role's grants are issued in the repeatable file**: each boot drops and recreates the views, so an `alter view` or a grant made elsewhere is lost.
- **The cross-org pool comes out of `dbConnections`**, which the chart divides today by two pools per replica.
- **A path is cross-org only with a line above**; a sweep that reads absence never runs on the request role.
