# Persistence

PostgreSQL is the only store; a process without `DATABASE_URL` refuses to boot. The offline suite stays
database-free through the in-memory stores in `server/test/helpers*.ts`.

| Concern | Code | Test |
| --- | --- | --- |
| Migration runner, boot seeding, session reaping | `server/src/db/migrate.ts` | `core/test/migrations.sql.test.ts`, `server/test-db/migrate.concurrency.test.ts` |
| Schema (ingest and views: [telemetry.md](telemetry.md)) | `server/migrations/*.sql` | `server/test-db/telemetry.sql.test.ts`, `server/test-db/telemetry.token-reduction.test.ts` |
| Inbound OAuth tables (122): refresh serialized on the family row | `server/migrations/122_oauth.sql`, `server/src/auth/oauth-store.ts` | `server/test-db/auth-store.oauth-concurrency.test.ts` |
| `metric_point_dedup` identity (086) | `server/migrations/086_metric_point_identity.sql` | `server/test-db/migration.086-metric-point-identity.test.ts` |
| Read cache warm-up and degradation | `server/src/stats-service.ts` | `server/test/routes.stats.get.test.ts` |
| Job and thread reads and writes | `server/src/db/jobs/*` | `server/test-db/job-store.*.test.ts` |
| Agent questions, `claim_seq`-stamped (050, 074) | `server/migrations/050_job_question.sql`, `server/migrations/074_job_question_claim_seq.sql`, `server/src/db/jobs/job-store-questions.ts` | `server/test-db/job-store.questions.test.ts` |
| Named-profile reviews (056) | `server/migrations/056_job_review.sql`, `server/src/db/jobs/job-store-reviews.ts` | `server/test-db/job-store.reviews.test.ts` |
| Claim sequence, never refunded (057) | `server/migrations/057_job_claim_seq.sql`, `server/src/db/jobs/job-store-claim.ts` | `server/test-db/job-store.interrupt.test.ts` |
| Task title on the root, `title_revision` compare-and-set, `job_title_event` audit (125) | `server/migrations/125_job_title.sql`, `server/src/db/jobs/job-store-title.ts` | `server/test-db/job-store.title.test.ts` |
| Idempotency keys (058) | `server/migrations/058_job_idempotency.sql`, `server/src/db/jobs/job-store-idempotency.ts` | `server/test-db/job-store.idempotency.test.ts` |
| Member uploads (115–118): `input_attachment`, state `pending`, `ready`, `bound`, `deleting`, `deleted` (a tombstone), each change a conditional UPDATE, objects under `<prefix>_attachments/<org>/<id>`; binding (`bound_job_id`, `root_job_id`, `position`, no FK to `job`) in the job-insert transaction, read per thread through a join to the job row, flipped to `deleting` by `removeThread`; sweep on every replica: a `pending`/`ready` row idle past `ATTACHMENTS_DRAFT_TTL_HOURS` (from `created_at` or `last_attempt_at`) and a `bound` row whose job row is gone flip to `deleting` (SKIP LOCKED), an upload stamps `last_attempt_at` while `pending` and aborts its object write `UPLOAD_WRITE_BOUND_MS` after, so the sweep deletes an object only that bound plus a margin after `deleting_at`, then marks `deleted` if `deleting_at` is unchanged, and a failed read or delete leaves the row for the next pass; a `deleted` tombstone's key is deleted once more `SECOND_DELETE_AFTER_MS` (a day) after `deleted_at`, recorded in `purged_at`. Stated limit: an object-store write that completes remotely later than that stays unreachable bytes behind the tombstone; reads stay denied, so it is only a storage leak | `server/migrations/114_input_attachment.sql`, `server/migrations/115_attachment_binding.sql`, `server/migrations/116_attachment_attempt.sql`, `server/src/attachments/attachment-rows.ts`, `server/src/attachments/attachment-store.ts`, `server/src/attachments/attachment-collector.ts`, `server/src/db/jobs/job-store-attachments.ts` | `server/test-db/attachment-store.test.ts`, `server/test/artifacts.object-store.test.ts`, `server/test-db/job-store.attachments.test.ts`, `server/test-db/attachment-collector.test.ts` |
| Batch plans and runtime (059–065; [batches.md](batches.md)) | `server/migrations/059_batches.sql`, `server/migrations/06[0-5]_*.sql`, `server/src/db/batches/batch-store*.ts` | `server/test-db/batch-store.test.ts`, `server/test-db/batch-dispatch.test.ts`, `server/test-db/batch-merge.test.ts` |
| Artifact index and manifests (070); checkpoint pointer on the root `job` row (079) | `server/migrations/070_artifact_index.sql`, `server/migrations/079_checkpoint_pointer.sql`, `server/src/artifacts/artifact-store.ts` | `server/test-db/artifact-store.test.ts`, `server/test-db/job-store.checkpoint-pointer.test.ts` |
| Settle receipts (072), reclaim ownership (075), staged conclusions (076) | `server/migrations/072_job_settle_receipts.sql`, `server/migrations/075_task_reclaim_ownership.sql`, `server/migrations/076_job_conclusions.sql`, `server/src/db/jobs/job-store-receipts.ts`, `server/src/db/jobs/job-store-reclaims.ts`, `server/src/db/jobs/job-store-conclusions.ts` | `server/test-db/job-store.receipts.test.ts`, `server/test-db/job-store.stop-remove.test.ts`, `server/test-db/job-store.conclusions.test.ts` |
| Phase checkpoints (080, 083), gate runs (087), PR operations (088) | `server/migrations/080_job_phase_checkpoints.sql`, `server/migrations/083_phase_checkpoint_setup.sql`, `server/migrations/087_job_gate_run.sql`, `server/migrations/088_job_pr_operation.sql`, `server/src/db/jobs/job-store-phase-checkpoints.ts`, `server/src/db/jobs/job-store-gate-runs.ts`, `server/src/db/jobs/job-store-pr-operations.ts` | `server/test-db/job-store.phase-checkpoints.test.ts`, `server/test-db/job-store.gate-runs.test.ts`, `server/test-db/job-store.pr-operations.test.ts` |
| Transcript tool events (089) | `server/migrations/089_transcript_tool_event.sql`, `server/src/db/jobs/job-store-transcript-tools.ts` | `server/test-db/transcript-tool-event.test.ts` |
| Admission slots on running rows (081) | `server/migrations/081_job_admission.sql`, `server/src/db/jobs/job-store-admission.ts` | `server/test-db/job-store.admission.test.ts` |
| PR follower cadence (082; [workflows.md](workflows.md)) | `server/migrations/082_pr_follow.sql`, `server/src/db/pr-follow-store.ts` | `server/test-db/pr-follow.test.ts` |
| `job.status` transition graph, refused in storage as 23514 `job_status_transition` (084) | `server/migrations/084_job_status_transitions.sql` | `server/test-db/job-store.transitions.test.ts` |
| Execution provenance outliving the job (085) and its usage reader | `server/migrations/085_job_execution.sql`, `server/src/db/jobs/job-store-provenance.ts`, `server/src/telemetry/usage-facts.ts` | `server/test-db/migration.085-job-execution.test.ts`, `server/test-db/job-store.execution-provenance.test.ts`, `server/test-db/token-reconciliation.test.ts` |
| Secret store (091, 092; [secrets.md](secrets.md)) | `server/migrations/091_secret_store.sql`, `server/migrations/092_secret_external.sql`, `server/src/secrets/postgres-secret-repo.ts` | `server/test-db/secrets-postgres.conformance.test.ts` |
| Env secret reference (093) and form check (113) | `server/migrations/093_env_var_secret_ref.sql`, `server/migrations/113_env_var_secret_form.sql` | `server/test-db/migration.093-env-secret-ref.test.ts`, `server/test-db/migration.113-env-secret-form.test.ts` |
| Integration connections (094) and operation receipts (099; [connections.md](connections.md)) | `server/migrations/094_integration_connections.sql`, `server/migrations/099_operation_receipts.sql`, `server/src/db/operation-receipts.ts` | `server/test-db/migration.094-integration-connections.test.ts`, `server/test-db/migration.099-operation-receipts.test.ts`, `server/test-db/operation-receipts.test.ts` |
| Commerce (095; [commerce.md](commerce.md)) | `server/migrations/095_commerce.sql`, `server/src/db/commerce-store.ts`, `server/src/db/commerce-plan-writer.ts` | `server/test-db/commerce-store.test.ts`, `server/test-db/commerce-plan-writer.test.ts` |
| Notification events, subscriptions (org-owned or personal `user_id`, 114), outbox, credential (102–107, 111, 114; [notifications.md](notifications.md)) | `server/migrations/102_notification_event.sql`, `server/migrations/103_notification_subscription.sql`, `server/migrations/104_notification_outbox.sql`, `server/migrations/111_notification_credential.sql`, `server/migrations/114_notification_personal_subscription.sql` | `server/test-db/notification-events.test.ts`, `server/test-db/notification-subscriptions.test.ts`, `server/test-db/notification-outbox.test.ts` |
| Database-name guards | `server/src/config.ts`, `server/src/seed/cli.ts` | `server/test/config.persistence.test.ts` |
| db-suite harness, fixtures, databases (template, per-worker clone, run lock) | `server/test-db/harness.ts`, `server/test-db/fixtures.ts`, `server/test-db/batch-fixtures.ts`, `server/test-db/global-setup.ts`, `server/test-db/setup-worker.ts`, `server/test-db/run-databases.ts`, `server/test-db/run-lock.ts`, `vitest.db.config.ts` | `server/test/test-db.harness.test.ts`, `server/test/test-db.fixtures.test.ts`, `server/test/test-db.per-worker.test.ts`, `server/test-db/run-databases.test.ts`, `server/test-db/run-lock.test.ts` |

## Invariants

- **Applied migrations are never edited.** They are skipped by filename; every schema change is a new file, a
  removed feature's schema a new `drop` migration (`023_drop_pull_requests.sql`), children before parents.
- **Versioned migrations run before repeatable ones; `*.repeatable.sql` files are re-applied every boot** and skipped when `schema_migrations` holds a versioned
  file this build does not ship. Every repeatable change, a revert included, ships a new no-op marker, the newest
  named after the repeatables' hash (`090_views_<hash>.sql`). `core/test/migrations.sql.test.ts`.
- **A release only expands; a contract waits a release.** A drop, rename, type change, `set not null` or rejecting
  trigger lands at least one release after the last code touching the object: an older pod runs against the newer
  schema mid-rollout and after a rollback. `server/test-db/migrate.concurrency.test.ts`.
- **The schema names no extension.** `metric_point` is `partition by range (time)` with a single DEFAULT partition;
  removing it breaks every write, and every unique index must keep `time`.
- **Migrations run under one advisory xact lock** (`MIGRATION_LOCK_KEY`), are not awaited before `listen()`, and
  retry with backoff; stores degrade until `ready`. `server/test-db/migrate.concurrency.test.ts`.
- **`migrate()` seeds the `AUTH_MODE=none` org and reaps expired sessions at boot only** — TypeScript beside the
  `.sql` runner, which cannot see the config.
- **The artifact index arbitrates the object store.** The chunk row is inserted before the write; a store 412 is
  success only when the stored body is the recorded sha256; every read is scoped to the caller's org.
  `server/test-db/artifact-store.test.ts`.
- **`test:db` never touches the `DATABASE_URL` database's rows.** It takes a session advisory lock there, migrates a
  `<stem>_tpl_test` template, runs workers on `<stem>_w<N>_test` clones (`TEST_DB_WORKERS`) and drops them at the
  end; `assertTestDatabase` is the one refusal point. `server/test/test-db.per-worker.test.ts`.
- **Synthetic data reaches only a disposable database** (`_seed`/`_synthetic`/`_demo`/`_e2e`/`_test`) through
  `npm run seed`; a fetching process refuses such a name ([configuration.md](configuration.md)).
  `server/test/config.persistence.test.ts`.
- **Stated limit:** the SQL, views and runner have no `npm test` coverage; `npm run test:db` covers them.
