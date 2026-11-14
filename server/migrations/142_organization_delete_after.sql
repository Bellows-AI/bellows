-- Who holds an organization (docs/organizations.md). `status` stays the effective one every gate reads; it is derived
-- from two sources that never override each other:
--   operator_status — the operator's own decision (active, suspended, refused);
--   delete_after    — GitHub's hold: set by an App uninstall or a GitHub suspension of the installation, which suspends
--                     the org and keeps every row; cleared only by an unsuspension. Nothing here deletes.
-- The org is active only when neither holds it; a refusal outranks a suspension.
alter table organization add column if not exists delete_after timestamptz;
alter table organization add column if not exists operator_status text not null default 'active'
    check (operator_status in ('active', 'suspended', 'refused'));
-- Before this migration only the operator moved a status.
update organization set operator_status = status where operator_status <> status;
