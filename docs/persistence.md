# Persistence

PostgreSQL is the only store. A process without `DATABASE_URL` refuses to boot; there is no in-memory
mode and no degraded-persistence state on the payload. The offline suite stays database-free through
the in-memory stores in `server/test/helpers*.ts`.

| Concern | Code | Test |
| --- | --- | --- |
| `metric_point_dedup` identity: agent, metric, session (null-safe), time, source, temporality, start time, `md5(attrs)` | `server/migrations/086_metric_point_identity.sql` | `server/test-db/migration.086-metric-point-identity.test.ts` |
| Migration runner (advisory-locked, one transaction; repeatables skipped when the ledger is ahead), boot seeding, session reaping | `server/src/db/migrate.ts` | `core/test/migrations.sql.test.ts`, `server/test-db/migrate.concurrency.test.ts` |
| Schema (ingest and views: [telemetry.md](telemetry.md)) | `server/migrations/*.sql` | `server/test-db/telemetry.sql.test.ts`, `server/test-db/telemetry.token-reduction.test.ts`, the `job-store.*` suites |
| Read cache warm-up and degradation | `server/src/stats-service.ts` | `server/test/routes.stats.get.test.ts` |
| Job and thread reads and writes | `server/src/db/jobs/*` | `server/test-db/job-store.*.test.ts` |
| Agent questions, stamped with the asking claim's `claim_seq` (050, 074) | `server/migrations/050_job_question.sql`, `server/migrations/074_job_question_claim_seq.sql`, `server/src/db/jobs/job-store-questions.ts` | `server/test-db/job-store.questions.test.ts` |
| Named-profile reviews (056) | `server/migrations/056_job_review.sql`, `server/src/db/jobs/job-store-reviews.ts` | `server/test-db/job-store.reviews.test.ts` |
| Claim sequence, never refunded (057) | `server/migrations/057_job_claim_seq.sql`, `server/src/db/jobs/job-store-claim.ts` | `server/test-db/job-store.interrupt.test.ts` |
| Idempotency keys on the `job` row (058) | `server/migrations/058_job_idempotency.sql`, `server/src/db/jobs/job-store-idempotency.ts` | `server/test-db/job-store.idempotency.test.ts` |
| Batch plans and runtime (059, 060, 062–065; [batches.md](batches.md)) | `server/migrations/059_batches.sql`, `server/migrations/06[0-5]_*.sql`, `server/src/db/batches/batch-store*.ts` | `server/test-db/batch-store.test.ts`, `server/test-db/batch-dispatch.test.ts`, `server/test-db/batch-pr-observation.test.ts`, `server/test-db/batch-merge.test.ts` |
| Checkpoint pointer on the root `job` row, advanced in the `checkpoint` manifest's finalize transaction only under the uploading row's current `claim_seq` (079) | `server/migrations/079_checkpoint_pointer.sql`, `server/src/artifacts/artifact-store.ts` | `server/test-db/job-store.checkpoint-pointer.test.ts` |
| Secret store: reference, immutable AES-GCM versions, active pointer, operation records (091, 092; [secrets.md](secrets.md)) | `server/migrations/091_secret_store.sql`, `server/migrations/092_secret_external.sql`, `server/src/secrets/postgres-secret-repo.ts` | `server/test-db/secrets-postgres.conformance.test.ts` |
| Environment secret reference: `env_var.secret_ref`, `secret_version`, `value` nullable; additions only, no constraint, so a pod on the previous release keeps writing plaintext (093) | `server/migrations/093_env_var_secret_ref.sql` | `server/test-db/migration.093-env-secret-ref.test.ts` |
| Integration connections: `integration_grant`, append-only `job_connection_binding`, `job_integration_requirement`, principal/status columns on `connector_connection`, `job.execution_user_id`; additions only, with `*_rollout_094` triggers an old pod's inserts land through and an immutable execution user (094). Contract release drops `job.jira_connection_id`, both triggers and `connector_connection.kind` ([connections.md](connections.md)) | `server/migrations/094_integration_connections.sql` | `server/test-db/migration.094-integration-connections.test.ts` |
| Commerce: pushed `org_plan`, per-claim usage outbox `commerce_usage_report` (095; [commerce.md](commerce.md)) | `server/migrations/095_commerce.sql`, `server/src/db/commerce-store.ts`, `server/src/db/commerce-plan-writer.ts` | `server/test-db/commerce-store.test.ts`, `server/test-db/commerce-plan-writer.test.ts` |
| Operation receipts: `integration_operation_receipt`, one row per runner-side write keyed by (org, root, operation key), a closed status and result; additions only (099; [connections.md](connections.md)) | `server/migrations/099_operation_receipts.sql`, `server/src/db/operation-receipts.ts` | `server/test-db/migration.099-operation-receipts.test.ts`, `server/test-db/operation-receipts.test.ts` |
| Artifact index and manifests (070; [configuration.md](configuration.md)) | `server/migrations/070_artifact_index.sql`, `server/src/artifacts/artifact-store.ts` | `server/test-db/artifact-store.test.ts` |
| Member uploads: `input_attachment` (111), state `pending`, `ready`, `bound`, `deleting`, `deleted` (a tombstone), each change a conditional UPDATE; objects under `<prefix>_attachments/<org>/<id>` | `server/migrations/111_input_attachment.sql`, `server/src/attachments/attachment-rows.ts`, `server/src/attachments/attachment-store.ts` | `server/test-db/attachment-store.test.ts`, `server/test/artifacts.object-store.test.ts` |
| A task's files: `bound_job_id`, `root_job_id`, `position` (112, no FK to `job`), bound in the job-insert transaction, read per thread through a join to the job row, flipped to `deleting` by `removeThread` | `server/migrations/112_attachment_binding.sql`, `server/src/db/jobs/job-store-attachments.ts` | `server/test-db/job-store.attachments.test.ts` |
| Settle receipts per attempt (072) | `server/migrations/072_job_settle_receipts.sql`, `server/src/db/jobs/job-store-receipts.ts` | `server/test-db/job-store.receipts.test.ts` |
| Reclaim ownership and ack receipts (075) | `server/migrations/075_task_reclaim_ownership.sql`, `server/src/db/jobs/job-store-reclaims.ts` | `server/test-db/job-store.stop-remove.test.ts`, `server/test-db/job-store.receipts.test.ts` |
| Staged conclusions, immutable per attempt (076) | `server/migrations/076_job_conclusions.sql`, `server/src/db/jobs/job-store-conclusions.ts` | `server/test-db/job-store.conclusions.test.ts` |
| Phase checkpoints, one row per run and phase (080, 083) | `server/migrations/080_job_phase_checkpoints.sql`, `server/migrations/083_phase_checkpoint_setup.sql`, `server/src/db/jobs/job-store-phase-checkpoints.ts` | `server/test-db/job-store.phase-checkpoints.test.ts` |
| Gate runs, one row per gate execution, `running` then terminal, latest row per gate read back (087) | `server/migrations/087_job_gate_run.sql`, `server/src/db/jobs/job-store-gate-runs.ts` | `server/test-db/job-store.gate-runs.test.ts` |
| PR operations, one row per managed publish operation, `created` or `reused`, keyed by a driver-minted operation id (088) | `server/migrations/088_job_pr_operation.sql`, `server/src/db/jobs/job-store-pr-operations.ts` | `server/test-db/job-store.pr-operations.test.ts` |
| Transcript tool events, one row per half (`call`, `result`) of a gate or PR tool call, keyed by (executor, session, call id, half), with `run_claim_seq`, `started_at`/`ended_at` and the artifact's `artifact_session`, classified fields only, no FK on `execution_id`/`operation_id` (089) | `server/migrations/089_transcript_tool_event.sql`, `server/src/db/jobs/job-store-transcript-tools.ts` | `server/test-db/transcript-tool-event.test.ts` |
| Admission slots on running `job` rows, unique per budget among running non-review rows (081) | `server/migrations/081_job_admission.sql`, `server/src/db/jobs/job-store-admission.ts` | `server/test-db/job-store.admission.test.ts` |
| PR follower cadence, one row per followed PR (082; [workflows.md](workflows.md)) | `server/migrations/082_pr_follow.sql`, `server/src/db/pr-follow-store.ts` | `server/test-db/pr-follow.test.ts` |
| `job.status` transition graph, refused in storage with 23514 `job_status_transition` (084) | `server/migrations/084_job_status_transitions.sql` | `server/test-db/job-store.transitions.test.ts` |
| Execution provenance outliving the job (085): `job_execution`, `job_execution_session`, no FK to `job` or `app_user`; `launch` moves forward only in storage, a claim given up without evidence is `unknown`, an adopter links `adopts_claim_seq`, removal stamps `removed_at` in its own transaction, pre-epic jobs are backfilled once as `origin='backfill'` / `unknown` with no start or end | `server/migrations/085_job_execution.sql`, `server/src/db/jobs/job-store-provenance.ts` | `server/test-db/migration.085-job-execution.test.ts`, `server/test-db/job-store.execution-provenance.test.ts`, `server/test-db/job-store.interrupt.test.ts` |
| Usage reader over that provenance and `metric_point`: inside the caller's `repeatable read, read only` transaction, never its own | `server/src/telemetry/usage-facts.ts` | `server/test-db/token-reconciliation.test.ts` |
| Notification events: `notification_event`, one row per (job, kind), written by a deferred trigger on `job.status` in the settle's transaction (102; [notifications.md](notifications.md)) | `server/migrations/102_notification_event.sql` | `server/test-db/notification-events.test.ts` |
| Notification subscriptions: `notification_subscription`, org-owned, the outbox's fan-out targets (103; [notifications.md](notifications.md)) | `server/migrations/103_notification_subscription.sql` | `server/test-db/notification-subscriptions.test.ts` |
| Notification outbox: `notification_outbox`, one row per (event, subscription), fanned out by the 102 trigger function (104; [notifications.md](notifications.md)) | `server/migrations/104_notification_outbox.sql` | `server/test-db/notification-outbox.test.ts` |
| Notification event: `task.ready` narrowed to the thread head, `pr_url` snapshot (105; [notifications.md](notifications.md)) | `server/migrations/105_notification_task_ready.sql` | `server/test-db/notification-events.test.ts` |
| Notification event: `task.blocked` only when a person must act, batch attention trigger, shared fan-out function (106; [notifications.md](notifications.md)) | `server/migrations/106_notification_task_blocked.sql` | `server/test-db/notification-events.test.ts`, `server/test-db/notification-blocked.test.ts` |
| Notification event: `task.question` per question, `question_id` and `questions` snapshot, insert trigger on `job_question` (107; [notifications.md](notifications.md)) | `server/migrations/107_notification_task_question.sql` | `server/test-db/notification-question.test.ts` |
| Database-name guards | `server/src/config.ts`, `server/src/seed/cli.ts` | `server/test/config.persistence.test.ts` |
| db-suite harness: name guard, migrate, truncate and reseed per test; shared fixtures and generated ids | `server/test-db/harness.ts`, `server/test-db/fixtures.ts`, `server/test-db/batch-fixtures.ts` | `server/test/test-db.harness.test.ts`, `server/test/test-db.fixtures.test.ts` |
| db-suite databases: a once-migrated template, one clone per vitest worker keyed on `VITEST_POOL_ID`, and a run lock on the base database | `server/test-db/global-setup.ts`, `server/test-db/setup-worker.ts`, `server/test-db/database-names.ts`, `server/test-db/run-databases.ts`, `server/test-db/run-lock.ts`, `vitest.db.config.ts` | `server/test/test-db.per-worker.test.ts`, `server/test-db/run-databases.test.ts`, `server/test-db/run-lock.test.ts` |

## Invariants

- **The artifact index arbitrates the object store.** The chunk row is inserted before the write; a store 412 is
  success only when the stored body is the recorded sha256; a different body at one stream and offset is refused;
  every read is scoped to the caller's org. Finalization state lives on the manifest, never on `job`; the one
  exception is the root `job` row's checkpoint pointer (078), written in the manifest-finalize transaction.
  `server/test-db/artifact-store.test.ts`, `server/test-db/job-store.checkpoint-pointer.test.ts`.
- **Applied migrations are never edited.** They are skipped by filename, so an edit changes nothing
  for an existing database. Every schema change is a new file; a feature's schema is removed by a
  new `drop` migration (`023_drop_pull_requests.sql`), children listed before parents.
- **Versioned migrations run before repeatable ones, regardless of filename order.** Otherwise a
  new versioned file adding a column the views read fails purely on sort order.
- **`*.repeatable.sql` files are re-applied every boot and drop their views first.** Recording them
  would strand a view fix until a volume is deleted, and `create or replace` cannot retype a column.
  When `schema_migrations` holds a versioned file this build does not ship, the database is ahead of
  it and the repeatables are skipped; seeding and reaps still run. So every repeatable change, a revert
  included, ships a new no-op marker, the newest named after the repeatable files' hash
  (`090_views_<hash>.sql`). `server/test-db/migrate.concurrency.test.ts`, `core/test/migrations.sql.test.ts`.
- **A release only expands; a contract waits a release.** New tables, nullable or defaulted columns
  and appended view columns ship in a release. A drop, rename, type change, `set not null` or a
  rejecting trigger or check lands at least one release after the last code that touches the object:
  an older pod still runs against the newer schema mid-rollout and after a rollback.
  `server/src/db/migrate.ts`, `server/test-db/migrate.concurrency.test.ts`.
- **The schema names no extension** — `metric_point` is `partition by range (time)` with a single
  DEFAULT partition, which is what lets `database.url` point at RDS or Aurora.
- **Removing that DEFAULT partition breaks every write.** A range-partitioned table rejects any row
  no partition covers, and no writer can promise a range: an OTLP client's clock can run ahead
  or lag arbitrarily. Every unique index on the
  table must keep `time` among its columns.
- **Migrations run under one database-wide advisory xact lock** (`MIGRATION_LOCK_KEY`): a second
  process reads `schema_migrations` only after the first commits, and a wait past `lockWaitMs` fails
  the attempt. `server/test-db/migrate.concurrency.test.ts`.
- **Migrations are not awaited before `listen()`.** They retry with backoff while the database
  container starts; every store gates its own queries on `ready` and degrades until then.
- **`migrate()` also seeds the `AUTH_MODE=none` org and its stand-in account, and reaps expired
  sessions, at boot only.** Those parts are TypeScript beside the `.sql` runner because a `.sql`
  file cannot see the config; the read path checks `expires_at` regardless.
- **`test:db` never touches the `DATABASE_URL` database's rows.** It holds a session advisory lock there (a
  second run on the same name refuses with "test database <name> is in use by another run"), migrates a
  `<stem>_tpl_test` template and runs every worker on a `<stem>_w<N>_test` clone, all recreated by name each
  run and dropped at the end, together with the `<stem>_iso<hex>_test` scratch databases tests create (a test never
  drops its own: the forced checkpoint outlasts a hook under load). `assertTestDatabase` stays the one refusal point and runs before any connection.
  `TEST_DB_WORKERS` bounds the workers (default min(4, cores); 1 is serial).
  `server/test/test-db.per-worker.test.ts`, `server/test-db/run-databases.test.ts`, `server/test-db/run-lock.test.ts`.
- **Synthetic data reaches a database only through `npm run seed`, into a disposable one:** the seeding CLI refuses
  any name not ending `_seed`/`_synthetic`/`_demo`/`_e2e`/`_test`, and `loadConfig` refuses a disposable name for a
  fetching (App-mode) process ([configuration.md](configuration.md)). `server/test/config.persistence.test.ts`.
- A data directory initialised by `timescale/timescaledb` cannot start under `postgres:17`; `docker compose down -v`
  discards it. On a local cluster: `make reset`, or `helm uninstall factory-state` then
  `kubectl delete pvc -l app.kubernetes.io/instance=factory-state,app.kubernetes.io/component=postgres` in that order
  (the component label scopes the delete to the database's claim).
- **Stated limit:** the SQL, the views and the migration runner have no coverage in `npm test`; they
  are covered by `npm run test:db`, which refuses any database not named `*_test`.
