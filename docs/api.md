# API

Every HTTP surface the board serves under `/api/*`. The route files are the contract — status
codes, query parameters and error codes are read there, never restated here.

| Surface | Code | Test |
| --- | --- | --- |
| Failure shape: a store outage is a generic `503 UNAVAILABLE`, anything else is `500 INTERNAL` with a `requestId`; the thrown text is logged, never sent (the driver retries both) | `server/src/routes/error-handler.ts`, `server/src/routes/helpers.ts` | `server/test/routes.error-handler.test.ts` |
| Sign-in, session, org switch; Onboarding (parked sign-in, installation pick) | `server/src/routes/auth.ts`, `server/src/routes/auth-onboarding.ts` | `server/test/auth.oauth.sign-in.test.ts`, `server/test/auth.completion.test.ts` |
| Personal and org access tokens | `server/src/routes/tokens.ts` | `server/test/auth.tokens.test.ts` |
| Liveness and readiness probes; Release version (`/api/version`, open) | `server/src/routes/health.ts`, `server/src/routes/version.ts` | `server/test/routes.health.test.ts`, `server/test/routes.version.test.ts` |
| Skill discovery: `GET /api/skills` (every entry carries `source`; never the instructions) and the repo slash-menu list `GET /api/repos/:owner/:name/skills` (an unconfirmed repo read is `repoError`) | `server/src/routes/skills.ts`, `server/src/skill-catalog.ts`, `server/src/github/skill-read.ts` | `server/test/skills.test.ts`, `server/test/routes.repo-skills.test.ts`, `server/test/github.skill-read.test.ts` |
| Org and workspace skills (`/api/org/skills`, `/api/workspace/skills`): a JSON edit needs `baseVersionId` (409 `SKILL_VERSION_STALE`); an unconfirmed store read is 503 | `server/src/routes/skills-store.ts` | `server/test/routes.skills-store.test.ts` |
| `baseBranch` and `title` on `POST /api/jobs` (`UNKNOWN_BASE_BRANCH` 422 only on a confirmed 404, an unconfirmed read accepts; `title` is part of the idempotency fingerprint), `PUT /api/jobs/:id/title` (`TITLE_STALE` 409) | `server/src/routes/jobs/job-handlers-worker.ts`, `server/src/routes/jobs/job-handlers-worker.ts`, `server/src/routes/jobs/job-handlers-title.ts`, `server/src/routes/jobs/job-idempotency.ts` | `server/test/routes.jobs-base-branch.test.ts`, `server/test/routes.jobs-title.test.ts`, `server/test/routes.job-title.test.ts` |
| `hiddenSkills` (`[{name, reason}]`) on `GET /api/jobs/:id` only: the skills the run's CLI does not list, absent from lists and the thread read | `server/src/db/jobs/job-store-rows.ts` (`toJob`), `server/src/db/jobs/job-store-reads.ts` | `server/test-db/job-store.skill-hidden.test.ts` |
| Provider catalog read, `GET /api/integrations/catalog` (`q`, `category`, `limit`, `cursor`; each provider's state from the shared catalog, the deployment's OAuth config and the caller's own connections, counts only; a failed connection read is 503) | `server/src/routes/integration-catalog.ts`, `core/src/integration-catalog.ts` | `server/test/routes.integration-catalog.test.ts` |
| Advisory checks of a create's selection, `POST /api/jobs/preflight`: an unconfirmed read is `unverified`, never `blocked` | `server/src/routes/jobs/job-preflight.ts`, `server/src/db/connection-store.ts` | `server/test/routes.job-preflight.test.ts`, `server/test-db/connection-store.test.ts` |
| Dashboard payload (`/api/stats`) | `server/src/routes/stats.ts`, `core/src/types.ts` (`StatsUsage`) | `server/test/routes.stats.get.test.ts`, `server/test/routes.stats.scope.test.ts` |
| OTLP ingest, `/api/sessions/branch` | `server/src/routes/ingest.ts` | `server/test/routes.ingest.test.ts` |
| Prometheus scrape (`GET /api/metrics`, worker credential only) | `server/src/routes/prometheus.ts` | `server/test/routes.prometheus.test.ts` |
| Jobs: create, claim, worker reports, conclusion, actions, reclaims, wait ([batches.md](batches.md)) | `server/src/routes/jobs/jobs.ts`, `server/src/routes/jobs/job-handlers-actions.ts`, `server/src/routes/jobs/job-handlers-worker.ts` | `server/test/routes.jobs.test.ts`, `server/test/routes.job-conclusion.test.ts` |
| `Idempotency-Key` on job create, follow-up and retry; Executor refusals on create (`UNKNOWN_EXECUTOR`, `EXECUTOR_SUSPENDED`) | `server/src/routes/jobs/job-idempotency.ts`, `server/src/routes/jobs/executor-usable.ts` | `server/test/routes.jobs.test.ts`, `server/test-db/cli.scripting.test.ts`, `server/test/routes.executor-lifecycle.test.ts`, `cli/test/diagnostics.test.ts` |
| Run activity (`GET /api/jobs/:id/activity`; 200 with `usage.state` `unavailable` when telemetry is unreadable) | `server/src/routes/jobs/job-handlers-actions.ts`, `server/src/telemetry/run-activity.ts` | `server/test/run-activity.test.ts`, `server/test-db/token-reconciliation.test.ts` |
| Phase checkpoints, gate runs, PR operations (worker routes under the lease) | `server/src/routes/jobs/job-handlers-phase-checkpoints.ts`, `server/src/routes/jobs/job-handlers-gate-runs.ts`, `server/src/routes/jobs/job-handlers-pr-operations.ts` | `server/test/routes.job-phase-checkpoints.test.ts`, `server/test/routes.job-gate-runs.test.ts`, `server/test/routes.job-pr-operations.test.ts` |
| Artifact upload and reads | `server/src/routes/jobs/job-handlers-artifacts.ts`, `server/src/artifacts/artifact-read.ts` | `server/test/routes.artifacts.test.ts`, `server/test/routes.artifacts-read.test.ts` |
| Member uploads (`/api/attachments`): raw body, optional `Idempotency-Key`; Upload capabilities ([mcp.md](mcp.md), [auth.md](auth.md)): `POST /api/attachments/upload-requests`; Worker input read: `POST /api/jobs/:id/attachments/:attachmentId/content`, worker credential plus live lease in the body | `server/src/routes/attachments.ts`, `core/src/attachments.ts`, `core/src/error-codes.ts`, `server/src/routes/attachment-uploads.ts`, `server/src/routes/attachment-ingest.ts`, `server/src/routes/jobs/job-handlers-attachment-content.ts`, `server/src/db/jobs/job-store-attachments.ts` | `server/test/routes.attachments.test.ts`, `server/test/mcp.attachment-upload.test.ts`, `server/test-db/mcp.attachment-handoff.test.ts`, `server/test/routes.attachment-content.test.ts` |
| `attachments: string[]` (ready ids, at most `MAX_FILES_PER_REQUEST`) on `POST /api/jobs` and `/:id/follow-up`, bound with the job or not at all; refusals `BAD_ATTACHMENT`, `ATTACHMENT_NOT_AUTHORIZED` (403), `ATTACHMENT_TOO_LARGE` (413); `GET /api/jobs/:id/thread` rows carry `attachments` | `server/src/routes/jobs/job-task-refs.ts`, `job-field-validation.ts`, `job-idempotency.ts`, `core/src/error-codes.ts` | `server/test/routes.jobs-attachments.test.ts` |
| Restore reads (checkpoint, transcripts; lease in the body) | `server/src/routes/jobs/job-handlers-restore.ts` | `server/test/routes.restore.test.ts`, `server/test-db/job-store.restore-scope.test.ts` |
| Agent questions and named reviewers | `server/src/routes/jobs/job-handlers-questions.ts`, `server/src/routes/jobs/job-handlers-reviews.ts` | `server/test/routes.jobs.test.ts` |
| Task read model (`/api/tasks`) | `server/src/routes/tasks.ts` | `server/test/routes.tasks.test.ts` |
| Managed connections and the outbound OAuth connect ([connections.md](connections.md)) | `server/src/routes/connections.ts`, `server/src/routes/integrations.ts` | `server/test/routes.connections.test.ts`, `server/test/routes.integrations.test.ts`, `server/test-db/jira-authorization.test.ts` |
| Bind, requirement ask and dismiss on a task | `server/src/routes/jobs/job-handlers-actions.ts` (`handleBindConnection`), `server/src/routes/jobs/job-handlers-requirements.ts` | `server/test/routes.jobs-connections.test.ts` |
| Runner credentials, operation receipts and the agent title ([connections.md](connections.md)) | `server/src/routes/github-credential.ts`, `server/src/routes/connection-credential.ts`, `server/src/routes/operation-receipts.ts`, `server/src/routes/agent-title.ts` | `server/test/routes.github-credential.test.ts`, `server/test/routes.connection-credential.test.ts`, `server/test/routes.operation-receipts.test.ts`, `server/test/routes.agent-title.test.ts` |
| Batches (`/api/batches`; reads carry `standing`; [batches.md](batches.md)) | `server/src/routes/batches/batches.ts`, `server/src/routes/batches/batch-handlers.ts` | `server/test/routes.batches.test.ts`, `server/test/routes.batches.standing.test.ts` |
| Repo picker (`/api/repos`) | `server/src/routes/repos.ts` | `server/test/routes.repos.test.ts` |
| Branch list and prefix search (`GET /api/repos/:owner/:name/branches?q=&cursor=`; `400 BAD_BRANCH_QUERY`/`BAD_BRANCH_CURSOR`, `503 BRANCHES_UNAVAILABLE` on any unconfirmed read) | `server/src/routes/repos.ts`, `server/src/github/app-client.ts` | `server/test/routes.repos.test.ts`, `server/test/github.app-client.test.ts` |
| Runner env in three scopes | `server/src/routes/env.ts` | `server/test/routes.env.test.ts` |
| Workspace payload, personal executors | `server/src/routes/workspace.ts` | `server/test/routes.workspace.test.ts`, `server/test/routes.executor-lifecycle.test.ts` |
| Organization executor profiles, member roster | `server/src/routes/org-executors.ts`, `server/src/routes/org-members.ts` | `server/test/routes.org-executors.test.ts`, `server/test/routes.org-members.test.ts` |
| Workflow definitions and the block catalog | `server/src/routes/workflows.ts` | `server/test/routes.workflows.test.ts` |
| Notification subscriptions, org and personal, test send ([notifications.md](notifications.md)) | `server/src/routes/notification-subscriptions.ts` | `server/test-db/notification-subscriptions.routes.test.ts`, `server/test-db/notification-workspace-subscriptions.routes.test.ts` |
| Commerce, registered only with `COMMERCE_ENABLED` ([commerce.md](commerce.md)) | `server/src/routes/commerce.ts` | `server/test/routes.commerce.test.ts` |
| `POST /api/mcp`, registered only with `MCP_ENABLED`: Streamable HTTP, stateless, an audience-bound `mat_` in github mode | `server/src/mcp/routes.ts`, `server/src/auth/plugin.ts` (`enforceMcp`) | `server/test/mcp.transport.test.ts` |
| OAuth authorization server for MCP, registered only with `MCP_ENABLED` in github mode; the member's connected apps are cookie-session, class `none` ([auth.md](auth.md)) | deny`, `GET /api/oauth/grants`, `POST /api/oauth/grants/:id/revoke` (the member's connected apps; cookie session, class `none`) ([auth.md](auth.md)) | `server/src/routes/oauth.ts` |
| GitHub webhook deliveries | `server/src/routes/webhook.ts` | `server/test/webhook.test.ts` |
| Which credential a path needs | `server/src/auth/plugin.ts` (`requirementFor`) | `server/test/auth.enforcement.test.ts` |
| Error codes (one home; `lint/no-shared-literals.grit` enforces) | `core/src/error-codes.ts` | `core/test/error-codes.test.ts` |

## Invariants

- A route is authenticated unless `requirementFor` deliberately exempts it. `server/test/auth.enforcement.test.ts`.
- `GET /api/auth/me` answers `200 { authenticated: false }` anonymously, never `401`. A signed-in answer carries `mcp`, whether this board serves MCP (the Account page shows connected apps only then), and `batches`, whether `BATCHES_ENABLED` is on (the web shows the Batches pages only then). With batches off every `/api/batches` route answers `404 { code: BATCHES_DISABLED }`.
  `server/test/auth.oauth.me.test.ts`.
- Artifact upload is authorized by the claim sequence the request names, never by the lease; a read of
  another org's job is `404`. `server/test/routes.artifacts.test.ts`, `server/test/routes.artifacts-read.test.ts`.
- Job routes register only when `buildApp` is given a job store, workspace routes only with a `userExecutors`
  store. `server/src/app.ts`.
- The organization is the credential's, never a request field; `?org=` only selects among the caller's
  memberships. `server/test/routes.stats.organization.test.ts`, [organizations.md](organizations.md).
- Lease-guarded worker routes answer `409 LEASE_LOST`; only `heartbeat`'s is a kill order ([jobs.md](jobs.md)).
