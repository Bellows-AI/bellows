# Configuration

One source of configuration: environment variables (`.env` via `--env-file-if-exists`, compose, or
the shell). `.env.example` is the list; `server/src/config.ts` is the contract.

| Concern | Code | Test |
| --- | --- | --- |
| `loadConfig` purity, auth variables, the `AuthConfig` union | `server/src/config.ts` | `server/test/config.auth.test.ts` |
| App id, key, `_FILE`/base64, API host, webhook secret | `server/src/config.ts`, `server/src/github/app-token.ts` | `server/test/config.github.test.ts` |
| Retired variables that are fatal | `server/src/config.ts` | `server/test/config.persistence.test.ts`, `server/test/config.org.test.ts` |
| `DATABASE_URL`, disposable-database refusal | `server/src/config.ts` | `server/test/config.persistence.test.ts` |
| `ORG_WORKSPACE_ROOT` | `server/src/config.ts` | `server/test/config.workspace.test.ts` |
| `ARTIFACTS_BACKEND` (`s3`, or `filesystem` by default), `ARTIFACTS_FS_ROOT`, `ARTIFACTS_S3_{BUCKET,REGION,ENDPOINT,FORCE_PATH_STYLE,PREFIX,KMS_KEY_ID}`, `ARTIFACTS_ACCESS_KEY_ID` / `ARTIFACTS_SECRET_ACCESS_KEY`, `ARTIFACTS_RETENTION_DAYS`, `ARTIFACTS_ORG_QUOTA_BYTES`; the chart's `artifacts:` values render to them | `server/src/artifacts/config.ts`, `charts/factory/values.yaml`, `charts/factory/templates/deployment.yaml` | `server/test/artifacts.unit.test.ts`, `scripts/test-k8s.sh` |
| S3 credentials: static keys, then EKS Pod Identity, then IRSA; the dashboard's own ServiceAccount carries the role | `server/src/artifacts/s3-credentials.ts`, `charts/factory/templates/dashboard-serviceaccount.yaml` | `server/test/artifacts.unit.test.ts`, `scripts/test-k8s.sh` |
| Object store backends (S3 over a minimal SigV4 client, filesystem), bucket created on boot; compose's `s3` service (RustFS) is the dev store | `server/src/artifacts/s3-store.ts`, `fs-store.ts`, `backend.ts`, `docker-compose.yml` | `server/test/artifacts.object-store.test.ts` |
| The credential-free entry point | `server/src/offline.ts` | `server/test/routes.repos.test.ts` |
| Its claim-time plan: bare mirrors under `<ORG_WORKSPACE_ROOT>/.origins/<owner>/<name>.git`; an unmirrored repo carries no plan | `server/src/github/local-origin-plan.ts`, `server/src/orgs.ts`, `scripts/test-jobs.sh` | `server/test/local-origin-plan.test.ts`, `server/test/test-jobs.harness.test.ts` |
| CLI `FACTORY_*` variables over `~/.bellows/settings.json` or `--config <path>`; a settings file holding a token readable beyond `0600` is refused; a `FACTORY_URL` carrying `user:password@` is refused without echoing it | `cli/src/config.ts` | `cli/test/config.test.ts` |

## Invariants

- **`loadConfig` does no I/O**: `GITHUB_APP_PRIVATE_KEY_FILE` is read in `resolveConfig`, `~` expands against
  `env.HOME`, and `createPrivateKey()` runs at provider construction, so an unusable key is fatal at boot.
  `server/src/config.ts`, `server/src/github/app-token.ts`.
- **An unknown variable is ignored, except named retired ones, which are fatal** and name their replacement.
  `server/test/config.persistence.test.ts`.
- **`DATABASE_URL`, `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are required; no variable turns fetching off.**
  Credential-free tooling says so in code: `server/dist/offline.js`, or the `none` arm of `GitHubConfig`.
- **A fetching process refuses a disposable database** (`_test`, `_seed`, `_synthetic`, `_demo`, `_e2e`); the
  `none` arm is exempt, which is how seed and `verify:ui` run. `server/test/config.persistence.test.ts`.
- **`AUTH_MODE` is an explicit enum and `AuthConfig` a discriminated union** — never inferred from a client id
  ([auth.md](auth.md)). `server/test/config.auth.test.ts`.
- **A secret under 32 characters refuses to boot** (`SESSION_SECRET`, `GITHUB_WEBHOOK_SECRET`); unset,
  `GITHUB_WEBHOOK_SECRET` does not register the route.
- **Both artifact backends pass one contract** (create-only writes, a 412 that never overwrites, idempotent delete);
  the filesystem backend is single replica only, and an S3-compatible endpoint is sent no SSE-S3 header.
  `server/test/artifacts.object-store.test.ts`.
- **`GITHUB_API_URL` and `GITHUB_OAUTH_*_URL` are test seams, undocumented on purpose**; `server/src/main.ts`
  warns when the API URL is not `api.github.com`, and `playwright.config.ts` points them at `e2e/stub-idp.mjs`.
- **Never log the merged environment** — it holds the App private key. `driver/test/loop.test.ts` pins the
  driver's side.

## Stated limits

- There is no repo list to configure: `AppConfig` has no `repos` ([repos.md](repos.md)).
