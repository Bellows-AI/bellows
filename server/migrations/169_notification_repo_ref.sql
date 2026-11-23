-- Notifications: an event copies its job's forge, host and path (167 added the columns, default github.com), so a
-- GitLab task's task.ready / blocked / question carry the repository they happened on. The two PR joins in the batch
-- PR observation's task.ready match the whole triple: a GitHub merge of o/n#7 no longer suppresses a GitLab
-- observation of o/n#7. notification_event_fan_out and its subscription `repos` filter stay path-only by design (167).
-- The four trigger functions are replaced with their latest bodies (126, 126, 106, 107), verbatim but for the two
-- columns and the two joins; the triggers stand and call the new bodies. Catalog-only: no table scan, no lock on a
-- table, no index.
-- Expand only (docs/persistence.md: a release only expands). This file must contain NO `create extension`, per
-- 005's header.

create or replace function job_notification_event() returns trigger as $$
declare
    v_org text;
    v_id uuid;
begin
    insert into notification_event (org_id, id, kind, job_id, root_job_id, forge, host, repo, workflow, command, reason, pr_url, occurred_at)
    select j.org_id,
           md5(j.id::text || '/' || e.kind)::uuid,
           e.kind,
           j.id,
           j.root_job_id,
           j.forge,
           j.host,
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

create or replace function batch_pr_observation_notification_event() returns trigger as $$
declare
    v_org text;
    v_id uuid;
begin
    insert into notification_event (org_id, id, kind, job_id, root_job_id, forge, host, repo, workflow, command, reason, pr_url, occurred_at)
    select h.org_id,
           md5(h.id::text || '/task.ready')::uuid,
           'task.ready',
           h.id,
           h.root_job_id,
           h.forge,
           h.host,
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
                 and p.forge = o.forge and p.host = o.host
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
                      where pm.org_id = o.org_id and pm.forge = o.forge and pm.host = o.host
                        and pm.repo = o.repo and pm.pr_number = o.pr_number)
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

create or replace function batch_task_notification_event() returns trigger as $$
declare
    v_org text;
    v_id uuid;
begin
    insert into notification_event (org_id, id, kind, job_id, root_job_id, forge, host, repo, workflow, command, reason, pr_url, occurred_at)
    select t.org_id,
           md5(h.id::text || '/task.blocked')::uuid,
           'task.blocked',
           h.id,
           h.root_job_id,
           h.forge,
           h.host,
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

create or replace function job_question_notification_event() returns trigger as $$
declare
    v_org text;
    v_id uuid;
begin
    insert into notification_event (org_id, id, kind, job_id, root_job_id, forge, host, repo, workflow, command, reason, pr_url,
                                    question_id, questions, occurred_at)
    select j.org_id,
           md5(q.job_id::text || '/' || q.question_id || '/task.question')::uuid,
           'task.question',
           j.id,
           j.root_job_id,
           j.forge,
           j.host,
           j.repo,
           j.workflow_name,
           j.command,
           null,
           null,
           q.question_id,
           array(select t.e->>'question' from jsonb_array_elements(q.questions) with ordinality as t(e, n) order by t.n),
           q.asked_at
    from job_question q
    join job j on j.org_id = q.org_id and j.id = q.job_id
    where q.org_id = new.org_id
      and q.job_id = new.job_id
      and q.question_id = new.question_id
      and q.state = 'pending'
      and j.status = 'running'
      and j.lease_token = q.lease_token
      and j.cancel_requested_at is null
    on conflict (org_id, id) do nothing
    returning org_id, id into v_org, v_id;
    if found then
        perform notification_event_fan_out(v_org, v_id);
    end if;
    return null;
end;
$$ language plpgsql;
