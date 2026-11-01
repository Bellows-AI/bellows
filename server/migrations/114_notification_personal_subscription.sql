-- Notifications: personal subscriptions (BEL-177). A nullable user_id on notification_subscription: org rows keep
-- NULL, a personal row names its owner and is deleted with the user. A personal row matches an event only when the
-- user is the event's actor or its author, and still a member of the org. The author of task.ready / task.blocked /
-- task.question is not stored on the event (102/105/106/107 insert neither column), so the fan-out derives it from
-- the thread root's execution_user_id; no trigger is rewritten. A removed member's rows are kept but stop matching
-- (the membership test), and re-joining resumes them. A NULL actor, author or root user matches no personal row and
-- never drops an org row's match.
-- Expand only (docs/persistence.md: a release only expands). This file must contain NO `create extension`, per
-- 005's header.

alter table notification_subscription
    add column if not exists user_id uuid references app_user (id) on delete cascade;

create index if not exists notification_subscription_user_idx
    on notification_subscription (org_id, user_id) where user_id is not null;

-- 106's predicate verbatim, plus the personal clause.
create or replace function notification_event_fan_out(p_org_id text, p_event_id uuid) returns void as $$
begin
    insert into notification_outbox (org_id, event_id, subscription_id)
    select e.org_id, e.id, s.id
    from notification_event e
    join notification_subscription s
      on s.org_id = e.org_id
     and s.enabled
     and e.kind = any(s.event_kinds)
     and (cardinality(s.repos) = 0 or e.repo = any(s.repos))
     and (cardinality(s.workflows) = 0 or e.workflow = any(s.workflows))
     and (s.user_id is null
          or (exists (select 1 from org_membership m where m.org_id = s.org_id and m.user_id = s.user_id)
              and (s.user_id = e.actor_user_id
                   or s.user_id = coalesce(e.author_user_id,
                          (select r.execution_user_id from job r
                           where r.org_id = e.org_id and r.id = e.root_job_id)))))
    where e.org_id = p_org_id
      and e.id = p_event_id
    on conflict do nothing;
end;
$$ language plpgsql;
