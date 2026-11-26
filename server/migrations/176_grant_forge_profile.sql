-- The public profile of the account a forge member grant was made for (docs/connections.md): for GitLab, the `name`,
-- `username`, `commit_email` and `public_email` of `/user`, captured when the member links so the claim can name the
-- commit author from its own database and never calls the forge inside a transaction. NULL for every grant that has
-- none (GitHub's authors come from `app_user`). Expand only (docs/persistence.md): one nullable column, no backfill,
-- nothing to scan under the boot lock. This file must contain NO `create extension`, per 005's header.
alter table integration_grant add column if not exists forge_profile jsonb;
