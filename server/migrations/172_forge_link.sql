-- A person's authorization round trip to a connected GitLab (docs/connections.md): one row per started link, from the
-- authorize URL to its callback. `purpose` is `link` (a member linking their own account) or `activate` (the admin's
-- grant, whose authenticated version check activates the pending connection). The state is stored only as its hash and
-- is consumed once (`consumed_at`), so a replayed callback exchanges nothing; the row names the connection, the person
-- and the org it was started for, and a callback by anyone else finds nothing.
-- Expand only (docs/persistence.md): a new table and nullable columns on forge_connection, no backfill, no scan.
-- This file must contain NO `create extension`, per 005's header.
create table if not exists forge_link (
    org_id text not null,
    id uuid not null default gen_random_uuid(),
    user_id uuid not null references app_user (id) on delete cascade,
    connection_id uuid not null,
    purpose text not null,
    state_hash text not null,
    return_to text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    consumed_at timestamptz,

    primary key (org_id, id),
    constraint forge_link_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint forge_link_connection_fk foreign key (org_id, connection_id)
        references forge_connection (org_id, id) on delete cascade,
    constraint forge_link_purpose_ck check (purpose in ('link', 'activate'))
);

create unique index if not exists forge_link_state on forge_link (state_hash);

alter table forge_link enable row level security;
drop policy if exists org_isolation on forge_link;
create policy org_isolation on forge_link using (org_id = current_setting('app.org_id', true))
    with check (org_id = current_setting('app.org_id', true));

-- What activation learned: the instance version it confirmed, when, and the reason an authenticated check refused it
-- (a version below the minimum). An unreachable or malformed answer records nothing: the connection stays pending.
alter table forge_connection add column if not exists version text;
alter table forge_connection add column if not exists activated_at timestamptz;
alter table forge_connection add column if not exists activation_refusal text;
