# Authentication

Who a caller is, and which credential each route accepts.

| Concern | Code | Test |
| --- | --- | --- |
| Route credentials, chosen from the matched route pattern (`requirementOf`); question reports accept workers, answers require members; a credential lookup the database cannot answer is a 503 | `server/src/auth/plugin.ts` | `server/test/auth.enforcement.test.ts`, `server/test/auth.route-match.test.ts`, `server/test/auth.tokens.test.ts` |
| `AUTH_MODE`, its boot refusals, `AUTH_ALLOW_PUBLIC_BIND` | `server/src/config.ts` | `server/test/config.auth.test.ts` |
| Session cookie: signing, flags, expiry | `server/src/auth/session.ts` | `server/test/auth.session.test.ts` |
| OAuth round trip, state, redirect validation, `/me` (a present bearer is its credential — the CLI's `auth status`) | `server/src/routes/auth.ts`, `auth-shared.ts`, `server/src/auth/github.ts` | `server/test/auth.oauth*.test.ts`, `server/test/auth.github-client.test.ts`, `server/test/auth.tokens.test.ts` |
| Installation-selection screen, pending sign-in, repo scope | `server/src/routes/auth-onboarding.ts` | `server/test/auth.completion.test.ts` |
| Accounts, sessions, memberships, roles (SQL) | `server/src/auth/store.ts`, `server/migrations/010_auth.sql` | `server/test-db/auth-store.test.ts` |
| Personal (`fat_`) and org (`oat_`) access tokens | `server/src/auth/access-token.ts`, `server/src/routes/tokens.ts` | `server/test/auth.tokens.test.ts`, `server/test-db/auth-store.access-tokens.test.ts`, `…lifecycle.test.ts`, `…org.test.ts` |
| Roster reads and role writes | `server/src/routes/org-members.ts` | `server/test/routes.org-members.test.ts` |
| Commerce plan push: `commerce` requirement, bearer `COMMERCE_TOKEN`, enforced in both `AUTH_MODE`s (`enforceCommerce`; [commerce.md](commerce.md)) | `server/src/auth/plugin.ts` | `server/test/auth.enforcement.test.ts`, `server/test/routes.commerce.test.ts` |
| GitHub-side removal, signed webhook | `server/src/routes/webhook.ts` | `server/test/webhook.test.ts` |
| Sign-in in a real browser | `e2e/auth.spec.ts`, `e2e/stub-idp.mjs`, `e2e/signin.ts` | the `auth` Playwright project (`playwright.config.ts`) |

Org scoping: [organizations.md](organizations.md) · App credential: [configuration.md](configuration.md) ·
posture: [security.md](security.md) · routes and codes: [api.md](api.md).

## Invariants

- **Installation access IS membership.** `signIn` upserts one `organization` and `org_membership` per SELECTED
  installation and deletes memberships outside it; no invite, no auto-join. `server/src/auth/store.ts`,
  `server/test-db/auth-store.test.ts`.
- **Every credential's reach is a live `org_membership` join** (`findSession`, `findPersonalToken`,
  `findOrgToken`), so a removed membership ends sessions and both token kinds on the next request.
  `server/test-db/auth-store.access-tokens.test.ts`.
- **An org's first membership lands `admin`**; demoting the last admin is `409 LAST_ADMIN`.
  `server/test/routes.org-members.test.ts`.
- **`github_user_id` is the identity; `github_login` is a label** nothing keys on.
- **Only the sha-256 is stored** (sessions, both token kinds, the pending sign-in row), and the cookie is
  `SameSite=Lax`: the callback is a cross-site top-level GET. `server/src/auth/session.ts`,
  `server/test/auth.session.test.ts`.
- **The credential class is the matched route's, never a re-parse of the URL.** Every worker and connector pattern names its row `:id`. `server/src/auth/plugin.ts`, `server/test/auth.route-match.test.ts`.
- **Three credential kinds, one per request, no fall-through.** A bearer on a session route wins over the
  cookie; a worker token is refused on human routes and vice versa; an `oat_` reaches only `ORG_TOKEN_ROUTES`
  and is `403` off it. `server/src/auth/plugin.ts`, `server/test/auth.enforcement.test.ts`.
- **`AUTH_MODE=none` synthesises a caller rather than skipping the hook**; it refuses a non-loopback `HOST`
  unless `AUTH_ALLOW_PUBLIC_BIND=1`, and `docker-compose.yml` pins `github`. `server/src/config.ts`,
  `server/src/db/migrate.ts` (`LOCAL_LOGIN`), `server/test/config.auth.test.ts`.
- **An idempotency key is scoped to org, caller and operation**, and a replay re-passes the route's credential
  and author check. `server/src/db/jobs/job-store-idempotency.ts`, `server/test-db/job-store.idempotency.test.ts`.
- **The restore reads (`checkpoint`, `transcripts`) are worker routes whose credential is the job's live lease** in
  the body: a lost, foreign or unknown lease reads nothing. `server/src/routes/jobs/job-handlers-restore.ts`,
  `server/test/auth.enforcement.test.ts`, `server/test/routes.restore.test.ts`.
- **The worker credential is one deployment-wide secret**, `JOB_BOARD_TOKEN` (fatal in github mode when missing
  or under 32 characters), so a claim is offered every org's queue. `server/src/config.ts`.
- **`POST /api/sessions/branch` demands an org-bound credential in github mode** (the runner's lease pair or a
  `fat_` token); the ingest token does not open it. `server/src/routes/ingest.ts`,
  `server/test/routes.ingest.test.ts`.

## Stated limits

- Membership is not a sandbox: every member sees every repo the installation reports and may queue a command an
  agent runs ([security.md](security.md)).
- Org `member_removed` events fire for organization installations only; a user-account removal is caught one
  sign-in late by the selection sweep.
