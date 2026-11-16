-- The contract step after 151_row_level_security.sql: the org policy now binds the owner too. 151 only enabled it,
-- so a pod of the release before, running every statement as the owner with no setting, kept serving through the
-- rollout; that release can no longer run, and the owner runs nothing but the migrations, whose seed and reaps take
-- bellows_cross_org (server/src/db/migrate.ts). A superuser or a BYPASSRLS owner is still unbound: PostgreSQL exempts
-- both from every policy. Same set as 151 (every table with an org_id, partitions included); no row is rewritten,
-- and the policies and the enable flags are left as they are.
set local lock_timeout = '5s';

do $$
declare
    t text;
begin
    for t in
        select c.relname
        from pg_class c
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
        where c.relnamespace = current_schema()::regnamespace and c.relkind in ('r', 'p')
        order by c.relname
    loop
        execute format('alter table %I force row level security', t);
    end loop;
end
$$;

set local lock_timeout to default;
