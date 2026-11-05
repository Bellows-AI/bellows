-- Notifications: a batch task with a published PR is ready only once the board has nothing left to do on it by
-- itself. Its run's settle no longer emits task.ready: the PR's checks are unread then, and a failing
-- check queues an automatic repair whose own settle would notify again. Instead the PR observation emits it, at
-- commit, when an unstale read of the task's latest attempt and still-bound, unmerged PR waits on a person:
-- `review_required` or `checks_missing` on any stage, or `ready` on a stage the board does not merge (automerge
-- merges a ready PR itself). The task must be succeeded with its gate open and no attention, in a batch that is
-- neither cancelled nor expired, and its head (newest non-review job) succeeded and not done. The id keeps 102's
-- md5(head/'task.ready'), so a head is ready once, however often its PR is re-read. A batch task without a
-- published PR (accepted completion, or a run that opened none) and a plain thread still emit at settle.
-- 106's job function is replaced with one more clause on its task.ready arm; its trigger stands.
-- Expand only (docs/persistence.md: a release only expands). This file must contain NO `create extension`, per
-- 005's header.

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
                        and not exists (
                            select 1 from batch_task t
                            join job_pr bp on bp.org_id = t.org_id and bp.root_job_id = t.root_job_id
                            where t.org_id = j.org_id
                              and t.root_job_id = j.root_job_id
                              and t.completion_kind = 'pr'
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

-- Judged at commit on the committed rows, never on NEW: the row may have been rebound, re-staled or deleted since.
create or replace function batch_pr_observation_notification_event() returns trigger as $$
declare
    v_org text;
    v_id uuid;
begin
    insert into notification_event (org_id, id, kind, job_id, root_job_id, repo, workflow, command, reason, pr_url, occurred_at)
    select h.org_id,
           md5(h.id::text || '/task.ready')::uuid,
           'task.ready',
           h.id,
           h.root_job_id,
           h.repo,
           h.workflow_name,
           h.command,
           null,
           p.pr_url,
           now()
    from batch_pr_observation o
    join batch_task t on t.org_id = o.org_id and t.batch_id = o.batch_id and t.key = o.task_key
    join batch b on b.org_id = t.org_id and b.id = t.batch_id
    join batch_stage s on s.org_id = t.org_id and s.batch_id = t.batch_id and s.key = t.stage_key
    join job_pr p on p.org_id = t.org_id and p.root_job_id = t.root_job_id
                 and p.repo = o.repo and p.pr_number = o.pr_number
    cross join lateral (
        select * from job
        where org_id = t.org_id and root_job_id = t.root_job_id and review_of is null
        order by created_at desc, id desc
        limit 1
    ) h
    where o.org_id = new.org_id
      and o.batch_id = new.batch_id
      and o.task_key = new.task_key
      and not o.stale
      and o.attempt = (select max(a.attempt) from batch_attempt a
                       where a.org_id = o.org_id and a.batch_id = o.batch_id and a.task_key = o.task_key)
      and not exists (select 1 from pr_merge pm
                      where pm.org_id = o.org_id and pm.repo = o.repo and pm.pr_number = o.pr_number)
      and (o.outcome in ('review_required', 'checks_missing')
           or (o.outcome = 'ready' and s.policy is distinct from 'automerge'))
      and t.completion_kind = 'pr'
      and t.execution = 'succeeded'
      and t.gate = 'open'
      and t.attention is null
      and b.cancelled_at is null
      and b.expired_at is null
      and h.status = 'succeeded'
      and h.done_at is null
    on conflict (org_id, id) do nothing
    returning org_id, id into v_org, v_id;
    if found then
        perform notification_event_fan_out(v_org, v_id);
    end if;
    return null;
end;
$$ language plpgsql;

drop trigger if exists batch_pr_observation_notification_event on batch_pr_observation;
create constraint trigger batch_pr_observation_notification_event
    after insert or update of outcome, stale on batch_pr_observation
    deferrable initially deferred
    for each row
    when (new.outcome in ('ready', 'review_required', 'checks_missing') and not new.stale)
    execute function batch_pr_observation_notification_event();
