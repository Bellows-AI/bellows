-- The connection a forge member grant was made through (docs/gitlab.md): a GitLab grant names the `forge_connection`
-- it was published against, so the write that activates it can lock that row and a removed connection cannot be left
-- with a live grant. NULL for every other grant (GitHub's, Jira's, Linear's). Expand only (docs/persistence.md): a
-- nullable column and a NOT VALID foreign key, which checks new rows and scans nothing; no backfill, nothing to scan
-- under the boot lock. The key is NO ACTION: a connection row is deleted only after its grants are detached.
-- This file must contain NO `create extension`, per 005's header.
alter table integration_grant add column if not exists forge_connection_id uuid;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'integration_grant_forge_connection_fk') then
        alter table integration_grant
            add constraint integration_grant_forge_connection_fk
            foreign key (org_id, forge_connection_id) references forge_connection (org_id, id) not valid;
    end if;
end
$$;
