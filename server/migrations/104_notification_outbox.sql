-- Notification outbox (BEL-129): one row per (event, subscription) owed a delivery. The job.status trigger
-- (102) fans an event out at emission, inside the settle's own transaction, to the enabled subscriptions that
-- match it at that moment: a re-fired trigger for an existing event id inserts no event and so fans out
-- nothing, and a subscription created later receives nothing. The outbox store (never this file) stamps every
-- time on its injected clock; next_attempt_at NULL means "due now", so no schedule is ever database-stamped.
-- Only the function is replaced; 102's trigger definition stands. Expand only (docs/persistence.md: a release
-- only expands). This file must contain NO `create extension`, per 005's header.

create table if not exists notification_outbox (
    org_id text not null,
    event_id uuid not null,
    subscription_id uuid not null,
    attempts integer not null default 0,
    next_attempt_at timestamptz,
    claim_token uuid,
    claimed_until timestamptz,
    delivered_at timestamptz,
    parked_at timestamptz,
    -- A closed SendResult reason or 'subscription-disabled'; never free text, never a credential.
    last_error text,
    primary key (org_id, event_id, subscription_id),
    foreign key (org_id, event_id) references notification_event (org_id, id) on delete cascade,
    foreign key (org_id, subscription_id) references notification_subscription (org_id, id) on delete cascade
);

create index if not exists notification_outbox_due on notification_outbox (org_id, next_attempt_at)
    where delivered_at is null and parked_at is null;

create or replace function job_notification_event() returns trigger as $$
begin
    with ev as (
        insert into notification_event (org_id, id, kind, job_id, root_job_id, repo, workflow, command, reason, occurred_at)
        select j.org_id,
               md5(j.id::text || '/' || e.kind)::uuid,
               e.kind,
               j.id,
               j.root_job_id,
               j.repo,
               j.workflow_name,
               j.command,
               j.failure_kind,
               coalesce(j.finished_at, now())
        from job j
        cross join lateral (
            select case j.status
                       when 'succeeded' then 'task.ready'
                       when 'failed' then 'task.blocked'
                       when 'dead' then 'task.blocked'
                   end as kind
        ) e
        where j.org_id = new.org_id
          and j.id = new.id
          and e.kind is not null
        on conflict (org_id, id) do nothing
        returning org_id, id, kind, repo, workflow
    )
    insert into notification_outbox (org_id, event_id, subscription_id)
    select ev.org_id, ev.id, s.id
    from ev
    join notification_subscription s
      on s.org_id = ev.org_id
     and s.enabled
     and ev.kind = any(s.event_kinds)
     and (cardinality(s.repos) = 0 or ev.repo = any(s.repos))
     and (cardinality(s.workflows) = 0 or ev.workflow = any(s.workflows))
    on conflict do nothing;
    return null;
end;
$$ language plpgsql;
