-- Membership re-checked against GitHub (docs/auth.md). The installation's account kind and id say whom to ask:
-- an `Organization` through its memberships API (the App's `members:read`), a `User` account is its own owner.
-- Null on rows no sign-in has refreshed since; such an org gets no verdict, so nothing is revoked from it.
alter table organization add column if not exists account_type text;
alter table organization add column if not exists account_id bigint;

-- When GitHub was last asked about this membership, whatever it answered. A request past the TTL asks again;
-- a stale check alone never refuses.
alter table org_membership add column if not exists checked_at timestamptz;
create index if not exists org_membership_checked_at_idx on org_membership (checked_at nulls first);

-- An admin's removal, which outlives the membership it deleted: sign-in materializes no membership for a
-- blocked (org, user) and the admin bootstrap never promotes one. Deleting the row is the restore.
create table if not exists org_membership_removal (
    org_id     text not null references organization (id) on update cascade on delete cascade,
    user_id    uuid not null references app_user (id) on delete cascade,
    removed_by uuid references app_user (id) on delete set null,
    removed_at timestamptz not null default now(),
    constraint org_membership_removal_pk primary key (org_id, user_id)
);
