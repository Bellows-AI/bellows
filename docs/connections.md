# Managed connections

Which external services a task may use and as whom: an authorized connection the board owns and spends on
the runner's behalf, selected per task — and GitHub, whose token the board mints for each attempt from the App.

| Concern | Code | Test |
| --- | --- | --- |
| The table and the member's own OAuth rows: list, candidates, disconnect | `server/migrations/054_connections.sql`, `server/migrations/094_integration_connections.sql`, `server/src/db/connection-store.ts` | `server/test-db/connection-store.test.ts` |
| List (the generic view) and disconnect; a connection is made only by the authorization flow | `server/src/routes/connections.ts` | `server/test/routes.connections.test.ts` |
| Task selection: `connections` on `POST /api/jobs` and `/:id/follow-up`, the owner's `POST /api/jobs/:id/connections` | `server/src/routes/connections.ts` (`parseConnectionIds`), `server/src/db/connection-bindings.ts`, `server/src/db/jobs/job-store-actions.ts` | `server/test/routes.jobs-connections.test.ts`, `server/test-db/job-store.connection-bindings.test.ts` |
| A running task asks for a connection: the requirement wait (hand-back `requirement`, held by the claim gate, bound or dismissed by the owner, outcome told to the resumed claim) | `server/src/db/connection-bindings.ts` (`requireAtRuntimeInTx`), `server/src/db/jobs/job-store-connections.ts`, `server/migrations/102_runtime_requirements.sql`, `server/src/integrations/credential-resolver.ts` (`bindingStanding`) | `server/test-db/job-store.runtime-requirement.test.ts`, `server/test-db/migration.102-runtime-requirements.test.ts` |
| The runner's ask: a helper with no connection calls `connection-ask.cjs`, which posts `/connection` on the agent's control socket; the Jira helper exits 3 `waiting_for_connection` / `connection_unavailable` | `docker/claude-executor/connection-ask.cjs` (byte-identical in `docker/opencode-executor/`), `docker/claude-executor/control-proxy.cjs`, `docker/skills/jira/jira.cjs`, `driver/src/connection-control.ts` | `driver/test/connection-ask.test.ts`, `driver/test/jira-helper.test.ts`, `driver/test/executor-images.test.ts`, `connection_roundtrip_lane` in `scripts/test-jobs.sh`, `# runtime connection requirement` in `scripts/test-k8s.sh` |
| The settings panel (Workspace only; the Organization page has none): the caller's rows with account and site, Connect Jira (optional site, "Allow adding comments"), Reconnect, Allow adding comments (a read row; the confirmation warns read-bound tasks of the account will be refused), Disconnect, the callback's result sentence; the start navigates to the consent URL, nothing binds a task | `web/src/panels/JiraConnectionsPanel.tsx`, `JiraConnectionsSection.tsx`, `web/src/components/JiraConnectionDialog.tsx`, `JiraWriteConsentDialog.tsx`, `web/src/api/connections.ts` | `web/test/jira-connections-panel.render.test.tsx`, `web/test/jira-connections.dom.test.tsx`, `e2e/jira-connections.spec.ts` |
| The operator's one-time Atlassian app registration: console steps, callback URL, scopes, distribution, env and chart names | `docs/jira-app-runbook.md` | `server/test/config.integrations.test.ts` |
| CLI: `connection list`, `job create --connection`, `job preflight` | `cli/src/run.ts`, `cli/src/selection.ts`, `cli/src/diagnostics.ts`, `cli/src/board.ts` | `cli/test/discovery.test.ts`, `cli/test/diagnostics.test.ts` |
| Legacy API-token connections end: 100 disconnects the rows, scrubs the tokens, nulls the legacy `job.jira_connection_id` and leaves each thread with a queued job an open root-scoped requirement; nothing lists, binds or serves one | `server/migrations/100_legacy_jira_tokens.sql`, `server/src/db/connection-bindings.ts` | `server/test-db/migration.100-legacy-jira-tokens.test.ts`, `server/test-db/job-store.connection-bindings.test.ts` |
| The credential class: the attempt pair in every `AUTH_MODE`, nothing else | `server/src/auth/plugin.ts` (`CONNECTOR_ROUTES`) | `server/test/auth.enforcement.test.ts` |
| Runner side: no Jira variable; both entrypoints drop a `JIRA_API` the claim env carried | `docker/claude-executor/entrypoint.sh`, `docker/opencode-executor/entrypoint.sh` | `driver/test/executor-images.test.ts` |
| The agent's skill and its helper (issue, search, comments, add-comment through the broker's `connectionCredential`; a durable receipt and a property-only reconcile for add-comment; requests resolved against the API origin only) | `docker/skills/jira/SKILL.md`, `docker/skills/jira/jira.cjs` | `driver/test/jira-helper.test.ts`, `server/test/jira-helper-parity.test.ts`, `driver/test/executor-images.test.ts`, `driver/test/skill-helper-paths.test.ts` |
| Docker and Kubernetes carry no Jira credential, only the pair and the board URL | `driver/src/claim.ts`, `driver/src/k8s/k8s-podspec.ts` | `driver/test/docker/`, `driver/test/k8s/` |
| GitHub: `POST /api/jobs/:id/credentials/github` (attempt pair only, `no-store`) | `server/src/routes/github-credential.ts`, `server/src/db/attempt-of-lease.ts` | `server/test/routes.github-credential.test.ts`, `server/test-db/github-credential.test.ts` |
| Managed-connection broker: `POST /api/jobs/:id/credentials/connections/:connectionId` (attempt pair only, `no-store`; closed outcomes, `409 INTEGRATION_REQUIRED`; the token is rechecked against the lease before it leaves) | `server/src/routes/connection-credential.ts`, `server/src/db/attempt-of-lease.ts` (the shared lease check, keyed on the root's execution user), `server/src/integrations/integration-recovery.ts` (`resolverOf`) | `server/test-db/connection-credential.test.ts`, `server/test/routes.connection-credential.test.ts` |
| Runner seam: `GET /api/jobs/:id/credentials/connections` (the root's live OAuth bindings with `apiBase`, never a credential or an account; re-read on every helper call) and the operation receipt, `POST /api/jobs/:id/operations` / `PUT /api/jobs/:id/operations/:receiptId` (attempt pair only; begin needs the live attempt and a live binding, a move needs only the pair) | `server/src/routes/connection-credential.ts`, `server/src/routes/operation-receipts.ts`, `server/src/db/operation-receipts.ts`, `server/migrations/099_operation_receipts.sql` | `server/test/routes.operation-receipts.test.ts`, `server/test-db/operation-receipts.test.ts`, `server/test-db/connection-credential.test.ts`, `server/test-db/migration.099-operation-receipts.test.ts` |
| GitHub: one mint per ask, narrowed to the task's repo and `RUNNER_TOKEN_PERMISSIONS`; GitHub's answered `permissions`/`repositories` are checked against that ceiling (broader or unstated is revoked and refused) | `server/src/github/app-token.ts` (`fresh`) | `server/test/github.app-token.test.ts` |
| GitHub revoke: `POST /api/jobs/:id/credentials/github/revoke` (attempt pair only, no liveness; revokes the one token in the body at the configured `apiUrl`, `204` only on a confirmed revoke) | `server/src/routes/github-credential.ts`, `server/src/db/attempt-of-lease.ts` (`createPairMatches`), `server/src/github/app-token.ts` (`revoke`) | `server/test/routes.github-credential.test.ts`, `server/test-db/github-credential.test.ts` |
| GitHub, runner side: the image helper behind git's `credential.helper` and the `gh` wrapper, a front end of the broker client; byte-identical in both images | `docker/claude-executor/github-credential.cjs`, `gh-wrapper.sh`, `entrypoint.sh`, `docker/opencode-executor/entrypoint.sh` | `driver/test/github-credential.test.ts`, `driver/test/executor-images.test.ts` |
| The attempt pair on an adopted runner: the supervisor answers the lease it follows on `GET /attempt`; every helper (Jira helper, GitHub helper, branch reporter) reads it through `attempt-pair.cjs`, byte-identical in both images | `driver/src/scripts/supervisor.cjs` (`relayRequest`), `docker/claude-executor/control-proxy.cjs`, `docker/claude-executor/attempt-pair.cjs`, `driver/src/supervisor-contract.ts` (`SupervisorBinding.leaseToken`) | `driver/test/supervisor.test.ts`, `driver/test/attempt-pair.test.ts`, `driver/test/takeover-sim.test.ts` |
| Runner broker client: one wall-clock deadline, per-attempt per-key 0600 entries with expiry skew, typed stops (`INTEGRATION_REQUIRED` is exit 3), `connectionCredential(id)` as a library export only, and a `clear` that revokes the cached GitHub token through the revoke route; byte-identical in both images | `docker/claude-executor/credential-broker.cjs`, `docker/opencode-executor/credential-broker.cjs` | `driver/test/credential-broker.test.ts`, `driver/test/executor-images.test.ts` |
| The credential cache (`CREDENTIAL_CACHE_DIR`; memory-backed, agent container only) | `driver/src/claim.ts`, `driver/src/docker/docker.ts`, `driver/src/k8s/k8s-podspec.ts` | `driver/test/credential-broker.test.ts`, `driver/test/github-credential.test.ts` |
| GitHub, driver side: asked before the sync's fetch, each publish, each github-writing helper and each gate run | `driver/src/github-credential-call.ts`, `loop-github.ts`, `loop-gates.ts`, `gates.ts`, `k8s-gate.ts`, `supervised-steps.ts` | `driver/test/board.test.ts`, `driver/test/loop/`, `driver/test/gates.test.ts`, `driver/test/k8s/` |
| `GITHUB_TOKEN` and `GH_TOKEN` reserved env names | `core/src/env.ts`, `driver/src/claim.ts`, `driver/src/config.ts`, `server/migrations/072_github_env_reserved.sql` | `server/test/routes.env.test.ts`, `driver/test/config.test.ts`, `driver/test/executor-images.test.ts` |
| GitHub, the lanes (forced expiry, App-less refusal, Memory cache) | `server/src/offline-mint.ts`, `scripts/test-jobs.sh`, `scripts/test-k8s.sh`, `scripts/k8s-stub.sh` | `server/test/test-jobs.harness.test.ts`, `driver/test/lane-stubs.test.ts` |
| Portable integration layer: definition, closed outcomes, bounded operation runner; imports nothing from `server` | `core/src/integrations/`, `lint/no-cross-package-imports.grit` | `core/test/integrations.operation.test.ts`, `core/test/integrations.boundary.test.ts`, `server/test/integrations.contract.test.ts` |
| Jira adapter: the definition, four typed operations and the scope sets (core); the 3LO hooks (authorize URL, code and refresh exchange classified `definitive`/`ambiguous`/`not-sent`, accessible-resources and `/myself` discovery) registered when `ATLASSIAN_*` is set | `core/src/integrations/jira.ts`, `server/src/integrations/providers/jira.ts`, `server/src/main.ts` | `core/test/integrations.jira.test.ts`, `server/test/integrations.jira-hooks.test.ts`, `server/test/fake-atlassian.ts` |
| Grant lineage: one claim per grant, the exchange, identical-replay persistence, recovery by claim kind, destroy of a revoked secret; a holder that lost its claim drops its tokens unrevoked (only a revoked grant's late tokens are revoked) | `server/migrations/096_grant_lineage.sql`, `server/migrations/101_grant_finalized_claim.sql`, `server/src/integrations/grant-lineage.ts`, `server/src/integrations/grant-credentials.ts`, `server/src/integrations/oauth-provider.ts`, `server/src/db/connection-grants.ts` (`finalizeLineage`) | `server/test-db/integration-lineage.test.ts`, `server/test-db/connection-grants.test.ts`, `server/test-db/migration.096-grant-lineage.test.ts`, `server/test-db/migration.101-grant-finalized-claim.test.ts`, `server/test-db/connection-lock-order.test.ts` |
| Credential resolver, trusted context and the binding ceiling | `server/src/integrations/credential-resolver.ts`, `server/src/integrations/trusted-context.ts` | `server/test-db/integration-resolver.test.ts` |
| Authorization transaction: start (access, one named site, optional `jobId` stored as `bind_job_id`: a successful callback binds the connection to that task as the person who made it, a refusal still ends `connected`), callback validation, claim-before-exchange reconnect through the same activation as a connect (access follows the token's scope on every connection of the grant, new sites attach), secret-first new grant, recovery; served by `POST`/`GET /api/integrations/:provider/...` | `server/migrations/097_integration_authorization.sql`, `server/migrations/098_jira_oauth.sql`, `server/src/integrations/authorization-flow.ts`, `authorization-complete.ts`, `authorization-store.ts`, `server/src/routes/integrations.ts`, `server/src/db/connection-grants.ts` (`attachInTx`) | `server/test-db/integration-authorization.test.ts`, `server/test-db/jira-authorization.test.ts`, `server/test-db/jira-lineage.test.ts`, `server/test-db/migration.098-jira-oauth.test.ts`, `server/test/routes.integrations.test.ts` |
| Composition and recovery: one lineage and flow per org, a bounded pass on every replica (expired claims with or without a recorded operation, revoked grants' secrets, authorizations past their deadline), the destroy after a disconnect that revoked a grant | `server/src/integrations/integration-recovery.ts`, `server/src/main.ts`, `server/src/routes/connections.ts` | `server/test-db/integration-recovery.test.ts`, `server/test/routes.connections.test.ts` |

## Invariants

- **A runner never holds a Jira refresh secret or a stored credential.** It holds the attempt pair and asks the broker
  for an access token per call; revocation is a `DELETE` (a soft disconnect) the next ask sees.
  `server/test-db/connection-credential.test.ts`.
- **Every ask re-checks the live attempt**, with no tail grace: job unfinished, lease unexpired, no stop requested, not
  a reviewer row, and the root's execution user still a member. `server/test-db/connection-credential.test.ts`.
- **Selection is the root task's bindings, stamped at create**; follow-ups, retries and workflow nodes read the
  root's. A personal connection binds by default only when it is the lone candidate. A provider a selected skill requires with no live binding is an open requirement: the claim never
  offers the queued root and spends no attempt. `server/test-db/job-store.connection-bindings.test.ts`.
- **Bindings, requirements and grant revocation serialize on locks, never on a read**: every thread writer locks in one
  order: root rows (`for no key update`, ascending), PR lock, thread advisory lock, member rows, grant, connection; only
  the claim's acquire (root row and advisory lock tried) and a settle of its own running row are exempt; the runtime ask is
  one (its own running row, then the root row).
  Until the contract release `job.jira_connection_id` is a projection of the root's one live jira binding (null
  otherwise) for old pods. `server/src/db/connection-bindings.ts`, `server/test-db/connection-lock-order.test.ts`, `server/test-db/job-store.bind-lock-order.test.ts`.
- **A connection is its owner's alone, and only an OAuth one.** An admin has no more reach than a member, and a legacy
  API-token row is neither listed, bound nor served. `server/test-db/connection-store.test.ts`,
  `server/test/routes.connections.test.ts`.
- **A legacy connection never lends its identity to a task.** Migration 100 disconnects it, and a queued task bound to
  it waits as an open `jira` requirement until its member connects Jira and binds a connection
  (`POST /api/jobs/:id/connections`); a running one finds no connection and its helper stops with that guidance.
  `server/test-db/migration.100-legacy-jira-tokens.test.ts`.
- **GitHub's token is the attempt's, never the claim's.** No GitHub value rides the claim, the runner's env or
  Secret; a reviewer row and a superseded, cancelled or finished attempt get none.
  `server/test-db/github-credential.test.ts`, `driver/test/github-credential.test.ts`.
- **Post-agent driver phases (gates, post-helpers, publish) ask under the attempt's running lease, with no grace after
  settle; the agent's helper lives only in the agent container and ends with it, and aux containers carry no attempt
  pair.** `server/test-db/connection-credential.test.ts`, `server/test-db/github-credential.test.ts`,
  `driver/test/credential-broker.test.ts`.
- **Stated limit: a runner lost without SIGTERM never runs `clear`, so its GitHub token is usable until GitHub's own
  expiry (an hour at most).** `docker/claude-executor/entrypoint.sh`, `driver/test/credential-broker.test.ts`.
- **A reconnect claims the grant's lineage before it exchanges the code; a new grant's secret is created before
  its connection is visible.** The callback's return path is the one stored at start. `server/test-db/integration-authorization.test.ts`.
- **A recorded operation is released only after its ID is durably fenced at the store.** A `not-found` reconcile is
  "not yet": recovery first binds the ID to a delete at a never-active version, so a holder paused before its request
  is refused `operation-id-reused`. An unconfirmed fence leaves the row; a record is refused past the lease; a
  claim taken for an authorization expires at its `deadline_at`, and the authorization settles from that claim's
  durable outcome (`lineage_finalized_claim`). The abort timer and the per-instance attempt registry are
  mitigation only. `server/src/integrations/operation-fence.ts`, `server/test-db/integration-lineage.test.ts`,
  `server/test/integrations-replay.test.ts`.
- **A receipt is the thread root's and moves only through guarded statements: `started` was never dispatched, `dispatched` may have run, `unknown` is never replayed.** A reused key with another fingerprint or connection is `409 OPERATION_KEY_REUSED`; a throwing check is `503`, never a refusal. `server/src/db/operation-receipts.ts`, `server/test-db/operation-receipts.test.ts`.
- **An enumeration is a candidate list, never a verdict.** The pass acts only through each module's own guarded
  statements; a store that does not answer leaves the row for the next tick. `server/test-db/integration-recovery.test.ts`.

## Stated limits

- OAuth grants hold their secret in the SecretStore only; the legacy plaintext tokens are scrubbed by migration 100.
- The destroy after a disconnect is best effort and the answer stays 204; the background pass is its retry. Without
  `ATLASSIAN_CLIENT_ID`/`ATLASSIAN_CLIENT_SECRET` the runtime recovers rows and destroys secrets but starts no
  authorization (`docs/jira-app-runbook.md`).
- A wedged secret reference is permanent: an operation whose payload was lost blocks every later mutation on it, delete
  included. The grant moves to a fresh reference on reconnect and the old one stays encrypted at rest, uncollected.
- GitHub is the App's alone: no member token, no PAT; a revoked installation surfaces as the route's `502`.
- A gate run's GitHub token is asked at its start and never renewed during it: one gate running past
  its hour runs on an expired token. It rides that run's gate step, whose env the gate container
  exports for the run alone (`driver/src/gates.ts`, `driver/src/scripts/gate-loop.sh`). Its value is redacted
  from the gate's output before the supervisor keeps or returns it (`driver/src/scripts/supervisor.cjs`
  `redactedResult`, `driver/test/supervisor.test.ts`).
- The helper answers `https://github.com` only: an Enterprise `GITHUB_API_URL` deployment's agent runs git and
  gh without a credential.
- A transient relay failure on an adopted runner falls back to the env lease: that one call may be refused
  (`docker/claude-executor/attempt-pair.cjs`); the next re-reads the pair.
- A supervised step's token rides its step request, which crosses the mailbox volume, not memory.
- No in-place edit and no per-task picker in the UI: delete and re-add.
