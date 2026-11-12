-- The built-in skills an organization has switched off. A row is one off switch; no row means the built-in is
-- on, so an organization that never touched the switch keeps every built-in. The catalog leaves a switched-off name out
-- of what tasks may select, in `effectiveCatalog` (server/src/skill-catalog.ts).
--
-- Expand only (docs/persistence.md): a new table.

create table if not exists builtin_skill_off (
    org_id text not null references organization (id) on update cascade on delete cascade,
    name text not null,
    switched_by uuid references app_user (id) on delete set null,
    switched_at timestamptz not null default now(),
    primary key (org_id, name)
);
