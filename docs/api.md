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
| Dashboard payload (`/api/stats`) | `server/src/routes/stats.ts` | `server/test/routes.stats.get.test.ts` |
| OTLP ingest, `/api/sessions/branch` | `server/src/routes/ingest.ts` | `server/test/routes.ingest.test.ts` |
| Jobs: create, claim, worker reports, `POST /:id/conclusion`, actions, reclaims and their holds (`POST /api/reclaims/holds`), `GET /:id?waitFor=terminal` ([batches.md](batches.md) for `done` with `force`) | `server/src/routes/jobs.ts` and `job-*.ts` | `server/test/routes.jobs.test.ts`, `server/test/routes.job-conclusion.test.ts` |
| Phase checkpoints: `POST /api/jobs/:id/phase-checkpoint` (write), `/phase-checkpoints` (read), worker routes under the lease | `server/src/routes/job-handlers-phase-checkpoints.ts`, `server/src/routes/jobs.ts` | `server/test/routes.job-phase-checkpoints.test.ts`, `server/test/auth.enforcement.test.ts` |
| `Idempotency-Key` header on `POST /api/jobs`, `/:id/follow-up`, `/:id/retry` | `server/src/routes/job-idempotency.ts` | `server/test/routes.jobs.test.ts`, `server/test-db/cli.scripting.test.ts` |
| Run activity (`GET /api/jobs/:id/activity`) | `server/src/routes/job-handlers-actions.ts`, `server/src/telemetry/run-activity.ts` | `server/test/routes.jobs.test.ts`, `server/test/run-activity.test.ts` |
| Artifact reads: `GET /api/jobs/:id/artifacts`, `/artifacts/read` | `server/src/routes/job-handlers-artifacts.ts`, `server/src/artifacts/artifact-read.ts` | `server/test/routes.artifacts-read.test.ts`, `server/test-db/artifact-read.test.ts` |
| Agent questions: `POST /api/jobs/:id/question` (worker), `questions/:questionId/answer` (member) | `server/src/routes/job-handlers-questions.ts`, `job-handlers-worker.ts` | `server/test/routes.jobs.test.ts`, `server/test/auth.enforcement.test.ts` |
| Named reviewers: `POST /api/jobs/:id/review`, `review-read` (worker, lease-fenced) | `server/src/routes/job-handlers-reviews.ts` | `server/test/routes.jobs.test.ts`, `server/test/auth.enforcement.test.ts` |
| Task read model (`/api/tasks`) | `server/src/routes/tasks.ts` | `server/test/routes.tasks.test.ts` |
| Managed connections and the runner's Jira proxy ([connections.md](connections.md)) | `server/src/routes/connections.ts`, `connector-jira.ts` | `server/test/routes.connections.test.ts`, `server/test/routes.connector-jira.test.ts` |
| The runner's GitHub token: `POST /api/jobs/:id/credentials/github` ([connections.md](connections.md)) | `server/src/routes/github-credential.ts` | `server/test/routes.github-credential.test.ts`, `server/test-db/github-credential.test.ts` |
| Batches: `/api/batches` ([batches.md](batches.md)) | `server/src/routes/batches.ts`, `batch-handlers.ts` | `server/test/routes.batches.test.ts`, `server/test/auth.enforcement.test.ts` |
| Repo picker (`/api/repos`) | `server/src/routes/repos.ts` | `server/test/routes.repos.test.ts` |
| Runner env in three scopes | `server/src/routes/env.ts` | `server/test/routes.env.test.ts` |
| Workspace, checkouts, personal executors (incl. `DELETE /executors/:id`, `POST /executors/:id/suspension`) | `server/src/routes/workspace.ts`, `workspace-purge.ts` | `server/test/routes.workspace.test.ts`, `server/test/routes.executor-lifecycle.test.ts` |
| Organization executor profiles | `server/src/routes/org-executors.ts` | `server/test/routes.org-executors.test.ts` |
| Member roster and roles | `server/src/routes/org-members.ts` | `server/test/routes.org-members.test.ts` |
| Workflow definitions and the block catalog | `server/src/routes/workflows.ts` | `server/test/routes.workflows.test.ts` |
| GitHub webhook deliveries | `server/src/routes/webhook.ts` | `server/test/webhook.test.ts` |
| Which credential a path needs | `server/src/auth/plugin.ts` (`requirementFor`) | `server/test/auth.enforcement.test.ts` |

Error codes have one home, `core/src/error-codes.ts`, pinned by `core/test/error-codes.test.ts`
and by the `lint/no-shared-literals.grit` plugin.

## Invariants

- Artifact upload (`PUT /api/jobs/:id/artifact/chunk`, `/manifest`) is authorized by the claim sequence the
  request names, never by the lease, and writes nothing on `job`. `server/src/routes/job-handlers-artifacts.ts`,
  `server/test/routes.artifacts.test.ts`.
- Artifact reads resolve through the caller's org, so another org's job is `404`; a removed job answers its
  indexed streams as `deleted`. `server/test/routes.artifacts-read.test.ts`, `server/test-db/artifact-read.test.ts`.
- Transcript exports never reach token metrics; where a session has both, the `session_source` view keeps OTEL.
  `server/test-db/artifact-read.test.ts`.
- A route is authenticated unless `requirementFor` (`server/src/auth/plugin.ts`) deliberately exempts it.
  `server/test/auth.enforcement.test.ts`.
- `GET /api/auth/me` answers `200 { authenticated: false }` anonymously, never `401`; a present bearer is
  still the credential there. `server/test/auth.oauth.me.test.ts`, `server/test/auth.tokens.test.ts`.
- Job routes register only when `buildApp` is given a job store, workspace routes only with a `userRepos`
  store. `server/src/app.ts`.
- The organization is the credential's, never a request field; `?org=` only selects among the caller's
  memberships. `server/test/routes.stats.organization.test.ts`, [organizations.md](organizations.md).
- A stale read is still a `200` carrying its staleness (`/api/stats`, `/api/repos`).
- Lease-guarded worker routes answer `409 LEASE_LOST`; only `heartbeat`'s is a kill order ([jobs.md](jobs.md)).
