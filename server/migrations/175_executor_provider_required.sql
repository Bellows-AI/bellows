-- Every executor has a provider connection (docs/workspace.md): an executor selects the connection its tasks run
-- on. The only rows without one are those the data step (src/db/executor-provider-migration.ts) has not reached yet
-- (`provider_migration_pending`, set here on every row that has none) and those it suspended because it could not
-- determine their key or provider, each carrying the reason a person reads (`provider_migration_reason`).
--
-- The check is validated at once, so every later write is judged by it and no row can be left unsatisfiable: a
-- pending row passes whatever else updates it (a suspension, a creator deleted by `on delete set null`), and the
-- step clears the flag as it converts or suspends each row. Only a suspended row may keep a null connection.
--
-- This file must contain NO `create extension`, per 005's header.
alter table executor_profile add column if not exists provider_migration_reason text;
alter table executor_profile add column if not exists provider_migration_pending boolean not null default false;

update executor_profile set provider_migration_pending = true
where provider_connection_id is null and provider_migration_reason is null;

alter table executor_profile drop constraint if exists executor_profile_provider_required_ck;
alter table executor_profile add constraint executor_profile_provider_required_ck
    check (
        provider_connection_id is not null
        or (provider_migration_reason is not null and suspended)
        or provider_migration_pending
    );
