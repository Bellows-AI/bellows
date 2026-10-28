-- Integration connections (BEL-59): the principal/grant model under managed connections, expand only
-- (docs/persistence.md: a release only expands).
--
-- `integration_grant` is the credential lineage of one external account (one refresh chain, CAS on
-- `version`); a `connector_connection` is a principal's usable resource under it. `connector_connection`
-- is extended in place, never renamed: an old pod keeps inserting, listing and deleting the 054 column set.
-- `job_connection_binding` is the append-only record of which connections a thread's root uses, each frozen
-- at bind time; `job_integration_requirement` is a pre-claim "this task needs a provider it has none of".
-- `job.execution_user_id` is the root's frozen execution identity.
--
-- Rollout bridge, dropped by the contract release that also drops `job.jira_connection_id` and
-- `connector_connection.kind`: three non-rejecting triggers (`*_rollout_094`) let an old pod's insert land in
-- the new model, and `job_execution_user_immutable` pins the frozen identity (no old code writes the column).
--
-- Every column is nullable or defaulted. This file must contain NO `create extension`, per 005's header.

create table if not exists integration_grant (
    id uuid primary key default gen_random_uuid(),
    org_id text not null references organization (id) on update cascade on delete cascade,
    principal_kind text not null check (principal_kind in ('user', 'service')),
    principal_user_id uuid references app_user (id) on delete cascade,
    principal_service_id text,
    provider text not null,
    external_account_id text not null,
    authority jsonb not null default '{}'::jsonb,
    secret_ref text unique,
    secret_version text,
    status text not null default 'active' check (status in ('active', 'reconnect_required', 'revoked')),
    version bigint not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    revoked_at timestamptz,
    constraint integration_grant_principal check (
        (principal_kind = 'user' and principal_user_id is not null and principal_service_id is null)
        or (principal_kind = 'service' and principal_service_id is not null and principal_user_id is null)
    )
);

-- One non-revoked grant per external account, globally: a second org or user cannot hold a second lineage.
create unique index if not exists integration_grant_account_uk
    on integration_grant (provider, external_account_id) where status <> 'revoked';

alter table connector_connection add column if not exists provider text not null default 'jira';
alter table connector_connection add column if not exists credential text not null default 'legacy_api_token'
    check (credential in ('legacy_api_token', 'oauth_grant'));
-- Null with `legacy_api_token` is a legacy org/shared connection.
alter table connector_connection add column if not exists principal_user_id uuid
    references app_user (id) on delete cascade;
alter table connector_connection add column if not exists external_account_id text;
alter table connector_connection add column if not exists grant_id uuid
    references integration_grant (id) on delete restrict;
alter table connector_connection add column if not exists status text not null default 'active'
    check (status in ('active', 'disconnected'));
alter table connector_connection add column if not exists disconnected_at timestamptz;
-- A disconnect scrubs the plaintext token, and an OAuth connection never has one.
alter table connector_connection alter column api_token drop not null;

create unique index if not exists connector_connection_grant_resource_uk
    on connector_connection (grant_id, cloud_id) where status = 'active' and grant_id is not null;
create index if not exists connector_connection_principal on connector_connection (org_id, principal_user_id)
    where status = 'active';

update connector_connection
set principal_user_id = owner_user_id, external_account_id = email
where external_account_id is null;

-- An old pod's insert leaves the new identity columns null: derive them exactly as the backfill above did.
create or replace function connector_connection_identity_rollout_094() returns trigger
language plpgsql as $$
begin
    if new.credential = 'legacy_api_token' then
        if new.principal_user_id is null then
            new.principal_user_id := new.owner_user_id;
        end if;
        if new.external_account_id is null then
            new.external_account_id := new.email;
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists connector_connection_identity_rollout_094 on connector_connection;
create trigger connector_connection_identity_rollout_094 before insert on connector_connection
    for each row execute function connector_connection_identity_rollout_094();

alter table job add column if not exists execution_user_id uuid references app_user (id) on delete set null;
alter table job add column if not exists binding_revision integer not null default 0;

update job set execution_user_id = created_by
where id = root_job_id and execution_user_id is null and created_by is not null;

create table if not exists job_connection_binding (
    id uuid primary key default gen_random_uuid(),
    org_id text not null,
    root_job_id uuid not null,
    revision integer not null,
    connection_id uuid references connector_connection (id) on delete set null,
    provider text not null,
    credential text not null,
    external_account_id text,
    resource text,
    grant_id uuid,
    authority jsonb not null default '{}'::jsonb,
    access text,
    source text not null check (source in ('explicit', 'default', 'follow_up', 'requirement', 'migrated')),
    added_by uuid,
    added_at timestamptz not null default now(),
    constraint job_connection_binding_root_fk foreign key (org_id, root_job_id)
        references job (org_id, id) on delete cascade
);

create unique index if not exists job_connection_binding_connection_uk
    on job_connection_binding (org_id, root_job_id, connection_id);
create index if not exists job_connection_binding_root on job_connection_binding (org_id, root_job_id, revision);

create table if not exists job_integration_requirement (
    id uuid primary key default gen_random_uuid(),
    org_id text not null,
    root_job_id uuid not null,
    provider text not null,
    reason text not null check (reason in ('missing', 'ambiguous')),
    created_at timestamptz not null default now(),
    satisfied_at timestamptz,
    satisfied_revision integer,
    constraint job_integration_requirement_root_fk foreign key (org_id, root_job_id)
        references job (org_id, id) on delete cascade
);

create unique index if not exists job_integration_requirement_open_uk
    on job_integration_requirement (org_id, root_job_id, provider) where satisfied_at is null;

-- Each root that selected a connection gets one migrated binding (revision 1), frozen from its connection.
insert into job_connection_binding
    (org_id, root_job_id, revision, connection_id, provider, credential, external_account_id, resource, grant_id,
     access, source, added_by)
select j.org_id, j.id, 1, c.id, c.provider, c.credential, c.external_account_id, c.cloud_id, c.grant_id,
       c.access, 'migrated', j.created_by
from job j
join connector_connection c on c.id = j.jira_connection_id and c.org_id = j.org_id
where j.id = j.root_job_id
on conflict do nothing;

update job set binding_revision = 1
where id = root_job_id
  and exists (
      select 1 from job_connection_binding b
      where b.org_id = job.org_id and b.root_job_id = job.id and b.source = 'migrated'
  );

-- The frozen execution identity: an old pod never writes the column, so this rejects only new-code bugs.
create or replace function job_execution_user_immutable() returns trigger
language plpgsql as $$
begin
    if new.execution_user_id is distinct from old.execution_user_id then
        raise exception 'job.execution_user_id is immutable once set' using errcode = '23514';
    end if;
    return new;
end;
$$;

drop trigger if exists job_execution_user_immutable on job;
create trigger job_execution_user_immutable before update of execution_user_id on job
    for each row execute function job_execution_user_immutable();

-- An old pod's root insert carries no execution user: the author is the execution identity.
create or replace function job_execution_user_rollout_094() returns trigger
language plpgsql as $$
begin
    if new.id = new.root_job_id and new.execution_user_id is null then
        new.execution_user_id := new.created_by;
    end if;
    return new;
end;
$$;

drop trigger if exists job_execution_user_rollout_094 on job;
create trigger job_execution_user_rollout_094 before insert on job
    for each row execute function job_execution_user_rollout_094();

-- An old pod's root insert names its connection on `jira_connection_id` only: mirror it into a migrated binding.
create or replace function job_binding_mirror_rollout_094() returns trigger
language plpgsql as $$
begin
    if new.id = new.root_job_id and new.jira_connection_id is not null then
        insert into job_connection_binding
            (org_id, root_job_id, revision, connection_id, provider, credential, external_account_id, resource,
             grant_id, access, source, added_by)
        select new.org_id, new.id, new.binding_revision + 1, c.id, c.provider, c.credential, c.external_account_id,
               c.cloud_id, c.grant_id, c.access, 'migrated', new.created_by
        from connector_connection c
        where c.id = new.jira_connection_id and c.org_id = new.org_id
        on conflict do nothing;
        if found then
            update job set binding_revision = new.binding_revision + 1 where org_id = new.org_id and id = new.id;
        end if;
    end if;
    return null;
end;
$$;

drop trigger if exists job_binding_mirror_rollout_094 on job;
create trigger job_binding_mirror_rollout_094 after insert on job
    for each row execute function job_binding_mirror_rollout_094();
