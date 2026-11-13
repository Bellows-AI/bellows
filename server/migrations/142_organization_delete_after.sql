-- When an organization may be deleted (docs/organizations.md): set by an App uninstall or a GitHub suspension of the
-- installation, which suspends the org and keeps every row; cleared by an unsuspension or the operator's activate.
-- Null for an org nothing scheduled for deletion. Nothing here deletes: the purge is its own explicit step.
alter table organization add column if not exists delete_after timestamptz;
