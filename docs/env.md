# Runner environment & secrets

Environment variables and secrets for runners, held by the board in three stacked scopes — org,
workspace (a member's own), repository — and injected into the runner at claim time.

The name rules, the per-scope ceiling and the reserved-name list live in `core/src/env.ts`, which
both the route and the web editors render from. The driver keeps its own copy in
`driver/src/claim.ts`, deliberately narrower.

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| The three scopes, the scope check, `stackEnv`, the write-only secret echo | `server/src/db/env-var-store.ts`, `server/migrations/017_env_vars.sql` | `server/test-db/env-var-store.test.ts` |
| Where a secret's value lives: the row's reference, its identity, the batched fail-closed read | `server/src/db/env-secrets.ts`, `server/migrations/093_env_var_secret_ref.sql` | `server/test-db/env-var-store.test.ts`, `server/test-db/migration.093-env-secret-ref.test.ts`, `server/test-db/env-secrets.claim.test.ts` |
| The PUT's write path and its compensation: secrets through the store, creates reconciled or deleted when the PUT does not commit | `server/src/db/env-var-store.ts`, `server/src/db/env-secrets.ts` | `server/test-db/env-secrets.writes.test.ts` |
| Whole-list PUT, validation codes, reserved names | `server/src/routes/env.ts`, `core/src/env.ts` | `server/test/routes.env.test.ts` |
| Claim-time resolution, with `GITHUB_TOKEN`/`GH_TOKEN` dropped from it (`withoutGithubToken`) | `server/src/db/jobs/job-store-claim.ts`, `job-store-claim-executor.ts` | `server/test/job-store.env.test.ts`, `server/test-db/job-store.attribution.test.ts` |
| `claimEnv`: the driver's filter and the synthesized executor-config names | `driver/src/claim.ts` | `driver/test/docker/`, `k8s/` |
| Docker: a 0600 `--env-file` written and removed around the run | `driver/src/docker/docker.ts` | `driver/test/docker/` |
| Kubernetes: a per-attempt Secret, values in `stringData`, referenced by `secretKeyRef` | `driver/src/k8s/k8s-podspec.ts` | `driver/test/k8s/` |
| Driver literals in every runner and gate env, both executors: `npmQuietEnv` and `repoCacheEnv` (defaults a claim overrides), `gateEnv` | `driver/src/claim.ts`, `runner-plan.ts`, `docker.ts`, `k8s-podspec.ts` | `driver/test/docker/`, `k8s/`, `runner-plan.test.ts` |
| GitHub: `GITHUB_TOKEN` and `GH_TOKEN` are reserved names in every scope, stored rows deleted by `072_github_env_reserved.sql`; the runner's token comes from the board, see [connections.md](connections.md) | `core/src/env.ts`, `driver/src/claim.ts` | `server/test/routes.env.test.ts`, `server/test-db/env-var-store.test.ts` |
| Skill connections: an env connection needs its env names present in the resolved claim env, checked by name and never read as values; both shipped ones are managed — `jira` by the task's selection, `github` by the org's App installation (`githubApp`), which no env value satisfies | `core/src/skills.ts`, `server/src/db/jobs/job-store-claim.ts` | `core/test/skills.test.ts`, `server/test-db/job-store.skills.test.ts` |
| The three editors, their drafts, the `.env` disclosure | `web/src/panels/EnvVarsPanel.tsx`, `env-vars-panel-parts.tsx`, `env-draft.ts`, `env-raw.ts` | `web/test/env-draft.test.ts`, `env-raw.test.ts`, `env.render.test.tsx`, `env.dom.test.tsx`, `e2e/env.spec.ts` |
| Where the editors mount | `web/src/pages/SettingsOrganizationPage.tsx`, `SettingsWorkspacePage.tsx`, `SettingsRepositoriesPage.tsx` | `e2e/env.spec.ts` |
| The vertical: PUT core env → claim → runner → the probe values in the output | `scripts/test-jobs.sh` | — |
| The driver deletes every `SECRETS_*` variable at startup, so none is ever forwarded to a runner (the secret-store keys belong to the dashboard) | `driver/src/strip-secret-store-env.ts`, `driver/src/index.ts` | `driver/test/strip-secret-store-env.test.ts` |

## Invariants

- **A secret's value lives in the secret store, not in `env_var`**: every PUT writes each secret through the store, and the
  row keeps `secret_ref` and `secret_version` (`093_env_var_secret_ref.sql`) with `value` null. The identity is rebuilt
  from the row's slot on every read, so a copied reference is `identity-mismatch` (`server/src/db/env-secrets.ts`).
  **Only `is_secret` entries ever reach the store**: a non-secret row always keeps its plaintext `value` with `secret_ref`
  and `secret_version` null, in every scope (`server/test-db/env-secrets.writes.test.ts`). The claim reads both formats
  until the contract follow-up removes the plaintext one; a row that is neither, an inconclusive or failed read, a
  version other than the stored one, or bytes that are not UTF-8 throws and rolls the claim back, a secret is never
  dropped (`server/test-db/env-var-store.test.ts`, `server/test-db/env-secrets.claim.test.ts`). Old-format secrets stay
  plaintext until converted, and every list read nulls a secret's value in the SELECT.
- **A PUT that does not commit deletes only what a fresh read of its own scope shows unreferenced**, and every create that
  may have written is reconciled once; a changed value gets a new reference and the old one is deleted after the commit.
  An inconclusive read deletes nothing and reports the refs as `cleanup-failed` diagnostics (`server/src/main.ts`).
  `server/test-db/env-secrets.writes.test.ts`.
- **Old-format secrets move with one operator step**: run `npm run secrets:convert-env` (Kubernetes: `kubectl exec
  deploy/<release>-factory -c dashboard -- node server/dist/secrets/convert-env-cli.js`) after the v0.0.13 rollout
  completes, and rerun until it exits 0. It selects and updates `is_secret` rows only, never a non-secret row. Oversized
  rows are listed and must be re-entered by a member. A run killed mid-row leaves at most one unreferenced record, and
  the row stays plaintext (`server/src/db/env-secret-conversion.ts`, `server/test-db/env-secret-conversion.test.ts`).
- **A secret entry carrying `value: null` on a whole-list PUT SURVIVES untouched**; an omitted name
  deletes. This is the one exception to "the body is the whole truth", and it is why a non-secret
  may never carry a null value. Same test, plus `server/test/routes.env.test.ts`.
- **Precedence is org < workspace < repo, most specific wins** — `stackEnv`, exported and pinned by
  the offline suite so the rule does not live only where a database is.
- **No GitHub token rides the claim env**: the names are refused at PUT and dropped at claim
  (`withoutGithubToken`, `server/test/job-store.env.test.ts`). Against the driver's own `RUNNER_ENV`
  a collision runs the claim's way — the claim always wins.
- **The resolved env is never persisted on the job row**, which `GET /api/jobs/:id` serves to every
  member. A resolver failure rolls the claim back to 503 with the attempt unburned, so a job is never
  handed out with half an environment (`server/test-db/job-store.attribution.test.ts`).
- **Claim values never pass through the driver's own process environment.** The names are
  member-controlled, so a `PATH` or `DOCKER_HOST` on the docker CLI's own argv would be host code
  execution; the env file and the k8s Secret are what keep them out of argv entirely.

## Stated limits

- A stored record is orphaned when compensation is inconclusive (reported as `cleanup-failed` with its ref), and
  unreported when a pod dies mid-PUT or an org or user is purged (`docs/secrets.md`). The future sweep selects `secret`
  records of purpose `environment-secret` that no `env_var.secret_ref` names, grouped by the identity's org or user.
- An env-file line has no quoting, so a value containing a newline is refused at PUT
  (`400 BAD_ENV_VALUE`) and again at the driver.
- A driver that crashes before cleanup leaks its attempt's Secret — Secrets carry no TTL; the
  `factory.job: <id>` label is what a cleanup job would select. The chart's Role grants
  `secrets: [create, delete]` only, never `get` or `list`.
- `REPO`, `WORKTREE` and `BRANCH` belong to the startup sync's container and are deliberately NOT
  reserved board-wide: a runner never sees them.
