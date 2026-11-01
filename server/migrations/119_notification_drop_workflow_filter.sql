-- Notifications: subscriptions no longer filter by workflow. The fan-out is 114's predicate without the workflow
-- clause, so a row an older build stored with `workflows` set now matches every workflow. The column stays, unread,
-- for one release (docs/persistence.md: a release only expands; the drop waits a release, since an older pod still
-- writes it mid-rollout). This file must contain NO `create extension`, per 005's header.

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
