# API

Every HTTP surface the board serves under `/api/*`. The route files are the contract — status
codes, query parameters and error codes are read there, never restated here.

| Surface | Code | Test |
| --- | --- | --- |
| Sign-in, session, org switch | `server/src/routes/auth.ts` | `server/test/auth.oauth.sign-in.test.ts` |
| Onboarding (parked sign-in, installation pick) | `server/src/routes/auth-onboarding.ts` | `server/test/auth.completion.test.ts` |
| Personal and org access tokens | `server/src/routes/tokens.ts` | `server/test/auth.tokens.test.ts` |
| Liveness and readiness probes | `server/src/routes/health.ts` | `server/test/routes.health.test.ts` |
| Release version (`/api/version`, open) | `server/src/routes/version.ts` | `server/test/routes.version.test.ts` |
| Skill discovery (`GET /api/skills`; never the instructions) | `server/src/routes/skills.ts` | `server/test/skills.test.ts` |
| `baseBranch` on `POST /api/jobs` (`BAD_BASE_BRANCH` 400; `UNKNOWN_BASE_BRANCH` 422 only on a confirmed 404, an unconfirmed read accepts) | `server/src/routes/jobs/job-handlers-worker.ts` | `server/test/routes.jobs-base-branch.test.ts` |
| Dashboard payload (`/api/stats`) | `server/src/routes/stats.ts`, `core/src/types.ts` (`StatsUsage`) | `server/test/routes.stats.get.test.ts`, `server/test/routes.stats.scope.test.ts` |
| OTLP ingest, `/api/sessions/branch` | `server/src/routes/ingest.ts` | `server/test/routes.ingest.test.ts` |
| Prometheus scrape (`GET /api/metrics`, worker credential only) | `server/src/routes/prometheus.ts` | `server/test/routes.prometheus.test.ts` |
| Jobs: create, claim, worker reports, conclusion, actions, reclaims, wait ([batches.md](batches.md)) | `server/src/routes/jobs/jobs.ts`, `server/src/routes/jobs/job-handlers-actions.ts`, `server/src/routes/jobs/job-handlers-worker.ts` | `server/test/routes.jobs.test.ts`, `server/test/routes.job-conclusion.test.ts` |
| `Idempotency-Key` on job create, follow-up and retry | `server/src/routes/jobs/job-idempotency.ts` | `server/test/routes.jobs.test.ts`, `server/test-db/cli.scripting.test.ts` |
| Executor refusals on create (`UNKNOWN_EXECUTOR`, `EXECUTOR_SUSPENDED`) | `server/src/routes/jobs/executor-usable.ts` | `server/test/routes.executor-lifecycle.test.ts`, `cli/test/diagnostics.test.ts` |
| Run activity (`GET /api/jobs/:id/activity`; 200 with `usage.state` `unavailable` when telemetry is unreadable) | `server/src/routes/jobs/job-handlers-actions.ts`, `server/src/telemetry/run-activity.ts` | `server/test/run-activity.test.ts`, `server/test-db/token-reconciliation.test.ts` |
| Phase checkpoints, gate runs, PR operations (worker routes under the lease) | `server/src/routes/jobs/job-handlers-phase-checkpoints.ts`, `server/src/routes/jobs/job-handlers-gate-runs.ts`, `server/src/routes/jobs/job-handlers-pr-operations.ts` | `server/test/routes.job-phase-checkpoints.test.ts`, `server/test/routes.job-gate-runs.test.ts`, `server/test/routes.job-pr-operations.test.ts` |
| Artifact upload and reads | `server/src/routes/jobs/job-handlers-artifacts.ts`, `server/src/artifacts/artifact-read.ts` | `server/test/routes.artifacts.test.ts`, `server/test/routes.artifacts-read.test.ts` |
| Member uploads, raw `application/octet-stream` body, name in `x-attachment-name`, optional `Idempotency-Key`: `POST /api/attachments`, `GET /api/attachments/limits`, `/:id`, `/:id/content`, `DELETE /:id`; codes `ATTACHMENT_UNSUPPORTED`, `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_NOT_FOUND`, `BAD_ATTACHMENT`, `ATTACHMENTS_UNAVAILABLE` | `server/src/routes/attachments.ts`, `core/src/attachments.ts`, `core/src/error-codes.ts` | `server/test/routes.attachments.test.ts` |
| `attachments: string[]` (ready ids, at most `MAX_FILES_PER_REQUEST`) on `POST /api/jobs` and `/:id/follow-up`, bound with the job or not at all; refusals `BAD_ATTACHMENT`, `ATTACHMENT_NOT_AUTHORIZED` (403), `ATTACHMENT_TOO_LARGE` (413); `GET /api/jobs/:id/thread` rows carry `attachments` | `server/src/routes/jobs/job-task-refs.ts`, `job-field-validation.ts`, `job-idempotency.ts`, `core/src/error-codes.ts` | `server/test/routes.jobs-attachments.test.ts` |
| Restore reads (checkpoint, transcripts; lease in the body) | `server/src/routes/jobs/job-handlers-restore.ts` | `server/test/routes.restore.test.ts`, `server/test-db/job-store.restore-scope.test.ts` |
| Worker input read, worker + live lease in the body: `POST /api/jobs/:id/attachments/:attachmentId/content` (bytes, `x-content-sha256`; 404 outside the job's effective set, 409 lease lost, 410 `ATTACHMENT_GONE`, 422 `ARTIFACT_CORRUPT`, 503 when unconfirmed); `claim` and the review claim carry `attachments` | `server/src/routes/jobs/job-handlers-attachment-content.ts`, `server/src/db/jobs/job-store-attachments.ts` | `server/test/routes.attachment-content.test.ts` |
| Agent questions and named reviewers | `server/src/routes/jobs/job-handlers-questions.ts`, `server/src/routes/jobs/job-handlers-reviews.ts` | `server/test/routes.jobs.test.ts` |
| Task read model (`/api/tasks`) | `server/src/routes/tasks.ts` | `server/test/routes.tasks.test.ts` |
| Managed connections and the outbound OAuth connect ([connections.md](connections.md)) | `server/src/routes/connections.ts`, `server/src/routes/integrations.ts` | `server/test/routes.connections.test.ts`, `server/test/routes.integrations.test.ts`, `server/test-db/jira-authorization.test.ts` |
| Bind, requirement ask and dismiss on a task | `server/src/routes/jobs/job-handlers-actions.ts` (`handleBindConnection`), `server/src/routes/jobs/job-handlers-requirements.ts` | `server/test/routes.jobs-connections.test.ts` |
| Runner credentials and operation receipts ([connections.md](connections.md)) | `server/src/routes/github-credential.ts`, `server/src/routes/connection-credential.ts`, `server/src/routes/operation-receipts.ts` | `server/test/routes.github-credential.test.ts`, `server/test/routes.connection-credential.test.ts`, `server/test/routes.operation-receipts.test.ts` |
| Batches (`/api/batches`; [batches.md](batches.md)) | `server/src/routes/batches/batches.ts`, `server/src/routes/batches/batch-handlers.ts` | `server/test/routes.batches.test.ts` |
| Repo picker (`/api/repos`) | `server/src/routes/repos.ts` | `server/test/routes.repos.test.ts` |
| Runner env in three scopes | `server/src/routes/env.ts` | `server/test/routes.env.test.ts` |
| Workspace payload, personal executors | `server/src/routes/workspace.ts` | `server/test/routes.workspace.test.ts`, `server/test/routes.executor-lifecycle.test.ts` |
| Organization executor profiles, member roster | `server/src/routes/org-executors.ts`, `server/src/routes/org-members.ts` | `server/test/routes.org-executors.test.ts`, `server/test/routes.org-members.test.ts` |
| Workflow definitions and the block catalog | `server/src/routes/workflows.ts` | `server/test/routes.workflows.test.ts` |
| Notification subscriptions, org and personal, test send ([notifications.md](notifications.md)) | `server/src/routes/notification-subscriptions.ts` | `server/test-db/notification-subscriptions.routes.test.ts`, `server/test-db/notification-workspace-subscriptions.routes.test.ts` |
| Commerce, registered only with `COMMERCE_ENABLED` ([commerce.md](commerce.md)) | `server/src/routes/commerce.ts` | `server/test/routes.commerce.test.ts` |
| GitHub webhook deliveries | `server/src/routes/webhook.ts` | `server/test/webhook.test.ts` |
| Which credential a path needs | `server/src/auth/plugin.ts` (`requirementFor`) | `server/test/auth.enforcement.test.ts` |
| Error codes (one home; `lint/no-shared-literals.grit` enforces) | `core/src/error-codes.ts` | `core/test/error-codes.test.ts` |

## Invariants

- A route is authenticated unless `requirementFor` deliberately exempts it. `server/test/auth.enforcement.test.ts`.
- `GET /api/auth/me` answers `200 { authenticated: false }` anonymously, never `401`.
  `server/test/auth.oauth.me.test.ts`.
- Artifact upload is authorized by the claim sequence the request names, never by the lease; a read of
  another org's job is `404`. `server/test/routes.artifacts.test.ts`, `server/test/routes.artifacts-read.test.ts`.
- Job routes register only when `buildApp` is given a job store, workspace routes only with a `userExecutors`
  store. `server/src/app.ts`.
- The organization is the credential's, never a request field; `?org=` only selects among the caller's
  memberships. `server/test/routes.stats.organization.test.ts`, [organizations.md](organizations.md).
- Lease-guarded worker routes answer `409 LEASE_LOST`; only `heartbeat`'s is a kill order ([jobs.md](jobs.md)).
