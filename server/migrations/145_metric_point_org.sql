-- Telemetry bound to the organization (docs/telemetry.md): every point carries the org of the credential that wrote
-- it, and the views and usage reads never mix two organizations' points for one session key. This file must contain
-- NO `create extension`, per 005's header.
--
-- metric_point is the largest table, and the boot applies every pending file in one transaction under the migration
-- lock, so nothing here rewrites or backfills it:
--   * the column has no default: a catalog change, no rewrite;
--   * the key is validated while every row is still null: one sequential read under SHARE ROW EXCLUSIVE (writes wait,
--     reads do not), the foreign-key exception docs/persistence.md states. NOT VALID would be no cheaper, and
--     postgres 17 refuses it on a partitioned table;
--   * the dedupe index is left as it is: a session id has one owner (the ingest routes refuse a session another
--     organization holds), so org_id would add nothing to the key, and rebuilding the index is a full build under a
--     write-blocking lock.
-- Points stored before this file get their org from the board (server/src/telemetry/org-backfill.ts), a block range
-- per transaction from the cursor below, never here. Until then, and for good when no single organization's evidence
-- names the session, a point's org is null and every view and usage read leaves it out.

alter table metric_point add column if not exists org_id text;
alter table metric_point add constraint metric_point_org_id_fkey
    foreign key (org_id) references organization (id) on delete cascade;

-- The one organization a session's evidence names: the board's binding of the session to an execution, or a branch
-- report. Null when none does or when two organizations do.
create or replace function metric_point_org_of(text) returns text
language sql stable as $$
    select min(org_id)
    from (
        select org_id from job_execution_session where session_id = $1
        union
        select org_id from session_branch where session_id = $1 and org_id <> '__unclaimed__'
    ) evidence
    having count(*) = 1
$$;

-- A board still on the previous release, mid-rollout or after a rollback, writes points without an org: give each the
-- org its session is bound to now. The current board always names one, so this never fires for it.
create or replace function metric_point_fill_org() returns trigger
language plpgsql as $$
begin
    new.org_id := metric_point_org_of(new.session_id);
    return new;
end
$$;

drop trigger if exists metric_point_fill_org on metric_point;
create trigger metric_point_fill_org before insert on metric_point
    for each row when (new.org_id is null and new.session_id is not null)
    execute function metric_point_fill_org();

-- The backfill's cursor: the next block of metric_point_default to visit, and when the last one was. One row; a
-- missing row is a backfill not yet started.
create table if not exists metric_point_org_backfill (
    singleton  boolean     primary key default true check (singleton),
    next_block bigint      not null default 0,
    done_at    timestamptz
);
