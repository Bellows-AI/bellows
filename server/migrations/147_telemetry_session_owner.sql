-- One owner per telemetry session (docs/telemetry.md). A session no attempt is bound to belongs to the first
-- organization whose credential writes it: the ingest routes insert the row on conflict do nothing and compare,
-- so of two first writers exactly one wins, and a binding (job_execution_session) of a session another org owns is
-- never recorded. The org-less metric_point_dedup index relies on it: one session, one writing org.
--
-- Small, new and empty: nothing here touches metric_point's rows. This file must contain NO `create extension`,
-- per 005's header.

create table if not exists telemetry_session_owner (
    session_id text        primary key,
    org_id     text        not null references organization (id) on delete cascade,
    created_at timestamptz not null default now()
);

-- The owner joins the evidence a point's org is resolved from (145): one organization across all of it, or none.
create or replace function metric_point_org_of(text) returns text
language sql stable as $$
    select min(org_id)
    from (
        select org_id from job_execution_session where session_id = $1
        union
        select org_id from session_branch where session_id = $1 and org_id <> '__unclaimed__'
        union
        select org_id from telemetry_session_owner where session_id = $1
    ) evidence
    having count(*) = 1
$$;

-- Evidence that arrives after a point repairs it: an older board, mid-rollout or after a rollback, stores a point with
-- no org when nothing binds its session yet, and the backfill's cursor may already be past its block. The first
-- binding, branch report or owner row of that session gives its org-less points the one org the evidence names. The
-- update reads by session (metric_point_session), so it is bounded by the session's own points.
create or replace function metric_point_repair_org() returns trigger
language plpgsql as $$
begin
    if metric_point_org_of(new.session_id) = new.org_id then
        update metric_point set org_id = new.org_id
        where session_id = new.session_id and org_id is null;
    end if;
    return null;
end
$$;

drop trigger if exists metric_point_repair_org on job_execution_session;
create trigger metric_point_repair_org after insert on job_execution_session
    for each row execute function metric_point_repair_org();
drop trigger if exists metric_point_repair_org on session_branch;
create trigger metric_point_repair_org after insert on session_branch
    for each row execute function metric_point_repair_org();
drop trigger if exists metric_point_repair_org on telemetry_session_owner;
create trigger metric_point_repair_org after insert on telemetry_session_owner
    for each row execute function metric_point_repair_org();
