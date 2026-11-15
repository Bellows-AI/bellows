# Linear app runbook — registering the Linear OAuth application

The operator steps that turn on "Connect Linear": one Linear OAuth application per Bellows deployment. Until it is
registered and both variables are set, starting a connection answers 503 `INTEGRATION_NOT_CONFIGURED`
(`server/src/routes/integrations.ts`, `server/src/integrations/providers/linear.ts`, `server/test/routes.integrations.test.ts`).

## 1. Register the app

1. In the Linear workspace that will own the app, open Settings, then API, then OAuth applications, and create a new
   application. Name it after the deployment.
2. Set the callback URL to `<callbackOrigin>/api/integrations/linear/callback`, where `<callbackOrigin>` is the origin
   the board derives from `PUBLIC_URL` (`integrations.callbackOrigin`, `server/src/config.ts`, `docs/configuration.md`)
   — for example `https://factory.example.com/api/integrations/linear/callback`. It must match exactly: Linear
   refuses a mismatch at consent, before the board sees anything.
3. Refresh tokens must be on (Linear has moved OAuth applications to refresh tokens). Without one, the 24-hour access
   token is never renewed and the connection needs reconnecting a day later. The client-credentials token option is
   not used; leave it off. Webhooks are not used either.
4. Copy the Client ID and the Client secret.

Nothing to configure for scopes or actor: the board asks for `read` on connect, `read` and `write` when the member
allows adding comments, with `actor=user`, PKCE and `prompt=consent` on every authorize
(`core/src/integrations/linear.ts` `linearScopesFor`, `server/src/integrations/providers/linear.ts`,
`server/test/integrations.linear-hooks.test.ts`).

## 2. Who can connect

| Deployment | Setting |
| --- | --- |
| Every connecting account is a member of the workspace that owns the app | Leave the app private. |
| Accounts in other Linear workspaces connect | Make the app public in its settings, so other workspaces can authorize it. |

A managed deployment is always the second row. Bellows holds no per-workspace list.

## 3. Configure the board

| Where | Client id | Client secret |
| --- | --- | --- |
| Environment (`.env`, `docker-compose.yml`) | `LINEAR_CLIENT_ID` | `LINEAR_CLIENT_SECRET` |
| Helm chart | `integrations.linear.clientId` | `secret.linearClientSecret` (the Secret key `linear-client-secret`) |

Both or neither: one alone refuses to boot, naming the missing one (`server/src/config-integrations.ts`
`loadLinearOAuth`, `server/test/config.integrations.test.ts`). Restart the board after setting them. The
`LINEAR_AUTHORIZE_URL` and `LINEAR_API_URL` overrides exist for the e2e stub only (`e2e/stub-idp.mjs`); never set them
on a real deployment.

## 4. Check it

1. Sign in, Settings, Integrations, Browse integrations, the Linear card's Connect, Continue to Linear.
2. Pick the workspace and approve the consent. The page returns to Integrations with "Linear connected." and one card
   for that workspace, labelled with its `urlKey`.
3. "Allow adding comments" on a connection's page asks Linear again with `write` added; the row then shows `write`.

`e2e/linear-connections.spec.ts` walks these steps against the stand-in. Refusals come back as one sentence on the
page the consent started from; the codes are `AuthorizationFailure` in `server/src/integrations/authorization-types.ts`.

## Limits

- A Linear token reaches the one workspace chosen at consent (`docs/connections.md`, "Stated limits").
- Inside one Bellows organization a Linear account belongs to the member who connected it; another member is refused
  with `grant-conflict` (`server/src/db/connection-grants.ts`).
- Disconnect makes one bounded revoke call to Linear and destroys Bellows' copy whatever it answers
  (`server/src/integrations/lineage-destroy.ts`); a failed revoke is logged, and the authorization is then removed in
  the Linear workspace's settings.
