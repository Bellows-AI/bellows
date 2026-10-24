# Managed connections

Which external services a task may use and as whom: an authorized connection the board owns and spends on
the runner's behalf, selected per task — and GitHub, whose token the board mints for each attempt from the App.

| Concern | Code | Test |
| --- | --- | --- |
| The table, the proxy's per-call SQL check, `job.jira_connection_id` | `server/migrations/054_connections.sql`, `server/src/db/connection-store.ts` | `server/test-db/connection-store.test.ts` |
| Create, list, delete; who may own an org-wide one; site and credential shape | `server/src/routes/connections.ts` | `server/test/routes.connections.test.ts` |
| Task selection: `jiraConnection` on `POST /api/jobs` | `server/src/routes/connections.ts` (`resolveJiraConnection`), `server/src/db/connection-store.ts` (`defaultFor`), `server/src/db/jobs/job-store-actions.ts` | `server/test/routes.connections.test.ts`, `server/test-db/connection-store.test.ts` |
| The settings panels (Organization, Workspace) | `web/src/panels/JiraConnectionsPanel.tsx`, `JiraConnectionsSection.tsx`, `web/src/components/JiraConnectionDialog.tsx`, `web/src/api/connections.ts` | `web/test/jira-connections-panel.render.test.tsx`, `web/test/jira-connections.dom.test.tsx`, `e2e/jira-connections.spec.ts` |
| CLI: `connection list`, `job create --jira-connection`, `job preflight` | `cli/src/run.ts`, `cli/src/selection.ts`, `cli/src/diagnostics.ts`, `cli/src/board.ts` | `cli/test/discovery.test.ts`, `cli/test/diagnostics.test.ts` |
| The Jira proxy | `server/src/routes/connector-jira.ts` | `server/test/routes.connector-jira.test.ts` |
| The credential class: the attempt pair in every `AUTH_MODE`, nothing else | `server/src/auth/plugin.ts` (`CONNECTOR_ROUTES`) | `server/test/auth.enforcement.test.ts` |
| Runner side: `JIRA_API` | `docker/claude-executor/entrypoint.sh`, `docker/opencode-executor/entrypoint.sh` | `driver/test/executor-images.test.ts` |
| The agent's skill | `docker/skills/jira/SKILL.md` | `driver/test/executor-images.test.ts` |
| Docker and Kubernetes carry no Jira credential, only the pair and the board URL | `driver/src/claim.ts`, `driver/src/k8s/k8s-podspec.ts` | `driver/test/docker/`, `driver/test/k8s/` |
| `ATLASSIAN_*` reserved env names | `core/src/env.ts`, `driver/src/claim.ts` | `server/test/routes.env.test.ts` |
| GitHub: `POST /api/jobs/:id/credentials/github` (attempt pair only, `no-store`) | `server/src/routes/github-credential.ts`, `server/src/db/github-credential.ts` | `server/test/routes.github-credential.test.ts`, `server/test-db/github-credential.test.ts` |
| GitHub: one mint per ask, narrowed to the task's repo and `RUNNER_TOKEN_PERMISSIONS` | `server/src/github/app-token.ts` (`fresh`) | `server/test/github.app-token.test.ts` |
| GitHub, runner side: the image helper behind git's `credential.helper` and the `gh` wrapper; byte-identical in both images | `docker/claude-executor/github-credential.cjs`, `gh-wrapper.sh`, `entrypoint.sh`, `docker/opencode-executor/entrypoint.sh` | `driver/test/github-credential.test.ts`, `driver/test/executor-images.test.ts` |
| GitHub, the helper's cache (`GITHUB_CACHE_DIR`; memory-backed, agent container only) | `driver/src/claim.ts`, `driver/src/docker/docker.ts`, `driver/src/k8s/k8s-podspec.ts` | `driver/test/github-credential.test.ts` |
| GitHub, driver side: asked before the sync's fetch, each publish, each github-writing helper and each gate run | `driver/src/github-credential-call.ts`, `loop-github.ts`, `loop-gates.ts`, `gates.ts`, `k8s-gate.ts`, `supervised-steps.ts` | `driver/test/board.test.ts`, `driver/test/loop/`, `driver/test/gates.test.ts`, `driver/test/k8s/` |
| `GITHUB_TOKEN` and `GH_TOKEN` reserved env names | `core/src/env.ts`, `driver/src/claim.ts`, `driver/src/config.ts`, `server/migrations/072_github_env_reserved.sql` | `server/test/routes.env.test.ts`, `driver/test/config.test.ts`, `driver/test/executor-images.test.ts` |
| GitHub, the lanes (forced expiry, App-less refusal, Memory cache) | `server/src/offline-mint.ts`, `scripts/test-jobs.sh`, `scripts/test-k8s.sh`, `scripts/k8s-stub.sh` | `server/test/test-jobs.harness.test.ts`, `driver/test/lane-stubs.test.ts` |

## Invariants

- **The Jira credential never leaves the board.** The runner holds the attempt pair; the proxy adds the
  connection's Basic auth, and revocation is a `DELETE` the next call sees. `server/test/routes.connector-jira.test.ts`.
- **Every call re-checks the live attempt**, with no tail grace: job unfinished, lease unexpired, no stop
  requested. `server/test-db/connection-store.test.ts`.
- **Selection is the root task's, stamped at create**; follow-ups, retries and workflow nodes read the root's
  `jira_connection_id`. `server/src/db/connection-store.ts`.
- **Org-wide connections are admin-created; personal ones are the owner's.** The proxy forwards GET and HEAD
  only, reaches `rest/api/3/*` on the connection's cloud id, and `site` must be `*.atlassian.net`.
  `server/test/routes.connections.test.ts`, `server/test/routes.connector-jira.test.ts`.
- **The Jira token is in no response, log line or error text**; refusals name the fix
  (`CONNECTION_NOT_AUTHORIZED`). `server/test/routes.connector-jira.test.ts`.
- **GitHub's token is the attempt's, never the claim's.** No GitHub value rides the claim, the runner's env or
  Secret; a reviewer row and a superseded, cancelled or finished attempt get none.
  `server/test-db/github-credential.test.ts`, `driver/test/github-credential.test.ts`.

## Stated limits

- Connection tokens are plaintext at rest, the `env_var` rule ([env.md](env.md)).
- Jira is scoped API-token auth: a classic token is stored untried and answers 401 on every call.
- GitHub is the App's alone: no member token, no PAT; a revoked installation surfaces as the route's `502`.
- A gate run's GitHub token is asked at its start and never renewed during it: one gate running past
  its hour runs on an expired token. It rides that run's gate step, whose env the gate container
  exports for the run alone (`driver/src/gates.ts`, `driver/src/scripts/gate-loop.sh`).
- A runner whose driver was lost keeps its old pair; once the lease rotates, the helper is refused for that run.
- The helper answers `https://github.com` only: an Enterprise `GITHUB_API_URL` deployment's agent runs git and
  gh without a credential.
- A supervised step's token rides its step request, which crosses the mailbox volume, not memory.
- No in-place edit and no per-task picker in the UI: delete and re-add.
