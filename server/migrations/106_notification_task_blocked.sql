-- Notifications: task.blocked only when a person must act (BEL-134). A failed or dead job row is a blocked
-- event only when it is the thread's head (no newer row in its thread), is not a review job (review_of), is not
-- already done (done_at), is not bound to a batch (the batch decides its own recovery) and no parked workflow
-- round under an open wait continues it. So a failure whose verdict queued a successor or re-parked into a
-- durable wait emits nothing. The reason carries the failure kind and cause (`gate:verification`), else the status.
-- A batch task emits task.blocked from its durable `attention` (a person must act), judged at commit on the final
-- batch_task row: every attention except a question on a still-running task, on the thread's head job. The batch
-- reason is the attention code plus the head's failure, never batch_task.wait_reason, which lags attention by one
-- reconcile after a merge refusal. A task refused before its thread exists has no head job and emits nothing; an
-- attention cleared again before commit never queues an event (the trigger's WHEN, test: notification-blocked).
-- 104's fan-out moves into notification_event_fan_out(), shared by both triggers; 102's job trigger stands.
-- Expand only (docs/persistence.md: a release only expands). This file must contain NO `create extension`, per
-- 005's header.

-- The enabled subscriptions matching an event at emission get one outbox row each; verbatim 104/105 predicate.
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
    where e.org_id = p_org_id
      and e.id = p_event_id
    on conflict do nothing;
end;
$$ language plpgsql;

create or replace function job_notification_event() returns trigger as $$
declare
    v_org text;
    v_id uuid;
begin
    insert into notification_event (org_id, id, kind, job_id, root_job_id, repo, workflow, command, reason, pr_url, occurred_at)
    select j.org_id,
           md5(j.id::text || '/' || e.kind)::uuid,
           e.kind,
           j.id,
           j.root_job_id,
           j.repo,
           j.workflow_name,
           j.command,
           case when e.kind = 'task.blocked'
                then coalesce(j.failure_kind || coalesce(':' || j.failure_cause, ''), j.status)
           end,
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
                   when j.status in ('failed', 'dead')
                        and j.review_of is null
                        and j.done_at is null
                        and not exists (
                            select 1 from job n
                            where n.org_id = j.org_id
                              and n.root_job_id = j.root_job_id
                              and (n.created_at, n.id) > (j.created_at, j.id)
                        )
                        and not exists (
                            select 1 from batch_task t
                            where t.org_id = j.org_id and t.root_job_id = j.root_job_id
                        )
                        and not exists (
                            select 1 from workflow_round r
                            join workflow_wait w
                              on w.org_id = r.org_id and w.root_job_id = r.root_job_id and w.reason = r.workflow_node
                            where r.org_id = j.org_id
                              and r.root_job_id = j.root_job_id
                              and r.woken_at is null
                              and w.completed_at is null
                              and w.cancelled_at is null
                        )
                       then 'task.blocked'
               end as kind
    ) e
    left join job_pr p on p.org_id = j.org_id and p.root_job_id = j.root_job_id
    where j.org_id = new.org_id
      and j.id = new.id
      and e.kind is not null
    on conflict (org_id, id) do nothing
    returning org_id, id into v_org, v_id;
    if found then
        perform notification_event_fan_out(v_org, v_id);
    end if;
    return null;
end;
$$ language plpgsql;

create or replace function batch_task_notification_event() returns trigger as $$
declare
    v_org text;
    v_id uuid;
begin
    insert into notification_event (org_id, id, kind, job_id, root_job_id, repo, workflow, command, reason, pr_url, occurred_at)
    select t.org_id,
           md5(h.id::text || '/task.blocked')::uuid,
           'task.blocked',
           h.id,
           h.root_job_id,
           h.repo,
           h.workflow_name,
           h.command,
           case
               when t.attention in ('refused', 'closed') or h.status not in ('failed', 'dead') then t.attention
               else t.attention || ':' || coalesce(h.failure_kind || coalesce(':' || h.failure_cause, ''), h.status)
           end,
           null,
           now()
    from batch_task t
    cross join lateral (
        select * from job
        where org_id = t.org_id and root_job_id = t.root_job_id and review_of is null
        order by created_at desc, id desc
        limit 1
    ) h
    where t.org_id = new.org_id
      and t.batch_id = new.batch_id
      and t.key = new.key
      and (t.attention <> 'question' or t.execution = 'failed')
    on conflict (org_id, id) do nothing
    returning org_id, id into v_org, v_id;
    if found then
        perform notification_event_fan_out(v_org, v_id);
    end if;
    return null;
end;
$$ language plpgsql;

drop trigger if exists batch_task_notification_event on batch_task;
create constraint trigger batch_task_notification_event
    after update of attention, execution on batch_task
    deferrable initially deferred
    for each row
    when (new.attention is not null
          and (new.attention is distinct from old.attention or new.execution is distinct from old.execution))
    execute function batch_task_notification_event();
