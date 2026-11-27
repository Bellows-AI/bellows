-- An explicitly configured default executor, scoped and stable. `owner_id` NULL is the
-- organization's default; a member's id is their own. At most one selection per scope, by the same
-- coalesce index shape 047 and 167 use for sibling scopes.
--
-- A selection names its executor by the profile's primary key (org_id, id), never by scope and name:
-- a rename cannot sever it, and a delete cannot leave it dangling. `user_executor_default` (047) is
-- left as it was — a name-keyed preference that stays the legacy fallback when no selection applies.
--
-- The reference is NO ACTION and DEFERRABLE INITIALLY DEFERRED: a deletion of a selected profile is
-- refused at commit (the store names the refusal first), and the personal whole-list save may delete
-- and reinsert a surviving profile under the same id inside one transaction without tripping it.
-- Whether the owner may select the target (an organization default names organization profiles only; a
-- member's names their own or the organization's) is a rule over two rows, enforced by the writer in one
-- transaction and again at resolution, not by a constraint.
--
-- This file must contain NO `create extension`, per 005's header: without them postgres wraps the
-- whole body in an implicit transaction, so a crashed run rolls back whole instead of leaving half
-- a schema behind.
create table if not exists executor_default_selection (
    org_id      text not null,
    id          uuid not null default gen_random_uuid(),
    owner_id    uuid,
    executor_id uuid not null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint executor_default_selection_pk primary key (org_id, id),
    constraint executor_default_selection_org_fk foreign key (org_id)
        references organization (id) on update cascade on delete cascade,
    constraint executor_default_selection_owner_fk foreign key (owner_id)
        references app_user (id) on delete cascade,
    constraint executor_default_selection_executor_fk foreign key (org_id, executor_id)
        references executor_profile (org_id, id) on delete no action deferrable initially deferred
);

create unique index if not exists executor_default_selection_owner_uk on executor_default_selection (
    org_id,
    coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

create index if not exists executor_default_selection_executor_idx
    on executor_default_selection (org_id, executor_id);

-- The policy 151 gave every org table.
alter table executor_default_selection enable row level security;
drop policy if exists org_isolation on executor_default_selection;
create policy org_isolation on executor_default_selection using (org_id = current_setting('app.org_id', true))
    with check (org_id = current_setting('app.org_id', true));
