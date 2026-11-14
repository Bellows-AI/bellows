-- Plan-based retention (docs/retention.md). Expand only: one nullable column on a one-row-per-org table, two new
-- empty tables, and one index on a small table; no existing row is rewritten and nothing is backfilled.
--
--   org_plan.max_retention_days  the days a settled thread is kept, pushed by the commerce service (Enterprise); null
--                                takes PLAN_DEFAULT_MAX_RETENTION_DAYS, and none at all is unlimited.
alter table org_plan add column if not exists max_retention_days integer check (max_retention_days > 0);

-- The window an org's retention pass deletes by, apart from its plan's target: a lower target waits a 30-day notice
-- (pending_days from pending_from), a higher one applies at once. No row, or a null effective_days, is unlimited, so
-- every org that exists when this ships gets the notice before its first deletion. The pass takes its org on this
-- row `for update skip locked`.
create table if not exists org_retention (
    org_id         text primary key references organization (id) on update cascade on delete cascade,
    effective_days integer check (effective_days > 0),
    pending_days   integer check (pending_days > 0),
    pending_from   timestamptz,
    updated_at     timestamptz not null default now(),
    constraint org_retention_pending_ck check ((pending_days is null) = (pending_from is null))
);

-- A thread the pass has fenced for expiry: one row per stamped root (the thread's root and each of its reviews'),
-- grouped by `unit` (`thread:<root>` or `batch:<id>`). While a row is here, follow-up, retry and reopen find the root
-- gone and every object write to its prefix is refused; the row outlives the job rows by a day (`rows_deleted_at`)
-- so a write that read the fence late still finds it shut. `last_error` is a closed code, never tenant data.
create table if not exists thread_expiry (
    org_id          text not null references organization (id) on update cascade on delete cascade,
    root_job_id     uuid not null,
    unit            text not null,
    stamped_at      timestamptz not null default now(),
    rows_deleted_at timestamptz,
    attempts        integer not null default 0,
    last_error      text,
    primary key (org_id, root_job_id)
);
create index if not exists thread_expiry_unit on thread_expiry (org_id, unit);

-- The telemetry step walks an org's sessions by owner: telemetry_session_owner is one row per session, small next to
-- metric_point, whose points are then reached through metric_point_session (session_id, time).
create index if not exists telemetry_session_owner_org on telemetry_session_owner (org_id, created_at);

-- The policy 151 gave every org table, on the two new ones.
alter table org_retention enable row level security;
drop policy if exists org_isolation on org_retention;
create policy org_isolation on org_retention using (org_id = current_setting('app.org_id', true))
    with check (org_id = current_setting('app.org_id', true));
alter table thread_expiry enable row level security;
drop policy if exists org_isolation on thread_expiry;
create policy org_isolation on thread_expiry using (org_id = current_setting('app.org_id', true))
    with check (org_id = current_setting('app.org_id', true));
