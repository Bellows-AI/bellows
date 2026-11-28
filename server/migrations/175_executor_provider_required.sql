-- Every executor has a provider connection (docs/workspace.md): an executor selects the connection its tasks run
-- on, and the only rows without one are those the data step (src/db/executor-provider-migration.ts) suspended
-- because it could not determine their key or provider, each carrying the reason a person reads.
--
-- The check is added NOT VALID: every new write is judged at once, while the legacy rows the step has not reached
-- yet wait for it. The step validates the constraint once no legacy row remains, through the definer function
-- below — the board's pools do not own the table, and the validation needs its owner.
--
-- This file must contain NO `create extension`, per 005's header.
alter table executor_profile add column if not exists provider_migration_reason text;

alter table executor_profile drop constraint if exists executor_profile_provider_required_ck;
alter table executor_profile add constraint executor_profile_provider_required_ck
    check (provider_connection_id is not null or provider_migration_reason is not null) not valid;

-- The schema is fixed at creation (the migrating login's current one), so the definer's search path cannot be
-- redirected by a caller.
do $migration$
begin
    execute format($fn$
        create or replace function bellows_validate_executor_provider_required() returns void
        language sql security definer set search_path = %I, pg_catalog as $body$
            alter table executor_profile validate constraint executor_profile_provider_required_ck
        $body$
    $fn$, current_schema());
end
$migration$;

revoke all on function bellows_validate_executor_provider_required() from public;
grant execute on function bellows_validate_executor_provider_required() to bellows_cross_org;
