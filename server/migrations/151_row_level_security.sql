-- Row-level security on every org-owned table (docs/row-level-security.md).
--
-- Two roles. bellows_request is what every request runs as: it owns nothing and does not bypass RLS, so the policy
-- below binds it, and a statement without the transaction-local `app.org_id` reads no org row and writes none.
-- bellows_cross_org bypasses RLS: the cross-org pool takes it, and it owns the definer functions a single-org path
-- reads a cross-org count or boolean through. The migrating login (the owner) is granted both, so a pool on its login
-- can take either role at connection start.
--
-- No rewrite and no backfill: enabling RLS and creating a policy change the catalog only. Each statement takes the
-- table's ACCESS EXCLUSIVE lock for that catalog change; the lock timeout below fails the attempt rather than queue
-- requests behind a long reader, and `migrate()` retries it.
set local lock_timeout = '5s';

-- Idempotent, and tolerant of a race with another database's migration on the same cluster (roles are
-- cluster-wide). Where the migrating login may not create roles (a managed database without superuser), the
-- operator creates both first, as docs/row-level-security.md says, and this block only checks them.
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'bellows_request') then
        begin
            create role bellows_request nologin;
        exception
            when duplicate_object or unique_violation then null;
            when insufficient_privilege then
                raise exception 'cannot create role bellows_request: create it first (docs/row-level-security.md)';
        end;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'bellows_cross_org') then
        begin
            create role bellows_cross_org nologin bypassrls;
        exception
            when duplicate_object or unique_violation then null;
            when insufficient_privilege then
                raise exception 'cannot create role bellows_cross_org with BYPASSRLS: create it first (docs/row-level-security.md)';
        end;
    end if;
    if exists (select 1 from pg_roles where rolname = 'bellows_request' and (rolsuper or rolbypassrls)) then
        raise exception 'bellows_request must not be a superuser or bypass row-level security';
    end if;
    if not exists (select 1 from pg_roles where rolname = 'bellows_cross_org' and rolbypassrls) then
        raise exception 'bellows_cross_org must have BYPASSRLS: alter role bellows_cross_org bypassrls';
    end if;
    if not pg_has_role(current_user, 'bellows_request', 'MEMBER') then
        execute format('grant bellows_request to %I', current_user);
    end if;
    if not pg_has_role(current_user, 'bellows_cross_org', 'MEMBER') then
        execute format('grant bellows_cross_org to %I', current_user);
    end if;
end
$$;

-- Privileges in the schema this file runs in: every table and sequence now, and every one the owner creates later
-- (a recreated view included). TRUNCATE, REFERENCES and TRIGGER are the owner's alone. The cross-org role may create
-- in the schema because it owns the definer functions.
do $$
declare
    s text := current_schema();
begin
    execute format('grant usage on schema %I to bellows_request, bellows_cross_org', s);
    execute format('grant create on schema %I to bellows_cross_org', s);
    execute format('grant select, insert, update, delete on all tables in schema %I to bellows_request, bellows_cross_org', s);
    execute format('grant usage, select, update on all sequences in schema %I to bellows_request, bellows_cross_org', s);
    execute format('alter default privileges in schema %I grant select, insert, update, delete on tables to bellows_request, bellows_cross_org', s);
    execute format('alter default privileges in schema %I grant usage, select, update on sequences to bellows_request, bellows_cross_org', s);
end
$$;

-- The policy, on every table with an org_id: the registry (server/src/db/org-tables.ts) is exactly this set, and a
-- partition gets it too so a statement naming the partition is bound as well. FORCE binds the owner as well, unless
-- it bypasses RLS itself.
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
        execute format('alter table %I enable row level security', t);
        execute format('alter table %I force row level security', t);
        execute format(
            'create policy org_isolation on %I using (org_id = current_setting(''app.org_id'', true)) '
            'with check (org_id = current_setting(''app.org_id'', true))',
            t
        );
    end loop;
end
$$;

-- The definer functions: each runs as bellows_cross_org inside the caller's transaction and returns a count, a slot
-- or one boolean per id the caller passed. The organization a session check answers for is the caller's setting,
-- never an argument, so no caller can ask on another organization's behalf.

-- How many rows run across every organization: the global budget's advisory pre-check (fullScope).
create or replace function bellows_global_running() returns integer
language sql stable security definer as $$
    select count(*)::integer from job where status = 'running' and review_of is null
$$;

-- The cluster's occupancy for the metrics scrape: the global count and the busiest org and repo, never which.
create or replace function bellows_admission_occupancy()
returns table (global_running integer, org_max integer, repo_max integer)
language sql stable security definer as $$
    with running as (select org_id, repo from job where status = 'running' and review_of is null)
    select (select count(*) from running)::integer,
           coalesce((select max(n) from (select count(*) n from running group by org_id) o), 0)::integer,
           coalesce((select max(n) from (select count(*) n from running where repo is not null
                                         group by org_id, repo) r), 0)::integer
$$;

-- The global budget's reservation, inside the claim's transaction (job-store-admission.ts `admitInBudget`, global
-- scope): every running row holds a distinct slot in 1..p_limit once the rows that hold none are moved into free
-- ones; a slot is try-locked under the claim's advisory key, then re-read. The only write is the slot column of a
-- running row; the only answer is the slot taken, or null when the budget is full or a row could not be moved.
create or replace function bellows_global_admission_slot(p_limit integer) returns integer
language plpgsql volatile security definer as $$
declare
    pending uuid[];
    tried integer[];
    got integer;
    s integer;
    moved uuid;
begin
    if p_limit is null or p_limit < 1 then
        raise exception 'the global budget must be a positive integer, got %', p_limit;
    end if;
    select coalesce(array_agg(id) filter (where admission_slot_global is null or admission_slot_global > p_limit), '{}'),
           coalesce(array_agg(admission_slot_global) filter (where admission_slot_global <= p_limit), '{}'),
           count(*)
      into pending, tried, s
      from job where status = 'running' and review_of is null;
    if s >= p_limit then
        return null;
    end if;
    for i in 0 .. cardinality(pending) loop
        got := null;
        for candidate in 1 .. p_limit loop
            continue when candidate = any(tried);
            tried := tried || candidate;
            continue when not pg_try_advisory_xact_lock(hashtextextended('admission:global::' || candidate, 0));
            continue when exists (
                select 1 from job
                where status = 'running' and review_of is null and admission_slot_global = candidate
            );
            got := candidate;
            exit;
        end loop;
        if got is null or i = cardinality(pending) then
            return got;
        end if;
        update job set admission_slot_global = got
        where id = (
            select id from job
            where id = pending[i + 1] and status = 'running' and review_of is null
              and (admission_slot_global is null or admission_slot_global > p_limit)
            for update skip locked
        )
        returning id into moved;
        if moved is null then
            return null;
        end if;
    end loop;
    return null;
end
$$;

-- Per session id the stats read passes: whether another organization holds it (an attempt's binding, or a branch
-- report other than the unclaimed one), so its points are counted once (usage-facts.ts `readUsageFacts`).
create or replace function bellows_sessions_foreign(p_ids text[]) returns boolean[]
language plpgsql stable security definer as $$
declare
    org text := nullif(current_setting('app.org_id', true), '');
begin
    if org is null then
        raise exception 'bellows_sessions_foreign needs app.org_id';
    end if;
    return (
        select coalesce(array_agg(
            exists (select 1 from job_execution_session s where s.session_id = u.id and s.org_id <> org)
            or exists (select 1 from session_branch b
                       where b.session_id = u.id and b.org_id not in (org, '__unclaimed__'))
            order by u.ord), '{}')
        from unnest(p_ids) with ordinality as u(id, ord)
    );
end
$$;

-- Per session id ingest writes for p_job (null for a personal claimant): refused when another attempt or another
-- organization's branch report holds it and this attempt does not, or another organization owns it
-- (telemetry/store.ts `claimSessions`).
create or replace function bellows_sessions_refused(p_job uuid, p_ids text[]) returns boolean[]
language plpgsql stable security definer as $$
declare
    org text := nullif(current_setting('app.org_id', true), '');
begin
    if org is null then
        raise exception 'bellows_sessions_refused needs app.org_id';
    end if;
    return (
        select coalesce(array_agg(
            (not exists (select 1 from job_execution_session s
                         where s.session_id = u.id and s.org_id = org and s.job_id = p_job)
             and (exists (select 1 from job_execution_session s
                          where s.session_id = u.id
                            and (s.org_id <> org or (p_job is not null and s.job_id <> p_job)))
                  or exists (select 1 from session_branch b
                             where b.session_id = u.id and b.org_id not in (org, '__unclaimed__'))))
            or exists (select 1 from telemetry_session_owner o where o.session_id = u.id and o.org_id <> org)
            order by u.ord), '{}')
        from unnest(p_ids) with ordinality as u(id, ord)
    );
end
$$;

-- Whether another organization owns a session id: the claim and a session report record no evidence on one
-- (job-store-provenance.ts).
create or replace function bellows_session_owned_elsewhere(p_session text) returns boolean
language plpgsql stable security definer as $$
declare
    org text := nullif(current_setting('app.org_id', true), '');
begin
    if org is null then
        raise exception 'bellows_session_owned_elsewhere needs app.org_id';
    end if;
    return exists (select 1 from telemetry_session_owner o where o.session_id = p_session and o.org_id <> org);
end
$$;

-- Pinned search_path, owned by the bypassing role, executable by the request role alone.
do $$
declare
    f text;
begin
    foreach f in array array[
        'bellows_global_running()',
        'bellows_admission_occupancy()',
        'bellows_global_admission_slot(integer)',
        'bellows_sessions_foreign(text[])',
        'bellows_sessions_refused(uuid, text[])',
        'bellows_session_owned_elsewhere(text)'
    ] loop
        execute format('alter function %s set search_path = pg_catalog, %I, pg_temp', f, current_schema());
        execute format('alter function %s owner to bellows_cross_org', f);
        execute format('revoke all on function %s from public', f);
        execute format('grant execute on function %s to bellows_request', f);
    end loop;
end
$$;

set local lock_timeout to default;
