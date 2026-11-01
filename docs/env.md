# Runner environment & secrets

Environment variables and secrets for runners, held by the board in three stacked scopes — org, workspace (a member's
own), repository — and injected into the runner at claim time. Name rules, the per-scope ceiling and the reserved-name
list live in `core/src/env.ts`; the driver keeps a deliberately narrower copy in `driver/src/claim.ts`.

| Concern | Code | Test |
| --- | --- | --- |
| Scopes, scope check, `stackEnv`, write-only secret echo | `server/src/db/env-var-store.ts`, `server/migrations/017_env_vars.sql` | `server/test-db/env-var-store.test.ts` |
| A secret's value in the store: reference, identity, batched fail-closed read | `server/src/db/env-secrets.ts`, `server/migrations/093_env_var_secret_ref.sql`, `server/migrations/113_env_var_secret_form.sql` | `server/test-db/migration.093-env-secret-ref.test.ts`, `server/test-db/migration.113-env-secret-form.test.ts`, `server/test-db/env-secrets.claim.test.ts` |
| PUT write path and compensation | `server/src/db/env-var-store.ts`, `server/src/db/env-secrets.ts` | `server/test-db/env-secrets.writes.test.ts` |
| Whole-list PUT, validation codes, reserved names | `server/src/routes/env.ts`, `core/src/env.ts` | `server/test/routes.env.test.ts` |
| Claim-time resolution (`withoutGithubToken`) | `server/src/db/jobs/job-store-claim.ts`, `server/src/db/jobs/job-store-claim-executor.ts` | `server/test/job-store.env.test.ts`, `server/test-db/job-store.attribution.test.ts` |
| `claimEnv`: the driver's filter and synthesized executor names | `driver/src/claim.ts` | `driver/test/docker/`, `driver/test/k8s/` |
| Docker: 0600 `--env-file` around the run | `driver/src/docker/docker.ts` | `driver/test/docker/` |
| Kubernetes: per-attempt Secret, `secretKeyRef` | `driver/src/k8s/k8s-podspec.ts` | `driver/test/k8s/` |
| Driver literals in every runner and gate env (`npmQuietEnv`, `repoCacheEnv`, `gateEnv`) | `driver/src/claim.ts`, `driver/src/runner-plan.ts`, `driver/src/docker/docker.ts`, `driver/src/k8s/k8s-podspec.ts` | `driver/test/runner-plan.test.ts` |
| GitHub names reserved in every scope; the token comes from the board ([connections.md](connections.md)) | `core/src/env.ts`, `server/migrations/072_github_env_reserved.sql` | `server/test/routes.env.test.ts` |
| Skill connections: env names checked by name, never as values | `core/src/skills.ts`, `server/src/db/jobs/job-store-claim.ts` | `core/test/skills.test.ts`, `server/test-db/job-store.skills.test.ts` |
| The three editors, drafts, `.env` disclosure, and where they mount | `web/src/panels/EnvVarsPanel.tsx`, `web/src/panels/env-vars-panel-parts.tsx`, `web/src/panels/env-draft.ts`, `web/src/panels/env-raw.ts`, `web/src/pages/SettingsOrganizationPage.tsx`, `web/src/pages/SettingsWorkspacePage.tsx`, `web/src/pages/SettingsRepositoriesPage.tsx` | `web/test/env-draft.test.ts`, `web/test/env-raw.test.ts`, `web/test/env.render.test.tsx`, `web/test/env.dom.test.tsx`, `e2e/env.spec.ts` |
| The vertical: PUT env, claim, runner, probe values in output | `scripts/test-jobs.sh` | — |
| The driver deletes every `SECRETS_*` at startup | `driver/src/strip-secret-store-env.ts`, `driver/src/index.ts` | `driver/test/strip-secret-store-env.test.ts` |

## Invariants

- **A secret's value lives in the secret store, not in `env_var`**: the row keeps `secret_ref` and `secret_version`
  with `value` null; a non-secret keeps its plaintext `value` with both null, in every scope. `env_var_secret_form_ck`
  admits only those two shapes. An inconclusive or failed read, a foreign version or non-UTF-8 bytes roll the claim
  back; a secret is never dropped. `server/test-db/env-var-store.test.ts`, `server/test-db/env-secrets.claim.test.ts`.
- **A PUT that does not commit deletes only what a fresh read of its own scope shows unreferenced**; an inconclusive
  read deletes nothing and reports `cleanup-failed`. `server/test-db/env-secrets.writes.test.ts`.
- **Migration 113 refuses while a plaintext secret row remains**; its message names the previous release's conversion
  command. `server/test-db/migration.113-env-secret-form.test.ts`.
- **A secret entry with `value: null` on a whole-list PUT survives untouched**; an omitted name deletes.
  `server/test/routes.env.test.ts`.
- **Precedence is org < workspace < repo** (`stackEnv`); against the driver's own `RUNNER_ENV` the claim wins.
- **No GitHub token rides the claim env**: refused at PUT, dropped at claim. `server/test/job-store.env.test.ts`.
- **The resolved env is never persisted on the job row**; a resolver failure rolls the claim back to 503 with the
  attempt unburned. `server/test-db/job-store.attribution.test.ts`.
- **Claim values never pass through the driver's own process environment**; the env file and the k8s Secret keep them
  out of argv. `driver/test/docker/`, `driver/test/k8s/`.

## Stated limits

- A stored record is orphaned when compensation is inconclusive, and unreported when a pod dies mid-PUT or an org or
  user is purged ([secrets.md](secrets.md)).
- An env-file line has no quoting: a value containing a newline is refused at PUT (`400 BAD_ENV_VALUE`) and at the driver.
- A driver that crashes before cleanup leaks its attempt's Secret (no TTL; label `factory.job`); the chart's Role grants
  `secrets: [create, delete]` only.
- `REPO`, `WORKTREE` and `BRANCH` are not reserved board-wide: a runner never sees them.
