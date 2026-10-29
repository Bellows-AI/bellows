# Managed connections

Which external services a task may use and as whom: an authorized connection the board owns and spends on
the runner's behalf, selected per task — and GitHub, whose token the board mints for each attempt from the App.

| Concern | Code | Test |
| --- | --- | --- |
| The table, the proxy's per-call SQL check over the thread's `job_connection_binding` rows | `server/migrations/054_connections.sql`, `server/migrations/094_integration_connections.sql`, `server/src/db/connection-store.ts` (`createConnectionOfLease`) | `server/test-db/connection-store.test.ts` |
| Create, list (the generic view), disconnect; who may own an org-wide one; site and credential shape | `server/src/routes/connections.ts` | `server/test/routes.connections.test.ts` |
| Task selection: `connections` on `POST /api/jobs` and `/:id/follow-up`, the owner's `POST /api/jobs/:id/connections` | `server/src/routes/connections.ts` (`parseConnectionIds`), `server/src/db/connection-bindings.ts`, `server/src/db/jobs/job-store-actions.ts` | `server/test/routes.jobs-connections.test.ts`, `server/test-db/job-store.connection-bindings.test.ts` |
| The settings panels (Organization: legacy shared rows; Workspace: the caller's own) | `web/src/panels/JiraConnectionsPanel.tsx`, `JiraConnectionsSection.tsx`, `web/src/components/JiraConnectionDialog.tsx`, `web/src/api/connections.ts` | `web/test/jira-connections-panel.render.test.tsx`, `web/test/jira-connections.dom.test.tsx`, `e2e/jira-connections.spec.ts` |
| CLI: `connection list`, `job create --connection`, `job preflight` | `cli/src/run.ts`, `cli/src/selection.ts`, `cli/src/diagnostics.ts`, `cli/src/board.ts` | `cli/test/discovery.test.ts`, `cli/test/diagnostics.test.ts` |
| The Jira proxy | `server/src/routes/connector-jira.ts` | `server/test/routes.connector-jira.test.ts` |
| The credential class: the attempt pair in every `AUTH_MODE`, nothing else | `server/src/auth/plugin.ts` (`CONNECTOR_ROUTES`) | `server/test/auth.enforcement.test.ts` |
| Runner side: `JIRA_API` | `docker/claude-executor/entrypoint.sh`, `docker/opencode-executor/entrypoint.sh` | `driver/test/executor-images.test.ts` |
| The agent's skill | `docker/skills/jira/SKILL.md` | `driver/test/executor-images.test.ts` |
| Docker and Kubernetes carry no Jira credential, only the pair and the board URL | `driver/src/claim.ts`, `driver/src/k8s/k8s-podspec.ts` | `driver/test/docker/`, `driver/test/k8s/` |
| `ATLASSIAN_*` reserved env names | `core/src/env.ts`, `driver/src/claim.ts` | `server/test/routes.env.test.ts` |
| GitHub: `POST /api/jobs/:id/credentials/github` (attempt pair only, `no-store`) | `server/src/routes/github-credential.ts`, `server/src/db/attempt-of-lease.ts` | `server/test/routes.github-credential.test.ts`, `server/test-db/github-credential.test.ts` |
| Managed-connection broker: `POST /api/jobs/:id/credentials/connections/:connectionId` (attempt pair only, `no-store`; closed outcomes, `409 INTEGRATION_REQUIRED`; the token is rechecked against the lease before it leaves) | `server/src/routes/connection-credential.ts`, `server/src/db/attempt-of-lease.ts` (the shared lease check, keyed on the root's execution user), `server/src/integrations/integration-recovery.ts` (`resolverOf`) | `server/test-db/connection-credential.test.ts`, `server/test/routes.connection-credential.test.ts` |
| GitHub: one mint per ask, narrowed to the task's repo and `RUNNER_TOKEN_PERMISSIONS`; GitHub's answered `permissions`/`repositories` are checked against that ceiling (broader or unstated is revoked and refused) | `server/src/github/app-token.ts` (`fresh`) | `server/test/github.app-token.test.ts` |
| GitHub revoke: `POST /api/jobs/:id/credentials/github/revoke` (attempt pair only, no liveness; revokes the one token in the body at the configured `apiUrl`, `204` only on a confirmed revoke) | `server/src/routes/github-credential.ts`, `server/src/db/attempt-of-lease.ts` (`createPairMatches`), `server/src/github/app-token.ts` (`revoke`) | `server/test/routes.github-credential.test.ts`, `server/test-db/github-credential.test.ts` |
| GitHub, runner side: the image helper behind git's `credential.helper` and the `gh` wrapper; byte-identical in both images | `docker/claude-executor/github-credential.cjs`, `gh-wrapper.sh`, `entrypoint.sh`, `docker/opencode-executor/entrypoint.sh` | `driver/test/github-credential.test.ts`, `driver/test/executor-images.test.ts` |
| The attempt pair on an adopted runner: the supervisor answers the lease it follows on `GET /attempt`; every helper (Jira recipes, GitHub helper, branch reporter) reads it through `attempt-pair.cjs`, byte-identical in both images | `driver/src/scripts/supervisor.cjs` (`relayRequest`), `docker/claude-executor/control-proxy.cjs`, `docker/claude-executor/attempt-pair.cjs`, `driver/src/supervisor-contract.ts` (`SupervisorBinding.leaseToken`) | `driver/test/supervisor.test.ts`, `driver/test/attempt-pair.test.ts`, `driver/test/takeover-sim.test.ts` |
| GitHub, the helper's cache (`GITHUB_CACHE_DIR`; memory-backed, agent container only) | `driver/src/claim.ts`, `driver/src/docker/docker.ts`, `driver/src/k8s/k8s-podspec.ts` | `driver/test/github-credential.test.ts` |
| GitHub, driver side: asked before the sync's fetch, each publish, each github-writing helper and each gate run | `driver/src/github-credential-call.ts`, `loop-github.ts`, `loop-gates.ts`, `gates.ts`, `k8s-gate.ts`, `supervised-steps.ts` | `driver/test/board.test.ts`, `driver/test/loop/`, `driver/test/gates.test.ts`, `driver/test/k8s/` |
| `GITHUB_TOKEN` and `GH_TOKEN` reserved env names | `core/src/env.ts`, `driver/src/claim.ts`, `driver/src/config.ts`, `server/migrations/072_github_env_reserved.sql` | `server/test/routes.env.test.ts`, `driver/test/config.test.ts`, `driver/test/executor-images.test.ts` |
| GitHub, the lanes (forced expiry, App-less refusal, Memory cache) | `server/src/offline-mint.ts`, `scripts/test-jobs.sh`, `scripts/test-k8s.sh`, `scripts/k8s-stub.sh` | `server/test/test-jobs.harness.test.ts`, `driver/test/lane-stubs.test.ts` |
| Portable integration layer: definition, closed outcomes, bounded operation runner; imports nothing from `server` | `core/src/integrations/`, `lint/no-cross-package-imports.grit` | `core/test/integrations.operation.test.ts`, `core/test/integrations.boundary.test.ts`, `server/test/integrations.contract.test.ts` |
| Grant lineage: one claim per grant, the exchange, identical-replay persistence, recovery by claim kind, destroy of a revoked secret | `server/migrations/096_grant_lineage.sql`, `server/src/integrations/grant-lineage.ts`, `server/src/integrations/grant-credentials.ts`, `server/src/integrations/oauth-provider.ts`, `server/src/db/connection-grants.ts` (`finalizeLineage`) | `server/test-db/integration-lineage.test.ts`, `server/test-db/connection-grants.test.ts`, `server/test-db/migration.096-grant-lineage.test.ts`, `server/test-db/connection-lock-order.test.ts` |
| Credential resolver, trusted context and the binding ceiling | `server/src/integrations/credential-resolver.ts`, `server/src/integrations/trusted-context.ts` | `server/test-db/integration-resolver.test.ts` |
| Authorization transaction (module API, no route yet): start, callback validation, claim-before-exchange reconnect, secret-first new grant, recovery | `server/migrations/097_integration_authorization.sql`, `server/src/integrations/authorization-flow.ts`, `authorization-complete.ts`, `authorization-store.ts`, `server/src/db/connection-grants.ts` (`attachInTx`) | `server/test-db/integration-authorization.test.ts`, `server/test-db/migration.097-integration-authorization.test.ts` |
| Composition and recovery: one lineage and flow per org, a bounded pass on every replica (expired claims with or without a recorded operation, revoked grants' secrets, authorizations past their deadline), the destroy after a disconnect that revoked a grant | `server/src/integrations/integration-recovery.ts`, `server/src/main.ts`, `server/src/routes/connections.ts` | `server/test-db/integration-recovery.test.ts`, `server/test/routes.connections.test.ts` |

## Invariants

- **The Jira credential never leaves the board.** The runner holds the attempt pair; the proxy adds the
  connection's Basic auth, and revocation is a `DELETE` (a soft disconnect) the next call sees. `server/test/routes.connector-jira.test.ts`.
- **Every call re-checks the live attempt**, with no tail grace: job unfinished, lease unexpired, no stop
  requested, not a reviewer row. The thread's one live jira binding must still match its connection's account,
  and the root's execution user must still be a member (and the owner of a personal one); two live bindings
  refuse `ambiguous`, and nothing in the request names a connection. `server/test-db/connection-store.test.ts`.
- **Selection is the root task's bindings, stamped at create**; follow-ups, retries and workflow nodes read the
  root's. A personal connection binds by default only when it is the lone candidate; a legacy org one binds only
  when named. A provider a selected skill requires with no live binding is an open requirement: the claim never
  offers the queued root and spends no attempt. `server/test-db/job-store.connection-bindings.test.ts`.
- **Bindings, requirements and grant revocation serialize on locks, never on a read**: the bind route, the claim's
  acquire and follow-ups lock in one order: root row (`for no key update`), thread advisory lock, grant, connection.
  Until the contract release `job.jira_connection_id` is a projection of the root's one live jira binding (null
  otherwise) for old pods. `server/src/db/connection-bindings.ts`, `server/test-db/connection-lock-order.test.ts`.
- **Org-wide connections are admin-created; personal ones are the owner's.** The proxy forwards GET and HEAD
  only, reaches `rest/api/3/*` on the connection's cloud id, and `site` must be `*.atlassian.net`.
  `server/test/routes.connections.test.ts`, `server/test/routes.connector-jira.test.ts`.
- **The Jira token is in no response, log line or error text**; refusals name the fix
  (`CONNECTION_NOT_AUTHORIZED`). `server/test/routes.connector-jira.test.ts`.
- **GitHub's token is the attempt's, never the claim's.** No GitHub value rides the claim, the runner's env or
  Secret; a reviewer row and a superseded, cancelled or finished attempt get none.
  `server/test-db/github-credential.test.ts`, `driver/test/github-credential.test.ts`.
- **Post-agent driver phases (gates, post-helpers, publish) ask under the attempt's running lease, with no grace after
  settle; the agent's helper lives only in the agent container and ends with it, and aux containers carry no attempt
  pair.** `server/test-db/connection-credential.test.ts`, `server/test-db/github-credential.test.ts`.
- **A reconnect claims the grant's lineage before it exchanges the code; a new grant's secret is created before
  its connection is visible.** The callback's return path is the one stored at start. `server/test-db/integration-authorization.test.ts`.
- **A recorded operation is released only after its ID is durably fenced at the store.** A `not-found` reconcile is
  "not yet": recovery first binds the ID to a delete at a never-active version, so a holder paused before its request
  is refused `operation-id-reused`. An unconfirmed fence leaves the row; a record is refused past the lease; an
  authorization settles only past its own `deadline_at`. The abort timer and the per-instance attempt registry are
  mitigation only. `server/src/integrations/operation-fence.ts`, `server/test-db/integration-lineage.test.ts`,
  `server/test/integrations-replay.test.ts`.
- **An enumeration is a candidate list, never a verdict.** The pass acts only through each module's own guarded
  statements; a store that does not answer leaves the row for the next tick. `server/test-db/integration-recovery.test.ts`.

## Stated limits

- Legacy API tokens are plaintext at rest (`server/migrations/054_connections.sql`); a disconnect scrubs one.
  OAuth grants hold their secret in the SecretStore only.
- The destroy after a disconnect is best effort and the answer stays 204; the background pass is its retry. No provider
  is registered yet, so the runtime recovers rows and destroys secrets but starts no authorization.
- A wedged secret reference is permanent: an operation whose payload was lost blocks every later mutation on it, delete
  included. The grant moves to a fresh reference on reconnect and the old one stays encrypted at rest, uncollected.
- Jira is scoped API-token auth: a classic token is stored untried and answers 401 on every call.
- GitHub is the App's alone: no member token, no PAT; a revoked installation surfaces as the route's `502`.
- A gate run's GitHub token is asked at its start and never renewed during it: one gate running past
  its hour runs on an expired token. It rides that run's gate step, whose env the gate container
  exports for the run alone (`driver/src/gates.ts`, `driver/src/scripts/gate-loop.sh`).
- The helper answers `https://github.com` only: an Enterprise `GITHUB_API_URL` deployment's agent runs git and
  gh without a credential.
- A transient relay failure on an adopted runner falls back to the env lease: that one call may be refused
  (`docker/claude-executor/attempt-pair.cjs`); the next re-reads the pair.
- A supervised step's token rides its step request, which crosses the mailbox volume, not memory.
- No in-place edit and no per-task picker in the UI: delete and re-add.
