# Connection revocation

How a member's connections end on the board's own initiative, never the member's (a disconnect is theirs,
[connections.md](connections.md)): the member left the Bellows organization, the provider no longer lets the account
reach the site, or it refused the refresh for good. Revoking disconnects the connection, blanks its stored label,
retires the grant's secret (the recovery pass destroys it) and writes one `connection.revoke` audit row naming the reason.

| Concern | Code | Test |
| --- | --- | --- |
| The one revocation function (`revokeConnectionsInTx`): a member's, a grant's or one connection | `server/src/db/connection-revocation.ts` | `server/test-db/connection-revocation.test.ts` |
| A leaver: `endMemberships` revokes the member's connections in the same transaction | `server/src/auth/member-removal.ts` | `server/test-db/connection-revocation.test.ts` |
| A refused refresh: a provider with `revokesOnRefusal` (Jira) revokes on a definitive `invalid_grant`; others go to `reconnect_required` | `server/src/integrations/grant-lineage.ts` (`revokeRefused`), `server/src/integrations/oauth-provider.ts` | `server/test-db/jira-lineage.test.ts` |
| The re-check cycle (`recheckAccounts`): every replica, behind the `account-recheck` lease, one step per account check | `server/src/integrations/account-recheck.ts`, `server/src/main.ts` | `server/test-db/account-recheck.test.ts` |
| The lease: a named row taken while free or lapsed | `server/src/db/background-lease.ts`, `server/migrations/171_connection_revocation.sql` | `server/test-db/account-recheck.test.ts` |
| Jira's step: `accessible-resources` against each connection's site; `site_checked_at` orders the work | `server/src/integrations/account-recheck.ts` (`recheckSiteAccess`), `server/src/integrations/providers/jira.ts` (`accessibleResources`) | `server/test-db/account-recheck.test.ts`, `server/test/integrations.jira-hooks.test.ts` |
| Stored personal data: a Jira connection keeps the account id and the site host as its label, no email or name | `server/src/integrations/providers/jira.ts` (`discover`), `server/src/integrations/authorization-store.ts` | `server/test-db/connection-revocation.test.ts`, `server/test-db/jira-authorization.test.ts` |

## Invariants

- **A confirmed loss revokes; anything else leaves the connection alone.** Only a well-formed, non-empty `accessible-resources` list without the connection's site, or a definitive `invalid_grant`, revokes. A failed, timed-out, empty or malformed answer, an unreadable secret and an unanswered refresh are retried next cycle. `server/test-db/account-recheck.test.ts`.
- **Revocation runs in the transaction of its cause**, in lock order member rows, grant, connection; org-owned connections are not touched. `server/test-db/connection-revocation.test.ts`.
- **Every replica runs the cycle; the lease lets one at a time.** A holder that dies delays the next cycle by one lease. `server/test-db/account-recheck.test.ts`.
- **Later account checks join `recheckAccounts` and revoke through `revokeConnectionsInTx`**, so they share the lease and the audit row.

## Stated limits

- Atlassian's 3LO apps get no lifecycle event: a lost site is found within an hour and five minutes, or when a refresh is refused. Until then a task using the connection fails at Atlassian.
- The owner finds a revoked connection gone from Settings → Integrations and the audit log; notification channels carry task events only, so nothing is sent.
- The Integrations page shows the site host as the account; the account's own name is not fetched.
