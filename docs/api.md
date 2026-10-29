# API

Every HTTP surface the board serves under `/api/*`. The route files are the contract — status
codes, query parameters and error codes are read there, never restated here.

| Surface | Code | Test |
| --- | --- | --- |
| Sign-in, session, org switch | `server/src/routes/auth.ts` | `server/test/auth.oauth.sign-in.test.ts` |
| Onboarding (parked sign-in, installation pick) | `server/src/routes/auth-onboarding.ts` | `server/test/auth.completion.test.ts` |
| Personal and org access tokens | `server/src/routes/tokens.ts` | `server/test/auth.tokens.test.ts` |
| Liveness and readiness probes | `server/src/routes/health.ts` | `server/test/routes.health.test.ts` |
| Packaged release version (`/api/version`, open) | `server/src/routes/version.ts`, `server/src/version.ts` | `server/test/routes.version.test.ts`, `server/test/auth.enforcement.test.ts` |
| Skill discovery (`GET /api/skills`; never the instructions) | `server/src/routes/skills.ts`, `server/src/skills.ts` | `server/test/skills.test.ts` |
| Dashboard payload (`/api/stats`; every token figure rides in `telemetry.usage`, none beside the session figures) | `server/src/routes/stats.ts`, `core/src/types.ts` (`StatsUsage`) | `server/test/routes.stats.get.test.ts`, `server/test/routes.stats.scope.test.ts` |
| OTLP ingest, `/api/sessions/branch` | `server/src/routes/ingest.ts` | `server/test/routes.ingest.test.ts` |
| Jobs: create, claim, worker reports, `POST /:id/conclusion`, actions, reclaims, `GET /:id?waitFor=terminal` ([batches.md](batches.md) for `done` with `force`) | `server/src/routes/jobs/*` | `server/test/routes.jobs.test.ts`, `server/test/routes.job-conclusion.test.ts` |
| Phase checkpoints: `POST /api/jobs/:id/phase-checkpoint` (write), `/phase-checkpoints` (read), worker routes under the lease | `server/src/routes/jobs/job-handlers-phase-checkpoints.ts`, `server/src/routes/jobs/jobs.ts` | `server/test/routes.job-phase-checkpoints.test.ts`, `server/test/auth.enforcement.test.ts` |
| Gate runs: `POST /api/jobs/:id/gate-run` (write one execution row), `/gate-runs` (read the run's latest row per gate), worker routes under the lease | `server/src/routes/jobs/job-handlers-gate-runs.ts`, `server/src/db/jobs/job-store-gate-runs.ts` | `server/test/routes.job-gate-runs.test.ts`, `server/test/auth.enforcement.test.ts` |
| PR operation: `POST /api/jobs/:id/pr-operation` (write one created/reused operation row), worker route under the lease | `server/src/routes/jobs/job-handlers-pr-operations.ts`, `server/src/db/jobs/job-store-pr-operations.ts` | `server/test/routes.job-pr-operations.test.ts`, `server/test/auth.enforcement.test.ts` |
| `Idempotency-Key` header on `POST /api/jobs`, `/:id/follow-up`, `/:id/retry` | `server/src/routes/jobs/job-idempotency.ts` | `server/test/routes.jobs.test.ts`, `server/test-db/cli.scripting.test.ts` |
| `POST /api/jobs` refuses an executor its scope does not hold (404 `UNKNOWN_EXECUTOR`) or that is suspended (409 `EXECUTOR_SUSPENDED`), as `job preflight` reports it | `server/src/routes/jobs/executor-usable.ts`, `server/src/routes/jobs/job-handlers-worker.ts` | `server/test/routes.executor-lifecycle.test.ts`, `cli/test/diagnostics.test.ts` |
| Run activity (`GET /api/jobs/:id/activity`): the run's buckets and `usage`, plus the canonical `task` (reviews and run-unassigned usage included, the same from any job id of it); a type the run never measured is null, never zero; `gates` and `prs` (this run) and `taskActivity` (every run of the task, thread plus named reviews, resolved from board records whatever telemetry does) from the board's own records, null counts and `partial` coverage where not recorded; 200 with `usage.state` `unavailable` when telemetry is off or unreadable | `server/src/routes/jobs/job-handlers-actions.ts`, `server/src/telemetry/run-activity.ts`, `server/src/db/jobs/job-store-activity-records.ts`, `server/src/telemetry/client.ts` | `server/test/routes.jobs.test.ts`, `server/test/run-activity.test.ts`, `server/test-db/token-reconciliation.test.ts` |
| Artifact reads: `GET /api/jobs/:id/artifacts`, `/artifacts/read` | `server/src/routes/jobs/job-handlers-artifacts.ts`, `server/src/artifacts/artifact-read.ts` | `server/test/routes.artifacts-read.test.ts`, `server/test-db/artifact-read.test.ts` |
| Restore reads, worker + live lease in the body: `POST /api/jobs/:id/checkpoint` (`none`, `gone` or the pointer and its chunk list), `/checkpoint/chunk`, `/transcripts`, `/transcripts/chunk` (bytes, `x-chunk-sha256`; 422 `ARTIFACT_CORRUPT` when the stored bytes fail it) | `server/src/routes/jobs/job-handlers-restore.ts` | `server/test/routes.restore.test.ts`, `server/test-db/job-store.restore-scope.test.ts` |
| Agent questions: `POST /api/jobs/:id/question` (worker), `questions/:questionId/answer` (member) | `server/src/routes/jobs/job-handlers-questions.ts`, `job-handlers-worker.ts` | `server/test/routes.jobs.test.ts`, `server/test/auth.enforcement.test.ts` |
| Named reviewers: `POST /api/jobs/:id/review`, `review-read` (worker, lease-fenced) | `server/src/routes/jobs/job-handlers-reviews.ts` | `server/test/routes.jobs.test.ts`, `server/test/auth.enforcement.test.ts` |
| Task read model (`/api/tasks`) | `server/src/routes/tasks.ts` | `server/test/routes.tasks.test.ts` |
| Managed connections and the runner's Jira proxy ([connections.md](connections.md)) | `server/src/routes/connections.ts`, `connector-jira.ts` | `server/test/routes.connections.test.ts`, `server/test/routes.connector-jira.test.ts` |
| The outbound OAuth connect: `POST /api/integrations/:provider/authorizations` (`201` authorize URL, `503 INTEGRATION_NOT_CONFIGURED`) and `GET /api/integrations/:provider/callback` (`303` to the stored path with `integration` and `result`; session only, logs no query) ([connections.md](connections.md)) | `server/src/routes/integrations.ts` | `server/test/routes.integrations.test.ts`, `server/test-db/jira-authorization.test.ts`, `server/test/auth.enforcement.test.ts` |
| `POST /api/jobs/:id/connections`: the owner binds a connection to a thread (`BINDING_REVISION_STALE` on a stale revision) | `server/src/routes/jobs/job-handlers-actions.ts` (`handleBindConnection`) | `server/test/routes.jobs-connections.test.ts` |
| The runner's GitHub token: `POST /api/jobs/:id/credentials/github` and its `/revoke` ([connections.md](connections.md)) | `server/src/routes/github-credential.ts` | `server/test/routes.github-credential.test.ts`, `server/test-db/github-credential.test.ts` |
| The runner's managed-connection token: `POST /api/jobs/:id/credentials/connections/:connectionId` ([connections.md](connections.md)) | `server/src/routes/connection-credential.ts` | `server/test/routes.connection-credential.test.ts`, `server/test-db/connection-credential.test.ts` |
| The runner seam: `GET /api/jobs/:id/credentials/connections` and the operation receipts `POST /api/jobs/:id/operations`, `PUT /api/jobs/:id/operations/:receiptId` ([connections.md](connections.md)) | `server/src/routes/connection-credential.ts`, `server/src/routes/operation-receipts.ts` | `server/test/routes.operation-receipts.test.ts`, `server/test-db/connection-credential.test.ts` |
| Batches: `/api/batches` ([batches.md](batches.md)); the report's `usage.tokenUsage`, `totals.tokenUsage` and `usageSnapshotAt` are core `UsageBlock`s | `server/src/routes/batches/batches.ts`, `batch-handlers.ts`, `server/src/db/batches/batch-store-types.ts` | `server/test/routes.batches.test.ts`, `server/test/auth.enforcement.test.ts` |
| Repo picker (`/api/repos`) | `server/src/routes/repos.ts` | `server/test/routes.repos.test.ts` |
| Runner env in three scopes | `server/src/routes/env.ts` | `server/test/routes.env.test.ts` |
| Workspace payload, personal executors (incl. `DELETE /executors/:id`, `POST /executors/:id/suspension`) | `server/src/routes/workspace.ts` | `server/test/routes.workspace.test.ts`, `server/test/routes.executor-lifecycle.test.ts` |
| Organization executor profiles | `server/src/routes/org-executors.ts` | `server/test/routes.org-executors.test.ts` |
| Member roster and roles | `server/src/routes/org-members.ts` | `server/test/routes.org-members.test.ts` |
| Workflow definitions and the block catalog | `server/src/routes/workflows.ts` | `server/test/routes.workflows.test.ts` |
| Commerce: `GET /api/commerce` (member), `PUT /api/commerce/orgs/:orgId/plan` (the service; [commerce.md](commerce.md)); registered only with `COMMERCE_ENABLED` | `server/src/routes/commerce.ts` | `server/test/routes.commerce.test.ts` |
| GitHub webhook deliveries | `server/src/routes/webhook.ts` | `server/test/webhook.test.ts` |
| Which credential a path needs | `server/src/auth/plugin.ts` (`requirementFor`) | `server/test/auth.enforcement.test.ts` |

Error codes have one home, `core/src/error-codes.ts`, pinned by `core/test/error-codes.test.ts`
and by the `lint/no-shared-literals.grit` plugin.
| Prometheus scrape (`GET /api/metrics`, worker credential only) | `server/src/routes/prometheus.ts`, `server/src/auth/plugin.ts` | `server/test/routes.prometheus.test.ts`, `server/test/auth.enforcement.test.ts` |

## Invariants

- Artifact upload (`PUT /api/jobs/:id/artifact/chunk`, `/manifest`) is authorized by the claim sequence the
  request names, never by the lease, and writes nothing on `job` except a `checkpoint` manifest's pointer on the
  root row ([persistence.md](persistence.md)); chunks are raw bytes. `server/src/routes/jobs/job-handlers-artifacts.ts`,
  `server/test/routes.artifacts.test.ts`, `server/test-db/job-store.checkpoint-pointer.test.ts`.
- Artifact reads resolve through the caller's org, so another org's job is `404`; a removed job answers its
  indexed streams as `deleted`. `server/test/routes.artifacts-read.test.ts`, `server/test-db/artifact-read.test.ts`.
- Transcript exports never reach token metrics; where a session has both, the `session_source` view keeps OTEL.
  `server/test-db/artifact-read.test.ts`.
- A route is authenticated unless `requirementFor` (`server/src/auth/plugin.ts`) deliberately exempts it.
  `server/test/auth.enforcement.test.ts`.
- `GET /api/auth/me` answers `200 { authenticated: false }` anonymously, never `401`; a present bearer is
  still the credential there. `server/test/auth.oauth.me.test.ts`, `server/test/auth.tokens.test.ts`.
- Job routes register only when `buildApp` is given a job store, workspace routes only with a `userExecutors`
  store. `server/src/app.ts`.
- The organization is the credential's, never a request field; `?org=` only selects among the caller's
  memberships. `server/test/routes.stats.organization.test.ts`, [organizations.md](organizations.md).
- A stale read is still a `200` carrying its staleness (`/api/stats`, `/api/repos`).
- Lease-guarded worker routes answer `409 LEASE_LOST`; only `heartbeat`'s is a kill order ([jobs.md](jobs.md)).
