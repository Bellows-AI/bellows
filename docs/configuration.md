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
| The credential-free entry point | `server/src/offline.ts` | `server/test/routes.repos.test.ts` |
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
- **`GITHUB_API_URL` and `GITHUB_OAUTH_*_URL` are test seams, undocumented on purpose**; `server/src/main.ts`
  warns when the API URL is not `api.github.com`, and `playwright.config.ts` points them at `e2e/stub-idp.mjs`.
- **Never log the merged environment** — it holds the App private key. `driver/test/loop.test.ts` pins the
  driver's side.

## Stated limits

- There is no repo list to configure: `AppConfig` has no `repos` ([repos.md](repos.md)).
