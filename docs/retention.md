# Retention

How long an organization's task history is kept: its plan's window, after which one pass deletes every thread that settled before it, with its objects and rows. Planned names are not backticked until they exist.

| Concern | Code | Test |
| --- | --- | --- |
| The window: `planLimits(orgId).retentionDays`, from a pushed `max_retention_days` or `PLAN_DEFAULT_MAX_RETENTION_DAYS` (column, push field `maxRetentionDays`, env and chart `dashboard.planDefaults.maxRetentionDays` planned in 147b) | `server/src/db/plan-limits.ts:41`, `server/src/db/commerce-plan-writer.ts`, `server/src/config.ts` | `server/test/config.plan-defaults.test.ts`; planned in 147b: server/test-db/org-retention.test.ts |
| Effective window and downgrade notice: an `org_retention` row (effective days, pending days, pending from), registered with its RLS policy | planned in 147b: server/src/db/org-retention.ts and its migration; `server/src/db/org-tables.ts` | `server/test-db/org-tables.test.ts`; planned in 147b: server/test-db/org-retention.test.ts |
| The pass: an interval loop on every replica, on the cross-org pool beside the org purge, reusing its step order | `server/src/main.ts:98` (`startCollectors`), `server/src/interval-loop.ts`, `server/src/db/org-purge.ts:40` | `server/test/cross-org-pool.test.ts`; planned in 147b: server/test-db/org-retention.test.ts |
| A thread's rows go through the Remove path | `server/src/db/jobs/job-store-thread-actions.ts:484` (`removeJobThread`) | `server/test-db/job-store.stop-remove.test.ts` |
| The window in the UI | planned in 147b: `GET /api/org/retention`, a section of `web/src/pages/SettingsOrganizationPage.tsx`, a deletion date on `web/src/pages/TaskDetailPage.tsx` | planned in 147b: a web test and an e2e spec (`npm run verify:ui`) |
| What members and admins read | `site/guides/retention.mdx` | `server/test/site-docs.test.ts` |

## Data classes

| Class and storage | Verdict |
| --- | --- |
| Threads: `job` (`server/migrations/006_jobs.sql:26`), its named-profile reviews and every table cascading from them, `transcript_tool_event` (`server/migrations/089_transcript_tool_event.sql:39`) included | **Expire** the whole thread through `removeJobThread`, never only its payloads (decided) |
| Transcripts, run logs, checkpoints: `artifact_chunk`, `artifact_manifest` (`server/migrations/070_artifact_index.sql:28`), objects under `<prefix><org>/<member>/<root>/` (`server/src/artifacts/keys.ts:56`) | **Expire**: objects, then rows. No foreign key to `job` and no collector today, so the pass deletes both |
| Attachments: `input_attachment` (`server/migrations/115_input_attachment.sql:12`), objects `server/src/attachments/attachment-store.ts:46` | **Expire**: the Remove path revokes them, the attachment collector deletes object then row; an unbound draft keeps `ATTACHMENTS_DRAFT_TTL_HOURS` |
| PR links and waits: `job_pr`, `workflow_wait` (`server/migrations/036_job_pr_lifecycle.sql:33`) | **Expire** by `root_job_id`: Remove cancels the waits but keeps the rows |
| `notification_event` (`server/migrations/102_notification_event.sql:11`, it copies the command), `notification_outbox` | **Expire** by `root_job_id`; the outbox cascades |
| Batches: `batch` (`server/migrations/059_batches.sql:25`) and its `batch_*` tables | **Expire** as one unit with every thread it backs, once each is eligible and `batch.updated_at` is past the window (Remove refuses a batch thread alone) |
| Task volumes `factory-task-<root>-<n>` (`driver/src/task-volume.ts:84`), docker and kubernetes | **Expire** with no driver change: a root gone from the board is reaped once `TASK_VOLUME_TTL_MS` old (`driver/src/reaper.ts:200`), both executors, so no kubernetes limit |
| `metric_point` (`server/migrations/001_init.sql:9`), `session_branch` (`server/migrations/001_init.sql:44`) | **Expire** points with `time`, and branch rows with `last_seen`, before the cutoff, on the same window as tasks (decided) |
| `audit_event` (`server/migrations/138_audit_event.sql:5`) | **Keep**: append-only by trigger, gone only with the org, as `site/guides/audit-log.mdx` promises |
| Usage: `job_execution` (`server/migrations/085_job_execution.sql:36`), `job_execution_session`, `commerce_usage_report` (`server/migrations/095_commerce.sql:28`), `org_token_usage` | **Keep**: ids, author, repo, minutes, no task content; a deleted reported row is enqueued again (`server/src/db/commerce-store.ts:99`) |
| Secrets: `secret` tombstones, `secret_operation` (`server/migrations/091_secret_store.sql:21`) | **Out of scope**: no secret identity names a thread ([secrets.md](secrets.md)); operations expire after 7 days (`server/src/secrets/secret-input.ts:14`) |
| Deleted skills' versions (`server/migrations/128_skills.sql:30`) | **Expire** on the org's window instead of `ARTIFACTS_RETENTION_DAYS` (`server/src/skills/skill-collector.ts:76`) |
| Own-expiry rows: idempotency keys (24 h, `server/src/db/jobs/job-store-idempotency.ts:20`), `batch_idempotency`, `attachment_upload`, OAuth codes and families, `session`, `task_reclaim`, `task_reclaim_ack` | **Out of scope**: their own sweep is shorter than any window |
| Every other `server/src/db/org-tables.ts` table: tokens, credentials, connections, `env_var`, executors, integrations, subscriptions, memberships, `org_plan`, `org_purge`, `pr_follow`, `pr_merge`, skills, `telemetry_session_owner`, repos, workflows | **Keep**: settings and per-PR or per-session facts, not task history; gone with the org purge |

## Invariants

- **The clock is the thread's last settle**: a thread is eligible only when every member and review is terminal (`server/src/db/task-summary.ts:10`), no `workflow_wait` of its root is pending, and its newest `finished_at` is older than the effective days. A suspended org's interrupted runs are queued again, never terminal; the pass skips every org that is not `active` (`server/src/db/org-status.ts`).
- **Only a task root is a candidate.** Follow-ups, retries and workflow successors share their root's `root_job_id`; a named-profile review is its own root (`server/src/db/jobs/job-store-reviews.ts:204`), but resumed claims read it as completion evidence, so its rows and its object prefix go only with the thread whose member it reviews (`review_of`, which `removeJobThread` already takes along), and its runs count in that thread's clock. A batch task's root goes only with its batch (row below).
- **Windows**: Free is the cloud default, 7 days; Pro 180 and Enterprise's days arrive by push. The board names no plan. Self-hosted with no `PLAN_DEFAULT_MAX_RETENTION_DAYS` is unlimited: no thread expires, and `ARTIFACTS_RETENTION_DAYS` (`server/src/config-artifacts.ts:145`) keeps governing a removed thread's leftovers and deleted skills.
- **One knob per deployment**: cloud refuses `ARTIFACTS_RETENTION_DAYS`, and any board refuses it beside `PLAN_DEFAULT_MAX_RETENTION_DAYS`; where an org has a window it also times the leftover and skill sweeps.
- **An upgrade applies at once, a downgrade after a 30-day notice** (a board constant, decided): a lower target sets pending days and writes one `system` audit row `org.retention_downgrade`; a target at or above the effective days clears it. No `org_retention` row is unlimited, so at rollout every existing org's first window is a downgrade with notice (decided).
- **Bounds**: a pass every hour, at most 120 s like `ORG_PURGE_PASS_MS`; orgs taken `for update skip locked` on their `org_retention` row; per org per pass at most 100 threads, object pages of `LIST_LIMIT` (`server/src/artifacts/object-store.ts:28`), and ten 10 000-row deletes of points; every step is safe to run again, so a cut pass resumes. 147b adds its candidate and `(org_id, time)` indexes under [persistence.md](persistence.md)'s index rule.
- **Order: fence, drain, secrets, objects, rows.** Under the thread lock the root is stamped expiring, after which follow-up, retry and reopen are refused and the claim offers none. Every object write to the thread's or its reviews' prefixes (artifact chunk, checkpoint, attachment `beginAttempt`) reads a thread fence (root present, not expiring) right before its put under `OBJECT_WRITE_BOUND_MS`, as `server/src/db/object-write-fence.ts` does per org; the pass lists those prefixes only once `OBJECT_WRITE_DRAIN_MS` has passed since the stamp, so a write accepted before the fence lands before the list that confirms empty. Secrets first were one ever to name a thread; then every object until a list answers empty; then the rows in one transaction. Planned in 147b: server/test-db/org-retention.fence.test.ts, after `server/test-db/org-purge.fence.test.ts`.
- **An unconfirmed list, delete or collect retries**: the thread stays for the next pass with a closed error code, never reported gone ([organizations.md](organizations.md)'s purge rule).
- **The pass reads absence, so it runs on the cross-org pool** and joins the list in [row-level-security.md](row-level-security.md).
- **Logs carry counts only**: one `retention.pass` line per org per pass (org id, counts, closed error codes); never a thread id, repo, title, command or object key.

## Stated limits

- Database backups and the server's log pipeline keep deleted data until their own expiry, set by the cloud infrastructure outside this repo.
- Which plan carries which window (pricing copy) and the processor review live outside this repo.
- A volume is reaped only by a running driver stamped with this board's identity ([workspace.md](workspace.md)).
