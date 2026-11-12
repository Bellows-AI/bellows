-- Org and workspace skills: a skill is a named owner-scoped row (`user_id` null is the organization scope,
-- set is that member's workspace) and each content change is an immutable `skill_version`. The bundle bytes live in
-- the object store under `object_key` (`<prefix>_skills/<org>/<sha256>`, one object per org and content); the version
-- row is written only after its object is stored (content-addressed, create-only), in one transaction with the skill row. `current_version_id` is the one
-- new tasks resolve; older versions stay so a pin can still be served. A delete is soft (`deleted_at`) and the sweep
-- removes a deleted skill's versions and objects only after the retention window and only when nothing references them.
--
-- Expand only (docs/persistence.md): new tables. This file must contain NO `create extension`, per 005's header.

create table if not exists skill (
    id uuid primary key default gen_random_uuid(),
    org_id text not null references organization (id) on update cascade on delete cascade,
    user_id uuid references app_user (id) on delete cascade,
    name text not null,
    enabled boolean not null default true,
    current_version_id uuid,
    created_by uuid references app_user (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
);

-- A name is unique per organization and owner among live skills; a workspace skill may share an org skill's name.
create unique index if not exists skill_live_name
    on skill (org_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
    where deleted_at is null;

create index if not exists skill_deleted_at on skill (deleted_at) where deleted_at is not null;

create table if not exists skill_version (
    id uuid primary key default gen_random_uuid(),
    skill_id uuid not null references skill (id) on delete cascade,
    sha256 text not null,
    size_bytes bigint not null check (size_bytes >= 0),
    object_key text not null,
    description text not null,
    created_at timestamptz not null default now(),
    unique (skill_id, sha256)
);

create index if not exists skill_version_object_key on skill_version (object_key);

alter table skill drop constraint if exists skill_current_version_fk;
alter table skill
    add constraint skill_current_version_fk
    foreign key (current_version_id) references skill_version (id) on delete set null;
