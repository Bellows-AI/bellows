# Authentication

Who a caller is, and which credential each route accepts.

| Concern | Code | Test |
| --- | --- | --- |
| Route credentials, chosen from the matched route pattern (`requirementOf`); question reports accept workers, answers require members; a credential lookup the database cannot answer is a 503 | `server/src/auth/plugin.ts` | `server/test/auth.enforcement.test.ts`, `server/test/auth.route-match.test.ts`, `server/test/auth.tokens.test.ts` |
| `AUTH_MODE`, its boot refusals, `AUTH_ALLOW_PUBLIC_BIND` | `server/src/config.ts` | `server/test/config.auth.test.ts` |
| Session cookie: signing, flags, expiry | `server/src/auth/session.ts` | `server/test/auth.session.test.ts` |
| OAuth round trip, state, redirect validation, `/me` (a present bearer is its credential — the CLI's `auth status`) | `server/src/routes/auth.ts`, `server/src/routes/auth-shared.ts`, `server/src/auth/github.ts` | `server/test/auth.oauth.sign-in.test.ts`, `server/test/auth.oauth.me.test.ts`, `server/test/auth.github-client.test.ts`, `server/test/auth.tokens.test.ts` |
| Installation-selection screen, pending sign-in, repo scope | `server/src/routes/auth-onboarding.ts` | `server/test/auth.completion.test.ts` |
| Accounts, sessions, memberships, roles (SQL) | `server/src/auth/store.ts`, `server/migrations/010_auth.sql` | `server/test-db/auth-store.test.ts` |
| Personal (`fat_`) and org (`oat_`) access tokens | `server/src/auth/access-token.ts`, `server/src/routes/tokens.ts` | `server/test/auth.tokens.test.ts`, `server/test-db/auth-store.access-tokens.test.ts` |
| MCP OAuth storage: clients (CIMD, DCR), codes, grant families, `mat_`/`mrt_` tokens, consent transaction | `server/src/auth/oauth-store.ts`, `server/src/auth/access-token.ts`, `server/migrations/122_oauth.sql` | `server/test-db/auth-store.oauth-codes.test.ts`, `server/test-db/auth-store.oauth-tokens.test.ts`, `server/test-db/auth-store.oauth-consent.test.ts`, `server/test-db/auth-store.oauth-concurrency.test.ts` |
| MCP OAuth authorization server (only with `MCP_ENABLED` in github mode): discovery metadata, `/api/oauth/authorize`, `/token`, `/revoke`, the consent transaction API (`/api/oauth/consent/*`), the redirect-URI rule, the expiry sweep | `server/src/routes/oauth*.ts`, `server/src/oauth/redirect-match.ts`, `server/src/auth/oauth-sweep.ts` | `server/test/routes.oauth-metadata.test.ts`, `server/test/oauth.redirect-match.test.ts`, `server/test-db/routes.oauth-*.test.ts`, `server/test-db/oauth.sdk-flow.test.ts`, `server/test-db/auth-store.oauth-purge.test.ts` |
| Route classes (read / write per method + pattern), `Caller.scopes`, the bridged-caller binding, the `WWW-Authenticate` challenge | `server/src/auth/route-class.ts`, `server/src/auth/bridge-binding.ts`, `server/src/auth/oauth-challenge.ts`, `server/src/auth/plugin.ts` (`scopeAllows`) | `server/test/auth.enforcement.test.ts` ("has a row for every route"), `server/test/auth.route-class.test.ts` |
| Roster reads and role writes | `server/src/routes/org-members.ts` | `server/test/routes.org-members.test.ts` |
| Commerce plan push: `commerce` requirement, bearer `COMMERCE_TOKEN`, enforced in both `AUTH_MODE`s (`enforceCommerce`; [commerce.md](commerce.md)) | `server/src/auth/plugin.ts` | `server/test/auth.enforcement.test.ts`, `server/test/routes.commerce.test.ts` |
| GitHub-side removal, signed webhook | `server/src/routes/webhook.ts` | `server/test/webhook.test.ts` |
| Sign-in in a real browser | `e2e/auth.spec.ts`, `e2e/stub-idp.mjs`, `e2e/signin.ts` | the `auth` Playwright project (`playwright.config.ts`) |

See also [organizations.md](organizations.md), [configuration.md](configuration.md), [security.md](security.md), [api.md](api.md).

## Invariants

- **Installation access IS membership.** `signIn` upserts one `organization` and `org_membership` per SELECTED
  installation and deletes memberships outside it; no invite, no auto-join. `server/src/auth/store.ts`,
  `server/test-db/auth-store.test.ts`.
- **Every credential's reach is a live `org_membership` join** (`findSession`, `findPersonalToken`,
  `findOrgToken`), so a removed membership ends sessions and both token kinds on the next request.
  `server/test-db/auth-store.access-tokens.test.ts`.
- **An org's first membership lands `admin`**; demoting the last admin is `409 LAST_ADMIN`.
  `server/test/routes.org-members.test.ts`.
- **Only the sha-256 is stored** (sessions, both token kinds, the pending sign-in row), and the cookie is
  `SameSite=Lax`: the callback is a cross-site top-level GET. `server/src/auth/session.ts`,
  `server/test/auth.session.test.ts`.
- **The credential class is the matched route's, never a re-parse of the URL.** Every worker and connector pattern names its row `:id`. `server/src/auth/plugin.ts`, `server/test/auth.route-match.test.ts`.
- **Four credential kinds, one per request, no fall-through.** A bearer on a session route wins over the
  cookie; a worker token is refused on human routes and vice versa; an `oat_` reaches only `ORG_TOKEN_ROUTES`
  and is `403` off it; a `mat_` is `401` on every route but `/api/mcp` and never falls back to a cookie
  (`isAccessToken` does not match it). `server/src/auth/plugin.ts`, `server/test/auth.enforcement.test.ts`.
- **A bridged caller exists only as a symbol on an injected request class.** It beats the cookie and the bearer, is
  checked against its route class (`403 insufficient_scope` plus a `WWW-Authenticate` challenge; an unclassified route
  is refused; credential, secret, connection and membership routes are class `none`, refused whatever the scopes; a
  bound caller on a non-human route is refused), and no header, query or body can create one. A new human route needs a `ROUTE_CLASSES` row. The one exception to "human routes only" is `BRIDGE_OPEN_ROUTES` (`bridgeOpen`: `GET /api/auth/me`, `GET /api/version`), which the `whoami` tool reads; every other open route is refused.
  `server/src/auth/bridge-binding.ts`, `server/test/auth.enforcement.test.ts`, `server/test/auth.route-class.test.ts`, `server/test/auth.me-bridged.test.ts`.
- **The OAuth server is S256-only and public-client-only.** `plain` or a missing challenge is refused at authorize
  (the store has no method column); the token endpoint takes a form or JSON body, and the form parser exists in that
  one plugin scope so no other route accepts a form post. A redirect URI matches a registered one exactly, except an
  RFC 8252 section 7.3 loopback URI (`http` on `127.0.0.1`, `[::1]` or `localhost`) where only the port may differ;
  that portless registration is a deliberate non-conformance with exact matching. An unknown client or redirect is
  shown, never redirected. `server/src/oauth/redirect-match.ts`, `server/test/oauth.redirect-match.test.ts`.
- **Consent is the cookie session and nothing else.** Approve and deny need the signed-in session, the transaction id
  and its CSRF value (carried once, in the fragment of the redirect to `/oauth/consent`), a JSON body, and read nothing
  else: scopes, redirect, resource and client were frozen at authorize, user and organization come from the live session.
  A `mat_` or `fat_` never approves its own grant. `server/test-db/routes.oauth-consent.test.ts`.
- **A refresh narrows against the presented token's scopes**, not the family's: once narrowed, a grant cannot widen
  back. A store call that throws on the token, revoke or authorize path is `503`, never `invalid_grant`.
  `server/test-db/routes.oauth-token.test.ts`.
- **An MCP token is never logged.** Redaction is by value, so the guarantee is that no log line carries the
  `Authorization` header. `server/test/auth.enforcement.test.ts`.
- **`AUTH_MODE=none` synthesises a caller rather than skipping the hook**; it refuses a non-loopback `HOST`
  unless `AUTH_ALLOW_PUBLIC_BIND=1`, and `docker-compose.yml` pins `github`. `server/src/config.ts`,
  `server/src/db/migrate.ts` (`LOCAL_LOGIN`), `server/test/config.auth.test.ts`.
- **An idempotency key is scoped to org, caller and operation**; a replay re-passes the credential check.
  `server/src/db/jobs/job-store-idempotency.ts`, `server/test-db/job-store.idempotency.test.ts`.
- **An org admin may follow up, retry and control the wait of another member's task**; the row's `created_by` is the
  admin, the run executes as the thread root's `execution_user_id`. `server/src/db/jobs/job-store-actions.ts`,
  `server/test-db/job-store.admin-actions.test.ts`.
- **The restore reads (`checkpoint`, `transcripts`) and an attachment's content are worker routes whose credential is the job's live lease** in the body: a lost, foreign or unknown lease reads nothing, and the file must be in that job's effective set, read fresh each call (a review's lease reads only its own row's set). `server/src/routes/jobs/job-handlers-restore.ts`, `server/src/routes/jobs/job-handlers-attachment-content.ts`, `server/test/auth.enforcement.test.ts`, `server/test/routes.restore.test.ts`, `server/test/routes.attachment-content.test.ts`.
- **The worker credential is one deployment-wide secret**, `JOB_BOARD_TOKEN` (fatal in github mode when missing or
  under 32 characters). `server/src/config.ts`.
- **`POST /api/sessions/branch` demands an org-bound credential in github mode** (the runner's lease pair or a
  `fat_` token); the ingest token does not open it. `server/src/routes/ingest.ts`,
  `server/test/routes.ingest.test.ts`.

## Stated limits

- Membership is not a sandbox: every member sees every repo the installation reports and may queue a command an
  agent runs ([security.md](security.md)).
- Org `member_removed` events fire for organization installations only; a user-account removal is caught one
  sign-in late by the selection sweep.
