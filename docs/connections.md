# Managed connections

Which external services a task may use and as whom: an authorized connection the board owns and spends on
the runner's behalf, selected per task — and GitHub, whose token the board mints for each attempt from the App.

Over the 60-line cap on purpose: four independent surfaces (connection store, Jira OAuth, the broker, GitHub).

| Concern | Code | Test |
| --- | --- | --- |
| Connection table, the member's own OAuth rows, list and disconnect | `server/migrations/054_connections.sql`, `server/migrations/094_integration_connections.sql`, `server/src/db/connection-store.ts`, `server/src/routes/connections.ts` | `server/test-db/connection-store.test.ts`, `server/test/routes.connections.test.ts` |
| Task selection: `connections` on create and follow-up, the owner's `POST /api/jobs/:id/connections` | `server/src/routes/connections.ts` (`parseConnectionIds`), `server/src/db/connection-bindings.ts`, `server/src/db/jobs/job-store-actions.ts` | `server/test/routes.jobs-connections.test.ts`, `server/test-db/job-store.connection-bindings.test.ts` |
| Runtime requirement wait: the ask names a `target`, the claim gate holds it, the owner binds or dismisses | `server/src/db/connection-bindings.ts` (`requireAtRuntimeInTx`), `server/src/db/jobs/job-store-connections.ts`, `server/migrations/108_runtime_requirements.sql`, `server/migrations/109_requirement_hand_back.sql`, `server/migrations/110_requirement_target.sql`, `server/src/integrations/credential-resolver.ts` (`bindingStanding`) | `server/test-db/job-store.runtime-requirement.test.ts`, `server/test-db/migration.108-runtime-requirements.test.ts` |
| The runner's ask (`connection-ask.cjs` posts `/connection` on the control socket; the Jira helper exits 3) | `docker/executor-common/connection-ask.cjs`, `docker/executor-common/control-proxy.cjs`, `docker/skills/jira/jira.cjs`, `driver/src/connection-control.ts` | `driver/test/connection-ask.test.ts`, `driver/test/jira-helper.test.ts`, `connection_roundtrip_lane` in `scripts/test-jobs.sh` |
| Settings → Integrations: connected cards (`needsReconnect` from the grant), the catalog, a connection's page with reconnect, write consent and disconnect; Workspace has no Jira panel | `web/src/pages/SettingsIntegrationsPage.tsx`, `web/src/pages/SettingsIntegrationsCatalogPage.tsx`, `web/src/pages/SettingsIntegrationDetailPage.tsx`, `web/src/panels/JiraConnectionActions.tsx`, `web/src/components/JiraConnectionDialog.tsx`, `web/src/components/JiraWriteConsentDialog.tsx`, `web/src/components/ConnectionDisconnectDialog.tsx`, `web/src/api/connections.ts`, `web/src/api/useConnections.ts`, `web/src/settings/integration-providers.ts`, `core/src/integration-catalog.ts` (the provider list web and `GET /api/integrations/catalog` share) | `web/test/integrations-overview.dom.test.tsx`, `web/test/integrations-catalog.dom.test.tsx`, `web/test/integration-detail.dom.test.tsx`, `web/test/integrations-state-matrix.dom.test.tsx`, `e2e/jira-connections.spec.ts`, `e2e/integrations.spec.ts` |
| Configuration read (`GET /api/integrations`, booleans only; Jira needs its client and a callback origin); a failed read is could-not-check, never not configured | `server/src/routes/integrations.ts`, `server/src/integrations/providers/jira.ts`, `web/src/api/useIntegrationConfig.ts` | `server/test/routes.integrations.test.ts`, `server/test/integrations.jira-hooks.test.ts`, `web/test/integrations-catalog.dom.test.tsx` |
| Operator's Atlassian app registration | [jira-app-runbook.md](jira-app-runbook.md) | `server/test/config.integrations.test.ts` |
| CLI: `connection list`, `job create --connection`, `job preflight` | `cli/src/run.ts`, `cli/src/selection.ts`, `cli/src/diagnostics.ts`, `cli/src/board.ts` | `cli/test/discovery.test.ts`, `cli/test/diagnostics.test.ts` |
| Legacy API-token connections: disconnected, scrubbed, unbound | `server/migrations/100_legacy_jira_tokens.sql`, `server/src/db/connection-bindings.ts` | `server/test-db/migration.100-legacy-jira-tokens.test.ts` |
| Credential class: the attempt pair in every `AUTH_MODE` | `server/src/auth/plugin.ts` (`CONNECTOR_ROUTES`) | `server/test/auth.enforcement.test.ts` |
| Agent's Jira skill and helper; runner entrypoints drop a claimed `JIRA_API` | `docker/skills/jira/SKILL.md`, `docker/skills/jira/jira.cjs`, `docker/claude-executor/entrypoint.sh`, `docker/opencode-executor/entrypoint.sh` | `driver/test/jira-helper.test.ts`, `server/test/jira-helper-parity.test.ts`, `driver/test/skill-helper-paths.test.ts`, `driver/test/executor-images.test.ts` |
| Broker routes: GitHub token, revoke, connection credential (attempt pair only, `no-store`) | `server/src/routes/github-credential.ts`, `server/src/routes/connection-credential.ts`, `server/src/db/attempt-of-lease.ts`, `server/migrations/121_job_prior_lease.sql`, `server/src/integrations/integration-recovery.ts` (`resolverOf`) | `server/test/routes.github-credential.test.ts`, `server/test/routes.connection-credential.test.ts`, `server/test-db/github-credential.test.ts`, `server/test-db/connection-credential.test.ts` |
| Runner seam: live bindings read and the operation receipt | `server/src/routes/operation-receipts.ts`, `server/src/db/operation-receipts.ts`, `server/migrations/099_operation_receipts.sql` | `server/test/routes.operation-receipts.test.ts`, `server/test-db/operation-receipts.test.ts`, `server/test-db/migration.099-operation-receipts.test.ts` |
| The agent's own task title (`POST /api/jobs/:id/agent-title`) and its runner helper | `server/src/routes/agent-title.ts`, `server/src/db/agent-title.ts`, `docker/skills/task-title/task-title.cjs`, `scripts/k8s-stub.sh` | `server/test/routes.agent-title.test.ts`, `server/test-db/agent-title.test.ts`, `driver/test/task-title-helper.test.ts`, `scripts/test-jobs.sh` (`task_title_lane`), `scripts/test-k8s.sh` (`# task title`) |
| After a successful Jira issue read the agent sets the task title from the ticket's subject (never on a failed read, never renames the issue) | `docker/skills/jira/SKILL.md`, `docker/skills/task-title/SKILL.md` | `driver/test/executor-images.test.ts`, `scripts/test-jobs.sh` (`connection_roundtrip_lane`) |
| GitHub mint: narrowed to the task's repo and `RUNNER_TOKEN_PERMISSIONS`, answer checked against that ceiling | `server/src/github/app-token.ts` | `server/test/github.app-token.test.ts` |
| Runner broker client (byte-identical in both images) and the GitHub helper behind `credential.helper` and `gh` | `docker/executor-common/credential-broker.cjs`, `docker/executor-common/github-credential.cjs`, `docker/executor-common/gh-wrapper.sh` | `driver/test/credential-broker.test.ts`, `driver/test/github-credential.test.ts`, `driver/test/executor-images.test.ts` |
| Attempt pair on an adopted runner, and the credential cache (`CREDENTIAL_CACHE_DIR`) | `driver/src/scripts/supervisor.cjs` (`relayRequest`), `docker/executor-common/attempt-pair.cjs`, `driver/src/claim.ts`, `driver/src/docker/docker.ts`, `driver/src/k8s/k8s-podspec.ts` | `driver/test/supervisor.test.ts`, `driver/test/attempt-pair.test.ts`, `driver/test/takeover-sim.test.ts` |
| GitHub, driver side: asked before the sync fetch, each publish and github-writing helper | `driver/src/github-credential-call.ts`, `driver/src/loop/loop-github.ts`, `driver/src/loop/loop-gates.ts`, `driver/src/gates.ts`, `driver/src/k8s/k8s-gate.ts`, `driver/src/supervised-steps.ts` | `driver/test/board.test.ts`, `driver/test/gates.test.ts`, `driver/test/loop/`, `driver/test/k8s/` |
| Gate asks: a gate's git and `gh` get a token through the gate mailbox (helper, shim, supervisor relay, driver route) | `driver/src/scripts/gate-github.sh`, `gate-loop.sh`, `gate-shell.sh`, `driver/src/scripts/supervisor.cjs` (`serveGateAsks`), `driver/src/gate-token-control.ts`, `driver/src/loop/loop-github.ts` | `driver/test/supervisor-gate-token.test.ts`, `driver/test/scripts-gate-github.test.ts`, `driver/test/scripts-gate-shell.test.ts`, `driver/test/supervisor.test.ts`, `driver/test/gate-token-control.test.ts` |
| `GITHUB_TOKEN`/`GH_TOKEN` reserved env names | `core/src/env.ts`, `driver/src/claim.ts`, `driver/src/config.ts`, `server/migrations/072_github_env_reserved.sql` | `server/test/routes.env.test.ts`, `driver/test/config.test.ts` |
| GitHub lanes (forced expiry, App-less refusal) | `server/src/offline-mint.ts`, `scripts/test-jobs.sh`, `scripts/test-k8s.sh`, `scripts/k8s-stub.sh` | `server/test/test-jobs.harness.test.ts`, `driver/test/lane-stubs.test.ts` |
| Integration layer (imports nothing from `server`) and the Jira adapter | `core/src/integrations/`, `core/src/integrations/jira.ts`, `server/src/integrations/providers/jira.ts`, `lint/no-cross-package-imports.grit` | `core/test/integrations.operation.test.ts`, `core/test/integrations.boundary.test.ts`, `core/test/integrations.jira.test.ts`, `server/test/integrations.contract.test.ts`, `server/test/integrations.jira-hooks.test.ts` |
| Grant lineage: one claim per grant, exchange, replay, recovery | `server/migrations/096_grant_lineage.sql`, `server/migrations/101_grant_finalized_claim.sql`, `server/src/integrations/grant-lineage.ts`, `server/src/integrations/grant-credentials.ts`, `server/src/integrations/oauth-provider.ts`, `server/src/db/connection-grants.ts` | `server/test-db/integration-lineage.test.ts`, `server/test-db/connection-grants.test.ts`, `server/test-db/connection-lock-order.test.ts` |
| Credential resolver, trusted context, binding ceiling | `server/src/integrations/credential-resolver.ts`, `server/src/integrations/trusted-context.ts` | `server/test-db/integration-resolver.test.ts` |
| Authorization start, callback, reconnect (`POST`/`GET /api/integrations/:provider/...`); a callback with no stored destination returns to `/settings/integrations` | `server/migrations/097_integration_authorization.sql`, `server/migrations/098_jira_oauth.sql`, `server/src/integrations/authorization-flow.ts`, `server/src/integrations/authorization-complete.ts`, `server/src/integrations/authorization-store.ts`, `server/src/routes/integrations.ts` | `server/test-db/integration-authorization.test.ts`, `server/test-db/jira-authorization.test.ts`, `server/test/routes.integrations.test.ts` |
| Recovery pass on every replica | `server/src/integrations/integration-recovery.ts`, `server/src/main.ts` | `server/test-db/integration-recovery.test.ts` |

## Invariants

- **A runner never holds a Jira refresh secret or a stored credential**; it holds the attempt pair and asks the broker
  per call. `server/test-db/connection-credential.test.ts`.
- **Every ask re-checks the live attempt**, no tail grace: unfinished job, unexpired lease, no stop, not a reviewer
  row, root's execution user still a member. `server/test-db/connection-credential.test.ts`. A lapsed lease, or the
  pair one claim back, on a task that still runs answers `503 LEASE_PENDING`, never the terminal 403: a takeover
  window, not a verdict (`server/test-db/github-credential.test.ts`).
- **Selection is the root task's bindings, stamped at create**; follow-ups, retries and workflow nodes read the root's.
  A required provider with no live binding is an open requirement: the claim never offers the queued root.
  `server/test-db/job-store.connection-bindings.test.ts`.
- **Bindings, requirements and grant revocation serialize on locks in one order**, documented at
  `server/src/db/connection-bindings.ts`, guarded by `server/test-db/connection-lock-order.test.ts` and
  `server/test-db/job-store.bind-lock-order.test.ts`.
- **A connection is its owner's alone, and only an OAuth one**; an admin has no more reach, and a legacy API-token row is
  never listed, bound or served. `server/test-db/connection-store.test.ts`, `server/test/routes.connections.test.ts`.
- **GitHub's token is the attempt's, never the claim's**: no GitHub value rides the claim, env or Secret.
  `server/test-db/github-credential.test.ts`, `driver/test/github-credential.test.ts`.
- **Post-agent driver phases ask under the attempt's running lease, no grace after settle**; aux containers carry no
  attempt pair. `driver/test/credential-broker.test.ts`.
- **A reconnect claims the grant's lineage before it exchanges the code; a new grant's secret exists before its
  connection is visible.** `server/test-db/integration-authorization.test.ts`.
- **A recorded operation is released only after its ID is durably fenced at the store**; an unconfirmed fence leaves the
  row. `server/src/integrations/operation-fence.ts`, `server/test/integrations-replay.test.ts`.
- **A receipt is the thread root's**; `unknown` is never replayed; a reused key with another fingerprint is
  `409 OPERATION_KEY_REUSED`. `server/test-db/operation-receipts.test.ts`.
- **A title write never touches the provider**, never replaces a `user` title, and is re-checked under the caller's own
  row lock and the root's; an unconfirmed read is `503`, never "unchanged". `server/test-db/agent-title.test.ts`.
- **An enumeration is a candidate list, never a verdict**: a store that does not answer leaves the row for the next
  tick. `server/test-db/integration-recovery.test.ts`.
- A gate asks through its mailbox, answered only while its step runs under the live lease; an unanswered ask is no verdict, never an empty token.

## Stated limits

- OAuth grants hold their secret in the SecretStore only ([secrets.md](secrets.md)).
- A wedged secret reference is permanent: the grant moves to a fresh reference on reconnect, the old one stays uncollected.
- GitHub is the App's alone: no member token, no PAT. The helper answers `https://github.com` only.
- A runner lost without SIGTERM never runs `clear`: its GitHub token lives until GitHub's own expiry (an hour at most).
- A gate gets no `GITHUB_TOKEN`/`GH_TOKEN` in its env: git and gh get a token through the gate helper, and a gate script reading `$GITHUB_TOKEN` itself gets nothing.
- A gate image without `chmod` gets no `gh` shim, and one with git older than 2.31 gets no credential helper: both run tokenless.
- A supervised step's token rides its step request across the mailbox volume, not memory.
- The token reaches every site the Atlassian account can reach; there is no in-place edit and no per-task picker in the UI.
- Only the pair one claim back is pending: after two takeovers before the relay, the oldest pair is refused
  (`server/test-db/github-credential.test.ts`).
