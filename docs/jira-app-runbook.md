# Jira app runbook — registering the Atlassian OAuth app

The operator steps that turn on "Connect Jira": one Atlassian OAuth 2.0 (3LO) app per Bellows deployment. Until it
is registered and both variables are set, starting a connection answers 503 `INTEGRATION_NOT_CONFIGURED`
(`server/src/routes/integrations.ts`, `server/test/routes.integrations.test.ts`).

## 1. Register the app

1. Open the Atlassian developer console (`https://developer.atlassian.com/console/myapps/`) and choose Create, then
   OAuth 2.0 integration. Name it after the deployment.
2. Permissions, then Jira API, then Add, then Configure. Enable the classic scopes `read:jira-work` and
   `read:jira-user`, and `write:jira-work` (adding comments). `offline_access` is not listed there: the board asks
   for it in the authorize request, and it is what yields the refresh token.
3. Authorization, then OAuth 2.0 (3LO), then Add. Set the callback URL to
   `<callbackOrigin>/api/integrations/jira/callback`, where `<callbackOrigin>` is the origin the board derives from
   `PUBLIC_URL` (`integrations.callbackOrigin`, `server/src/config.ts`, `docs/configuration.md`) — for example
   `https://factory.example.com/api/integrations/jira/callback`. It must match exactly: a mismatch is refused by
   Atlassian at consent, before the board sees anything. One callback URL per console app; a second deployment on
   another origin needs its own app.
4. Settings: copy the Client ID and the Secret.

## 2. Distribution

| Deployment | Distribution |
| --- | --- |
| Self-hosted, every connecting account is the app owner's | Leave the app private; only its owner's account can consent. |
| Self-hosted or managed, other people's Atlassian accounts connect | Distribution, then Edit, set Distribution status to Sharing, fill the vendor and privacy-policy fields the console asks for, save. Without it a non-owner's consent screen is refused. |

A managed deployment is always the second row. Sharing is the console's switch; Bellows holds no per-account list.

## 3. Configure the board

| Where | Client id | Client secret |
| --- | --- | --- |
| Environment (`.env`, `docker-compose.yml`) | `ATLASSIAN_CLIENT_ID` | `ATLASSIAN_CLIENT_SECRET` |
| Helm chart | `integrations.jira.clientId` | `secret.atlassianClientSecret` (the Secret key `atlassian-client-secret`) |

Both or neither: one alone refuses to boot, naming the missing one. Restart the board after setting them. The
`ATLASSIAN_AUTHORIZE_URL`, `ATLASSIAN_TOKEN_URL` and `ATLASSIAN_API_URL` overrides exist for the e2e stub only
(`e2e/stub-idp.mjs`); never set them on a real deployment.

## 4. Check it

1. Sign in, Settings, Workspace, Connect Jira, optionally name one site, Continue to Atlassian.
2. Approve the consent. The page returns to Workspace with "Jira connected." and one row per site the account can
   reach (or the one named).
3. "Allow adding comments" on a row asks Atlassian again with `write:jira-work` added; the row then shows `write`.

Refusals come back as one sentence on the same page; the codes are `AuthorizationFailure` in
`server/src/integrations/authorization-types.ts`.

## Limits

- The token reaches every site the account can reach; naming a site narrows what Bellows records, not what the token
  can do (`docs/connections.md`, "Stated limits").
- One Atlassian account connects to one Bellows organization.
- Atlassian has no token revocation endpoint: Disconnect destroys Bellows' copy, and the account's authorization is
  removed in the Atlassian account settings.
