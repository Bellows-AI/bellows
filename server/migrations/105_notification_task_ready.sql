-- Notifications: task.ready narrowed to what the board shows as Needs review (BEL-133). A succeeded row is a
-- ready event only when it is the thread's head (no newer row in its thread, so a node whose verdict queued
-- its successor in the same transaction is not), is not a review job (review_of) and is not already done
-- (done_at); an open PR wait does not suppress it, the board counts that thread under Needs review too.
-- The event snapshots the thread's job_pr.pr_url (written earlier in the settle's transaction) for task.ready
-- only. task.blocked is unchanged here. Only the function is replaced; 102's trigger stands and 104's fan-out
-- half is verbatim. Expand only (docs/persistence.md: a release only expands). This file must contain NO
-- `create extension`, per 005's header.

-- The thread's job_pr.pr_url at emission, task.ready only; null otherwise or when the thread has no PR.
alter table notification_event add column if not exists pr_url text;

create or replace function job_notification_event() returns trigger as $$
begin
    with ev as (
        insert into notification_event (org_id, id, kind, job_id, root_job_id, repo, workflow, command, reason, pr_url, occurred_at)
        select j.org_id,
               md5(j.id::text || '/' || e.kind)::uuid,
               e.kind,
               j.id,
               j.root_job_id,
               j.repo,
               j.workflow_name,
               j.command,
               j.failure_kind,
               case when e.kind = 'task.ready' then p.pr_url end,
               coalesce(j.finished_at, now())
        from job j
        cross join lateral (
            select case
                       when j.status = 'succeeded'
                            and j.review_of is null
                            and j.done_at is null
                            and not exists (
                                select 1 from job n
                                where n.org_id = j.org_id
                                  and n.root_job_id = j.root_job_id
                                  and (n.created_at, n.id) > (j.created_at, j.id)
                            )
                           then 'task.ready'
                       when j.status in ('failed', 'dead') then 'task.blocked'
                   end as kind
        ) e
        left join job_pr p on p.org_id = j.org_id and p.root_job_id = j.root_job_id
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
