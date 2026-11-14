# Row-level security

How the organization reaches PostgreSQL: every org-owned table carries the policy `org_id = current_setting('app.org_id', true)`, so a statement without the setting reads no org row and writes none.

| Concern | Code | Test |
| --- | --- | --- |
| Roles, grants, `enable` (not `force`) and the policy on every `org_id` table and partition; the owner stays exempt | `server/migrations/151_row_level_security.sql`, `server/src/db/org-tables.ts` | `server/test-db/org-tables.test.ts`, `server/test-db/row-level-security.test.ts` |
| The legacy point repair trigger runs as `bellows_cross_org`, so evidence the request role writes still repairs org-less points | `server/migrations/151_row_level_security.sql` | `server/test-db/metric-point-repair.rls.test.ts` |
| A store's statement runs in a transaction that sets its org first (`orgSql`); the org stores get it | `server/src/db/org-sql.ts`, `server/src/orgs.ts` | `server/test-db/org-sql.test.ts` |
| Views run as their invoker, recreated with their grants each boot | `server/migrations/002_views.repeatable.sql` | `server/test-db/row-level-security.test.ts`, `server/test-db/org-tables.test.ts` |
| The cross-org facts of single-org paths: `security definer` functions owned by `bellows_cross_org` | `server/migrations/151_row_level_security.sql`, `server/src/db/jobs/job-store-admission.ts`, `server/src/telemetry/store.ts`, `server/src/telemetry/usage-facts.ts` | `server/test-db/cross-org-functions.test.ts` |
| The pools: owner (migrations), request, secrets, cross-org; `DATABASE_REQUEST_URL` | `server/src/main.ts`, `server/src/db/pool.ts`, `server/src/config.ts` | `server/test/cross-org-pool.test.ts`, `server/test-db/org-sql.test.ts` |
| Connection budget split across replicas and pools; the optional request login | `charts/factory/values.yaml`, `charts/factory/templates/validate.yaml`, `charts/factory/templates/secret.yaml` | `scripts/test-k8s.sh` |

## Roles

- **`bellows_request`** owns nothing and does not bypass RLS: the request and secrets pools take it at connection start, on `DATABASE_REQUEST_URL` (a login that is its member) or else the owner's login.
- **`bellows_cross_org`** has `BYPASSRLS` and owns the definer functions: the cross-org pool is the owner's login taking it. The migration creates both and grants them to the migrating login. A login that may not create a `BYPASSRLS` role needs both created and granted to it first; the migration then only checks them.
- **The owner** is exempt from the policies (enabled, not forced), so a pod of the previous release, which runs as the owner with no setting, keeps reading through a rollout. This release runs only its migrations on it, a one-connection pool closed after boot; its seed and boot reaps already take `bellows_cross_org` (`server/src/db/migrate.ts`).

## Cross-org paths

Each call `main.ts` hands the cross-org pool, pinned by `server/test/cross-org-pool.test.ts`:

- Sign-in and credentials: `createAuthStore`, `membershipGuardFor`, `mcpStores` (OAuth store, upload capabilities, their expiry sweeps), `bootstrappedDriverCredentials`, and `server/src/auth/driver-credential-cli.ts`.
- A worker credential to its org: `createOrgOfLease`, `createOrgOfIngest`, `createOrgOfJob`, `createOrgOfReclaim`, and through `runnerCredentialDeps` the lease checks `createAttemptOfLease` and `createPairMatches`.
- Deletes decided by what no org references: `startCollectors` with `startAttachmentSweep`, `startSkillSweep` and `startOrgPurge`; the integration recovery (`createIntegrationRuntime`); `startMetricPointOrgBackfill`.

Definer functions, inside the caller's transaction, answering a count, a slot or one boolean per id passed:

- `bellows_global_running` and `bellows_global_admission_slot`: the claim's global budget, under the claim's advisory keys.
- `bellows_admission_occupancy`: the metrics scrape's counts.
- `bellows_sessions_refused` (ingest), `bellows_sessions_foreign` (the stats read) and `bellows_session_owned_elsewhere` (a claim's or report's session evidence, `server/src/db/jobs/job-store-provenance.ts`): the org asked about is the caller's setting, never an argument, and no setting raises.

Everything else is single-org: the stores `orgs.ts` builds (the claim, lease retirement, outbox, batch and delivery loops, export), ingest's writes, the plan writer, operation receipts, agent titles and the runner connection list (`orgSql` per call).

## Measured

The spike (2026-11-14, one laptop, PostgreSQL 17.11, two pools of 50, 8 orgs x 400 sessions): the stats read p50/p99 459/629 ms without RLS against 443/503 ms with the transaction setting; a one-statement read 1.8/3.2 ms serial without against 4.9/8.2 ms with. One host's sample, not a bound.

## Invariants

- **`force row level security` is a contract step for a later release**, once no pod of a release before 151 can run: until then the owner must read every row. `server/test-db/row-level-security.test.ts` pins the exemption.
- **Nothing but the migrations runs as the owner**: `server/test/cross-org-pool.test.ts` pins where `main.ts` hands the owner pool, `server/test-db/org-sql.test.ts` the role each pool runs as.
- **A trigger that reads another org's rows, or org-less ones, is `security definer` as `bellows_cross_org`**: of the triggers before 151 only the metric point repair does; the fill trigger runs only for an org-less insert, which no request makes.

- **Every view is `security_invoker` and granted in the repeatable file**: each boot drops and recreates the views. `server/test-db/org-tables.test.ts` fails on a view without it.
- **A new `org_id` table gets the policy in its own migration**: 151 covered the tables that existed. `server/test-db/org-tables.test.ts` fails on a table without it.
- **A sweep that reads absence never runs on the request role**: under it a missing setting reads 0 rows. It joins the list above and `server/test/cross-org-pool.test.ts`.
- **A definer function returns no row of another org**: a count, a slot, or booleans aligned to the caller's ids.
- **The request login is never logged or forwarded**: `config.ts` reads it, `main.ts` opens the pools with it.
