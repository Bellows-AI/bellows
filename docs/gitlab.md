# GitLab

How an org reaches a self-hosted GitLab: an admin connects an instance, stored pending until a later step activates it
(the admin's OAuth grant and the `/version` check; member grants, tracking and the start gate follow). Nothing gates on a
connection yet, and `site/` does not document it until it is usable.

| Concern | Code | Test |
| --- | --- | --- |
| The connection row: host, OAuth application client id, allowed root groups, `active`, the probe outcome; unique per org and host, with the org policy | `server/migrations/170_forge_connection.sql`, `server/src/db/org-tables.ts` | `server/test-db/gitlab-connection.test.ts`, `server/test-db/org-tables.test.ts` |
| The store: probe, then the secrets, then the row; delete tombstones the row (`removed_at`), retires both secrets, and drops the row only once the store confirmed; unconfirmed is a 503 | `server/src/db/forge-connections.ts`, `server/src/orgs.ts` | `server/test-db/gitlab-connection.test.ts` |
| Client secret and CA bundle in the secret store (purpose `forge-connection`, identity bound to the connection and part) | `server/src/db/forge-connections.ts` (`gitlabConnectionIdentity`), `server/src/secrets/secret-store.ts`, `server/src/db/org-purge.ts` | `server/test-db/gitlab-connection.test.ts`, `server/test-db/org-purge.test.ts` |
| The recovery sweep on every replica (cross-org pool) finishes a tombstoned removal | `server/src/db/forge-connection-sweep.ts`, `server/src/db/forge-connections.ts` (`sweepRemovedConnections`), `server/src/main.ts` | `server/test-db/gitlab-connection.test.ts`, `server/test/cross-org-pool.test.ts` |
| The unauthenticated, bounded, CA-aware reachability probe of `/api/v4/version` | `server/src/gitlab/gitlab-api.ts` | `server/test/gitlab-api.test.ts` |
| Admin routes: `GET`/`POST /api/org/gitlab-connections`, `GET`/`DELETE .../:id` (400 `INVALID_GITLAB_CONNECTION`, 409 `GITLAB_CONNECTION_EXISTS`) | `server/src/routes/gitlab-connections.ts`, `server/src/auth/route-class.ts`, `core/src/error-codes.ts` | `server/test-db/gitlab-connection.test.ts`, `server/test/auth.route-class.test.ts` |
| The instance the probe reaches in tests | `scripts/fake-forge/gitlab.mjs`, `server/test-db/fake-gitlab.ts` | `server/test/fake-gitlab.test.ts` |

## Invariants

- **A probe never refuses or deletes a connection**: a timeout, 5xx, malformed answer or TLS failure is recorded as the reason on a pending row; only a secret-store failure writes nothing (503). An anonymous 401 JSON answer is reachable. `server/test-db/gitlab-connection.test.ts`.
- **The host is unique per org, not globally**: two orgs may connect one instance with different applications. `server/test-db/gitlab-connection.test.ts`.
- **No view, row dump or export carries a secret**: the row holds references, the views only `hasCaBundle`. `server/test-db/org-export.test.ts`.

- **A removal is durable and an unconfirmed delete is not a success**: the tombstone outlives a failed or interrupted secret delete until the store confirms, the host can be connected again meanwhile, and a failed create or insert leaves no secret. `server/test-db/gitlab-connection.test.ts`.

## Stated limits

- The probe is `https` always; the board does not restrict which host an admin names (admin-only, no credential is sent).
