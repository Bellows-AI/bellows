-- The organization's audit log (docs/persistence.md): one row per sign-in, token mint or revoke, role change, member
-- removal or restore, env write, connection change and admin action on another member's task, written in the
-- action's own transaction. `actor_id` is the user's id, the org token's id or the operator's, so it is text with no
-- foreign key. `detail` names what changed and never holds a credential value.
create table if not exists audit_event (
    id         uuid primary key default gen_random_uuid(),
    org_id     text not null references organization (id) on update cascade on delete cascade,
    at         timestamptz not null default now(),
    actor_kind text not null check (actor_kind in ('user', 'org_token', 'operator', 'system')),
    actor_id   text,
    action     text not null,
    target     text,
    detail     jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object')
);
create index if not exists audit_event_org_at_idx on audit_event (org_id, at, id);

-- Append-only: an update or delete is refused unless it is the organization's own cascade, which runs after the
-- parent row is gone (a delete), or has moved its id (an update that changes nothing but `org_id`). A row of a live
-- organization is never edited or removed.
create or replace function audit_event_append_only() returns trigger
language plpgsql as $$
begin
    if not exists (select 1 from organization o where o.id = old.org_id) then
        if tg_op = 'DELETE' then
            return old;
        end if;
        if (new.id, new.at, new.actor_kind, new.actor_id, new.action, new.target, new.detail)
            is not distinct from (old.id, old.at, old.actor_kind, old.actor_id, old.action, old.target, old.detail) then
            return new;
        end if;
    end if;
    raise exception 'audit_event % is append-only', old.id
        using errcode = '23514', constraint = 'audit_event_append_only';
end;
$$;

drop trigger if exists audit_event_append_only on audit_event;
create trigger audit_event_append_only
    before update or delete on audit_event
    for each row execute function audit_event_append_only();
