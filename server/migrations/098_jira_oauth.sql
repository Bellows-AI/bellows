-- Jira Cloud OAuth (BEL-61): what a person asked of an authorization, and the one more way it can end.
-- Expand only (docs/persistence.md): two nullable columns and a wider closed list; no existing writer changes.
--
-- `requested_access` is the consent the person chose at the start (`read` or `write`); `expected_site` is the one
-- site they named, as a lowercase host, or null when every accessible site is wanted. Completion never trusts
-- either for what was GRANTED: that is the token's own scope. `site-mismatch` is a named site the account cannot
-- reach.
--
-- This file must contain NO `create extension`, per 005's header.

alter table integration_authorization
    add column if not exists requested_access text check (requested_access in ('read', 'write')),
    add column if not exists expected_site text;

alter table integration_authorization drop constraint if exists integration_authorization_failure_check;
alter table integration_authorization add constraint integration_authorization_failure_check check (failure in (
    'denied', 'state-mismatch', 'identity-mismatch', 'grant-conflict', 'duplicate-connection',
    'exchange-failed', 'storage-failed', 'busy', 'expired', 'interrupted', 'site-mismatch'
));
